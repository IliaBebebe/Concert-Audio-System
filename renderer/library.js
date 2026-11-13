(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {


// Local playlists, bounded metadata reads and track metadata editing.
class CASLibraryController {
    constructor(app) {
        this.app = app;
        this.playlistRequestId = { A: 0, B: 0 };
        this.refreshRequestId = 0;
        this.durationLoadQueue = [];
        this.metadataLoadQueue = [];
        this.activeDurationLoads = 0;
        this.activeMetadataLoads = 0;
        this.maxDurationLoads = 3;
        this.maxMetadataLoads = 3;
        this.trackDurationTasks = new WeakMap();
        this.trackMetadataTasks = new WeakMap();
        this.trackLoadGeneration = { A: 0, B: 0 };
    }

    toSafeAudioSource(filePath) {
        if (!filePath || typeof filePath !== 'string') return '';
        if (filePath.startsWith('file://') || filePath.startsWith('data:') || filePath.startsWith('blob:')) {
            return filePath;
        }
        const normalized = filePath.replace(/\\/g, '/');
        const pathPart = normalized.startsWith('/') ? normalized : '/' + normalized;
        return encodeURI('file://' + pathPart).replace(/#/g, '%23').replace(/\?/g, '%3F');
    }

    getAudioFormat(filePath) {
        if (!filePath || typeof filePath !== 'string') return undefined;
        const match = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(filePath);
        return match ? [match[1].toLowerCase()] : undefined;
    }

    getTrackTitle(track) {
        return track?.title || track?.name || 'Без названия';
    }

    getTrackArtist(track) {
        return track?.artist || 'Неизвестный исполнитель';
    }

    getTrackDisplayNumber(track, index) {
        return index + 1;
    }

    getTrackDisplayName(track, index) {
        return `${this.app.getTrackDisplayNumber(track, index)}. ${this.app.getTrackTitle(track)}`;
    }

    getTrackStartOffset(track) {
        const startOffset = Number(track?.startOffset ?? track?.metadataOverride?.startOffset);
        return Number.isFinite(startOffset) && startOffset > 0 ? startOffset : 0;
    }

    formatTrackStartOffset(seconds) {
        const roundedTenths = Math.max(0, Math.round((Number(seconds) || 0) * 10));
        const wholeSeconds = Math.floor(roundedTenths / 10);
        const hours = Math.floor(wholeSeconds / 3600);
        const minutes = Math.floor((wholeSeconds % 3600) / 60);
        const remainingSeconds = wholeSeconds % 60;
        const fraction = roundedTenths % 10;
        const secondsText = `${String(remainingSeconds).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`;

        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
            : `${minutes}:${secondsText}`;
    }

    parseTrackStartOffset(value) {
        const rawValue = String(value ?? '').trim().replace(',', '.');
        if (!rawValue) return 0;

        const parts = rawValue.split(':');
        if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
            throw new Error('Укажите время в формате 1:23, 0:45.5 или в секундах');
        }
        if (parts.length > 1 && parts.slice(0, -1).some((part) => !/^\d+$/.test(part))) {
            throw new Error('Дробную часть можно указывать только в секундах');
        }

        const values = parts.map(Number);
        let seconds;
        if (values.length === 1) {
            seconds = values[0];
        } else if (values.length === 2) {
            if (values[1] >= 60) throw new Error('Количество секунд должно быть меньше 60');
            seconds = values[0] * 60 + values[1];
        } else {
            if (values[1] >= 60 || values[2] >= 60) {
                throw new Error('Минуты и секунды должны быть меньше 60');
            }
            seconds = values[0] * 3600 + values[1] * 60 + values[2];
        }

        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 12 * 60 * 60) {
            throw new Error('Точка старта должна быть от 0 до 12 часов');
        }
        return Math.round(seconds * 1000) / 1000;
    }

    isTrackMetadataOverridden(track, field) {
        return Boolean(track?.metadataOverride && Object.prototype.hasOwnProperty.call(track.metadataOverride, field));
    }

    async changeMusicFolder() {
        try {
            this.app.updateStatus('Изменение папки с музыкой...');
            const result = await window.electronAPI.selectMusicFolder();

            if (result.success) {
                const saveResult = await window.electronAPI.setMusicFolder(result.path);

                if (saveResult.success) {
                    await this.app.loadConfig();
                    this.app.resetPlaylistState();
                    this.app.updateStatus(`Папка изменена: ${result.path}`);
                    await this.app.refreshPlaylists();
                } else {
                    throw new Error('Ошибка сохранения настроек');
                }
            } else {
                this.app.updateStatus('Папка не выбрана');
            }
        } catch (error) {
            this.app.updateStatus('Ошибка изменения папки');
        }
    }

    async refreshPlaylists() {
        const requestId = ++this.refreshRequestId;
        const musicFolder = this.app.config?.musicFolder;
        try {
            this.app.updateStatus('Загрузка плейлистов...');
            const result = await window.electronAPI.readDirectory();
            if (requestId !== this.refreshRequestId || musicFolder !== this.app.config?.musicFolder) return;

            if (result.success) {
                if (result.data.length === 0) {
                    this.app.displayNoPlaylists();
                } else {
                    this.app.displayPlaylists(result.data);
                    this.app.updateStatus(`Найдено плейлистов: ${result.data.length}`);
                }
            } else {
                this.app.displayPlaylistError(result.error);
            }
        } catch (error) {
            if (requestId !== this.refreshRequestId || musicFolder !== this.app.config?.musicFolder) return;
            this.app.displayPlaylistError(error.message);
        }
    }

    displayNoPlaylists() {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.app.config.musicFolder ? this.app.config.musicFolder.split(/[\\/]/).pop() : 'папке';

        container.replaceChildren();
        const wrapper = document.createElement('div');
        wrapper.className = 'no-playlists';
        wrapper.innerHTML = `
            <p><i class="fas fa-music"></i> Плейлисты не найдены</p>
            <p class="hint"></p>
            <p class="hint">Создайте подпапки с музыкой или выберите другую папку</p>
            <button class="action-btn" id="openMusicFolderBtn"><i class="fas fa-folder-open"></i> Открыть папку с музыкой</button>
            <button class="action-btn" id="changeFolderBtn"><i class="fas fa-folder-open"></i> Изменить папку с музыкой</button>
        `;
        wrapper.querySelector('.hint').textContent = `В ${folderName} нет плейлистов (подпапок с музыкой)`;
        container.appendChild(wrapper);

        document.getElementById('changeFolderBtn').addEventListener('click', () => this.app.changeMusicFolder());
        document.getElementById('openMusicFolderBtn').addEventListener('click', () => this.app.openMusicFolder());
        this.app.updateStatus('Плейлисты не найдены в текущей папке');
    }

    displayPlaylistError(error) {
        const container = document.getElementById('playlistsContainer');
        container.replaceChildren();
        const wrapper = document.createElement('div');
        wrapper.className = 'playlist-error';
        wrapper.innerHTML = `
            <p><i class="fas fa-exclamation-triangle"></i> Ошибка загрузки плейлистов</p>
            <p class="error-detail"></p>
            <button class="action-btn" id="retryBtn"><i class="fas fa-redo"></i> Повторить</button>
            <button class="action-btn" id="openMusicFolderBtn"><i class="fas fa-folder-open"></i> Открыть папку с музыкой</button>
            <button class="action-btn" id="changeFolderBtn2"><i class="fas fa-folder-open"></i> Изменить папку</button>
        `;
        wrapper.querySelector('.error-detail').textContent = error || 'Неизвестная ошибка';
        container.appendChild(wrapper);

        document.getElementById('retryBtn').addEventListener('click', () => this.app.refreshPlaylists());
        document.getElementById('openMusicFolderBtn').addEventListener('click', () => this.app.openMusicFolder());
        document.getElementById('changeFolderBtn2').addEventListener('click', () => this.app.changeMusicFolder());
        this.app.updateStatus(error ? `Ошибка: ${error}` : 'Ошибка загрузки плейлистов');
    }

    displayPlaylists(playlists) {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.app.config.musicFolder ? this.app.config.musicFolder.split(/[\\/]/).pop() : 'Неизвестная папка';

        container.replaceChildren();
        const currentFolder = document.createElement('div');
        currentFolder.className = 'current-folder';
        const folderPath = document.createElement('span');
        folderPath.className = 'folder-path';
        const folderIcon = document.createElement('i');
        folderIcon.className = 'fas fa-folder';
        folderPath.append(folderIcon, ` ${folderName}`);
        const openButton = document.createElement('button');
        openButton.className = 'folder-open-btn';
        openButton.id = 'openMusicFolderSmall';
        openButton.title = 'Открыть папку с музыкой в Проводнике';
        openButton.setAttribute('aria-label', 'Открыть папку с музыкой в Проводнике');
        openButton.innerHTML = '<i class="fas fa-folder-open"></i>';
        const changeButton = document.createElement('button');
        changeButton.className = 'folder-change-btn';
        changeButton.id = 'changeMusicFolderSmall';
        changeButton.setAttribute('aria-label', 'Изменить папку с музыкой');
        changeButton.innerHTML = '<i class="fas fa-edit"></i>';
        currentFolder.append(folderPath, openButton, changeButton);
        container.appendChild(currentFolder);

        playlists.forEach(playlist => {
            const btn = document.createElement('button');
            btn.className = 'playlist-btn';
            btn.dataset.playlistPath = playlist.path;
            btn.classList.toggle('active', playlist.path === this.app.currentPlaylist?.path);
            const icon = document.createElement('i');
            icon.className = 'fas fa-list';
            const name = document.createElement('span');
            name.className = 'playlist-title';
            name.textContent = playlist.name;
            const count = document.createElement('small');
            count.className = 'playlist-track-count';
            count.textContent = `${playlist.trackCount} треков`;
            btn.append(icon, name, count);
            btn.addEventListener('click', () => this.app.loadPlaylist(playlist));
            container.appendChild(btn);
        });

        document.getElementById('openMusicFolderSmall').addEventListener('click', () => this.app.openMusicFolder());
        document.getElementById('changeMusicFolderSmall').addEventListener('click', () => this.app.changeMusicFolder());
    }

    async loadPlaylist(playlist, explicitDeck = null) {
        const targetDeck = explicitDeck || this.app.activeDeck;
        if (!this.app.decks[targetDeck] || !playlist?.path) return;
        const currentReq = (this.playlistRequestId && this.playlistRequestId[targetDeck] !== undefined)
            ? ++this.playlistRequestId[targetDeck]
            : 0;
        try {
            this.app.updateStatus(`Загрузка в деку ${targetDeck}: ${playlist.name}`);
            const result = await window.electronAPI.getPlaylistTracks(playlist.path);
            if (this.playlistRequestId && this.playlistRequestId[targetDeck] !== currentReq) return;

            if (result.success) {
                if (this.app.playingDeck === targetDeck) {
                    this.app.stopMusic({ silent: true });
                }

                if (this.trackLoadGeneration && this.trackLoadGeneration[targetDeck] !== undefined) {
                    this.trackLoadGeneration[targetDeck]++;
                }
                const deck = this.app.decks[targetDeck];
                deck.playlist = playlist;
                deck.tracks = result.data;
                deck.customQueue = false;
                deck.currentTrackIndex = 0;
                deck.filterQuery = '';

                const searchInput = document.getElementById(targetDeck === 'A' ? 'trackSearchInputA' : 'trackSearchInputB');
                if (searchInput) searchInput.value = '';

                this.app.displayTracks(targetDeck);
                this.app.updateDeckUI();
                this.app.updateTrackCounter();
                this.app.updateStatus(`Плейлист загружен в деку ${targetDeck}: ${playlist.name}`, 'success');

                if (!this.app.isPlaying && !this.app.playingDeck && this.app.activeDeck === targetDeck && deck.tracks.length > 0) {
                    this.app.loadTrack(0, { deckId: targetDeck });
                }
                this.app.saveStoredData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            if (this.playlistRequestId && this.playlistRequestId[targetDeck] !== currentReq) return;
            this.app.updateStatus('Ошибка загрузки плейлиста', 'error');
        }
    }

    async openMusicFolder() {
        try {
            const result = await window.electronAPI.openMusicFolder();
            if (!result?.success) {
                throw new Error(result?.error || 'Не удалось открыть папку с музыкой');
            }
            this.app.updateStatus('Папка с музыкой открыта');
        } catch (error) {
            this.app.updateStatus('Не удалось открыть папку с музыкой', 'error');
        }
    }

    updatePlaylistSelection() {
        const pathA = this.app.decks.A.playlist?.path;
        const pathB = this.app.decks.B.playlist?.path;
        const currentActivePath = this.app.decks[this.app.activeDeck].playlist?.path;

        document.querySelectorAll('.playlist-btn').forEach((button) => {
            const btnPath = button.dataset.playlistPath;
            button.classList.toggle('active', btnPath === currentActivePath);

            let deckBadge = button.querySelector('.playlist-deck-badge');
            const isDeckA = btnPath === pathA;
            const isDeckB = btnPath === pathB;
            const trackCountEl = button.querySelector('small, .playlist-track-count');

            const placeBadgeBeforeCount = (badge) => {
                if (trackCountEl) {
                    if (badge.nextSibling !== trackCountEl) {
                        button.insertBefore(badge, trackCountEl);
                    }
                } else if (!badge.parentElement) {
                    button.appendChild(badge);
                }
            };

            if (isDeckA && isDeckB) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge';
                }
                deckBadge.textContent = 'A+B';
                deckBadge.className = 'playlist-deck-badge';
                placeBadgeBeforeCount(deckBadge);
            } else if (isDeckA) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge';
                }
                deckBadge.textContent = 'A';
                deckBadge.className = 'playlist-deck-badge';
                placeBadgeBeforeCount(deckBadge);
            } else if (isDeckB) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge deck-b';
                }
                deckBadge.textContent = 'B';
                deckBadge.className = 'playlist-deck-badge deck-b';
                placeBadgeBeforeCount(deckBadge);
            } else if (deckBadge) {
                deckBadge.remove();
            }
        });
    }

    resetPlaylistState() {
        if (this.playlistRequestId) {
            this.playlistRequestId.A = (this.playlistRequestId.A || 0) + 1;
            this.playlistRequestId.B = (this.playlistRequestId.B || 0) + 1;
        }
        this.refreshRequestId++;
        this.app.stopMusic({ silent: true });
        if (this.trackLoadGeneration) {
            this.trackLoadGeneration.A = (this.trackLoadGeneration.A || 0) + 1;
            this.trackLoadGeneration.B = (this.trackLoadGeneration.B || 0) + 1;
        }
        this.app.deckManager.reset();
        this.app.decks = this.app.deckManager.decks;
        this.app.currentPlaylist = null;
        this.app.playlistTracks = [];
        this.app.currentTrackIndex = 0;
        this.app.trackFilterQuery = '';

        const searchInputA = document.getElementById('trackSearchInputA');
        const searchInputB = document.getElementById('trackSearchInputB');
        if (searchInputA) searchInputA.value = '';
        if (searchInputB) searchInputB.value = '';

        const currentTrack = document.getElementById('currentTrack');
        if (currentTrack) {
            currentTrack.textContent = 'Трек не выбран';
            currentTrack.title = '';
        }
        this.app.displayTracks();
        this.app.updateDeckUI();
        this.app.updateTrackCounter();
        this.app.clearWaveform('Осциллограмма появится после выбора трека');
    }

    renderTrackArtist(element, track) {
        if (!element) return;
        element.textContent = this.app.getTrackArtist(track);
        if (track.metadataOverride && Object.keys(track.metadataOverride).length > 0) {
            const editedBadge = document.createElement('span');
            editedBadge.className = 'track-edited-badge';
            editedBadge.textContent = 'ручн.';
            element.appendChild(editedBadge);
        }
    }

    renderTrackStartBadge(element, track) {
        if (!element) return;
        element.querySelector('.track-start-badge')?.remove();
        const startOffset = this.app.getTrackStartOffset(track);
        if (startOffset > 0) {
            const startBadge = document.createElement('span');
            startBadge.className = 'track-start-badge';
            startBadge.textContent = `старт ${this.app.formatTrackStartOffset(startOffset)}`;
            startBadge.title = `Воспроизведение с ${this.app.formatTrackStartOffset(startOffset)}`;
            element.appendChild(startBadge);
        }
    }

    updateTrackRowDetails(track) {
        ['A', 'B'].forEach((deckId) => {
            const deck = this.app.decks[deckId];
            if (!deck || !Array.isArray(deck.tracks)) return;
            deck.tracks.forEach((matchedTrack, index) => {
                if (matchedTrack !== track && (!matchedTrack?.path || matchedTrack.path !== track?.path)) return;
                if (matchedTrack !== track) {
                    matchedTrack.title = track.title;
                    matchedTrack.artist = track.artist;
                    matchedTrack.trackNumber = track.trackNumber;
                    matchedTrack.startOffset = track.startOffset;
                    matchedTrack.metadataOverride = track.metadataOverride;
                    matchedTrack.duration = track.duration;
                    matchedTrack.durationUnavailable = track.durationUnavailable;
                }

                const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
                const row = document.querySelector(`#${containerId} .track-row[data-index="${index}"]`);
                if (!row) return;

                const nameElement = row.querySelector('.track-name');
                const artistElement = row.querySelector('.track-artist');
                const durationElement = row.querySelector('.track-duration');
                const numText = row.querySelector('.track-num-text');
                if (numText) {
                    numText.textContent = String(matchedTrack.trackNumber || (index + 1));
                }
                if (nameElement) {
                    const updatedTitle = this.app.getTrackTitle(matchedTrack);
                    nameElement.textContent = updatedTitle;
                    nameElement.title = updatedTitle;
                }
                this.app.renderTrackStartBadge(row.querySelector('.track-title-cell'), matchedTrack);
                this.app.renderTrackArtist(artistElement, matchedTrack);
                if (artistElement && artistElement.textContent) {
                    artistElement.title = artistElement.textContent;
                }
                if (durationElement) {
                    durationElement.textContent = matchedTrack.duration
                        ? this.app.formatTime(matchedTrack.duration)
                        : (matchedTrack.durationUnavailable ? 'N/A' : '--:--');
                }
                if (this.app.playingDeck === deckId && deck.currentTrackIndex === index) {
                    this.app.updateCurrentTrackDisplay(matchedTrack);
                }
            });
        });
    }

    enqueueDurationLoad(track, deckId = null) {
        return new Promise((resolve) => {
            const targetDeck = deckId || this.app.activeDeck;
            const currentGen = (this.trackLoadGeneration && this.trackLoadGeneration[targetDeck] !== undefined)
                ? this.trackLoadGeneration[targetDeck]
                : 0;
            this.durationLoadQueue.push({ track, resolve, deckId: targetDeck, generation: currentGen });
            this.app.processDurationLoadQueue();
        });
    }

    processDurationLoadQueue() {
        while (this.activeDurationLoads < this.maxDurationLoads && this.durationLoadQueue.length > 0) {
            const { track, resolve, deckId, generation } = this.durationLoadQueue.shift();
            const currentGen = (this.trackLoadGeneration && this.trackLoadGeneration[deckId] !== undefined)
                ? this.trackLoadGeneration[deckId]
                : 0;
            if (generation !== currentGen) {
                resolve(null);
                continue;
            }
            this.activeDurationLoads++;
            this.app.readTrackDuration(track)
                .then(resolve, () => resolve(null))
                .finally(() => {
                    this.activeDurationLoads--;
                    this.app.processDurationLoadQueue();
                });
        }
    }

    readTrackDuration(track) {
        return new Promise((resolve) => {
            let tempSound = null;
            let settled = false;
            const timeoutId = setTimeout(() => finish(), 15000);
            const finish = (duration = null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                try { tempSound?.unload(); } catch {}
                resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
            };

            try {
                tempSound = new Howl({
                    src: [this.app.toSafeAudioSource(track.path)],
                    format: this.app.getAudioFormat(track.path),
                    html5: true,
                    volume: 0,
                    onload: () => finish(tempSound?.duration()),
                    onloaderror: () => finish()
                });
            } catch {
                finish();
            }
        });
    }

    loadTrackDuration(track, durationElement, deckId = null) {
        let task = this.trackDurationTasks.get(track);
        if (!task) {
            task = this.app.enqueueDurationLoad(track, deckId).then((duration) => {
                if (duration) {
                    track.duration = duration;
                    delete track.durationUnavailable;
                } else {
                    track.durationUnavailable = true;
                }
                this.app.updateTrackRowDetails(track);
                return duration;
            });
            this.trackDurationTasks.set(track, task);
        }

        return task.then((duration) => {
            if (durationElement?.isConnected) {
                durationElement.textContent = duration ? this.app.formatTime(duration) : 'N/A';
            }
            return duration;
        });
    }

    enqueueMetadataLoad(track, deckId = null) {
        return new Promise((resolve) => {
            const targetDeck = deckId || this.app.activeDeck;
            const currentGen = (this.trackLoadGeneration && this.trackLoadGeneration[targetDeck] !== undefined)
                ? this.trackLoadGeneration[targetDeck]
                : 0;
            this.metadataLoadQueue.push({ track, resolve, deckId: targetDeck, generation: currentGen });
            this.app.processMetadataLoadQueue();
        });
    }

    processMetadataLoadQueue() {
        while (this.activeMetadataLoads < this.maxMetadataLoads && this.metadataLoadQueue.length > 0) {
            const { track, resolve, deckId, generation } = this.metadataLoadQueue.shift();
            const currentGen = (this.trackLoadGeneration && this.trackLoadGeneration[deckId] !== undefined)
                ? this.trackLoadGeneration[deckId]
                : 0;
            if (generation !== currentGen) {
                resolve(null);
                continue;
            }
            this.activeMetadataLoads++;
            let timeoutId = null;
            const request = Promise.resolve()
                .then(() => window.electronAPI.getAudioMetadata(track.path))
                .catch(() => null);
            const timeout = new Promise((resolveTimeout) => {
                timeoutId = setTimeout(() => resolveTimeout(null), 15000);
            });
            Promise.race([request, timeout])
                .then(resolve, () => resolve(null))
                .finally(() => {
                    clearTimeout(timeoutId);
                    this.activeMetadataLoads--;
                    this.app.processMetadataLoadQueue();
                });
        }
    }

    applyTrackMetadata(track, result) {
        const defaultArtist = 'Неизвестный исполнитель';
        if (result?.success && result.data) {
            const artist = result.data.artist
                ? (Array.isArray(result.data.artist) ? result.data.artist.join(', ') : result.data.artist)
                : defaultArtist;

            if (!this.app.isTrackMetadataOverridden(track, 'artist')) track.artist = artist;
            if (result.data.title && !this.app.isTrackMetadataOverridden(track, 'title')) track.title = result.data.title;
            if (result.data.trackNumber && !this.app.isTrackMetadataOverridden(track, 'trackNumber')) {
                track.trackNumber = result.data.trackNumber;
            }
        } else if (!this.app.isTrackMetadataOverridden(track, 'artist')) {
            track.artist = defaultArtist;
        }
    }

    loadTrackMetadata(track, elements = {}, deckId = null) {
        let task = this.trackMetadataTasks.get(track);
        if (!task) {
            task = this.app.enqueueMetadataLoad(track, deckId).then((result) => {
                track.metadataLoaded = true;
                this.app.applyTrackMetadata(track, result);
                this.app.updateTrackRowDetails(track);
                return result;
            });
            this.trackMetadataTasks.set(track, task);
        }

        return task.then((result) => {
            if (elements.nameElement?.isConnected) {
                const updatedTitle = this.app.getTrackTitle(track);
                elements.nameElement.textContent = updatedTitle;
                elements.nameElement.title = updatedTitle;
            }
            if (elements.artistElement?.isConnected) this.app.renderTrackArtist(elements.artistElement, track);
            if (this.app.playlistTracks[this.app.currentTrackIndex] === track) {
                this.app.updateCurrentTrackDisplay(track);
            }
            return result;
        });
    }

    openTrackMetadataEditor(deckIdOrIndex, maybeIndex) {
        let deckId = this.app.activeDeck;
        let index = deckIdOrIndex;
        if (typeof deckIdOrIndex === 'string') {
            deckId = deckIdOrIndex;
            index = maybeIndex;
        }

        const deck = this.app.decks[deckId];
        const track = deck?.tracks[index];
        if (!track) return;

        const existing = document.querySelector('.metadata-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'metadata-modal-overlay';
        overlay.innerHTML = `
            <form class="metadata-modal" aria-label="Редактирование метаданных трека" role="dialog" aria-modal="true">
                <div class="metadata-modal-header">
                    <div>
                        <span class="metadata-modal-kicker">Параметры трека</span>
                        <h3>Редактирование</h3>
                    </div>
                    <button type="button" class="metadata-close-btn" aria-label="Закрыть"><i class="fas fa-times"></i></button>
                </div>
                <label class="metadata-field">
                    <span>Название</span>
                    <input type="text" name="title" autocomplete="off">
                </label>
                <label class="metadata-field">
                    <span>Исполнитель</span>
                    <input type="text" name="artist" autocomplete="off">
                </label>
                <label class="metadata-field metadata-field-small">
                    <span>Номер</span>
                    <input type="number" name="trackNumber" min="1" step="1">
                </label>
                <label class="metadata-field metadata-field-small">
                    <span>Старт с позиции</span>
                    <input type="text" name="startOffset" placeholder="0:00" inputmode="decimal" autocomplete="off" aria-describedby="startOffsetHint">
                    <small class="metadata-field-hint" id="startOffsetHint">0:00 — с начала; например, 1:23</small>
                </label>
                <div class="metadata-source-name"></div>
                <div class="metadata-actions">
                    <button type="button" class="metadata-secondary-btn" data-action="reset">Сбросить</button>
                    <button type="submit" class="metadata-primary-btn">Сохранить</button>
                </div>
            </form>
        `;

        const form = overlay.querySelector('form');
        const titleInput = overlay.querySelector('input[name="title"]');
        const artistInput = overlay.querySelector('input[name="artist"]');
        const numberInput = overlay.querySelector('input[name="trackNumber"]');
        const startOffsetInput = overlay.querySelector('input[name="startOffset"]');
        const sourceName = overlay.querySelector('.metadata-source-name');
        let isSubmitting = false;
        const close = this.app.setupDialogKeyboard(overlay, () => !isSubmitting);
        const setSubmitting = (value) => {
            isSubmitting = value;
            form.querySelectorAll('input, button').forEach((element) => {
                element.disabled = value;
            });
        };

        titleInput.value = this.app.getTrackTitle(track);
        artistInput.value = track.artist && track.artist !== 'Неизвестный исполнитель' ? track.artist : '';
        numberInput.value = track.trackNumber || index + 1;
        startOffsetInput.value = this.app.formatTrackStartOffset(this.app.getTrackStartOffset(track));
        sourceName.textContent = track.filename || track.name || '';

        overlay.querySelector('.metadata-close-btn').addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('[data-action="reset"]').addEventListener('click', async () => {
            if (isSubmitting) return;
            setSubmitting(true);
            try {
                const currentIndex = deck.tracks.indexOf(track);
                if (currentIndex < 0) {
                    this.app.updateStatus('Плейлист изменился. Откройте параметры трека заново', 'warning');
                    return;
                }
                if (await this.app.clearTrackMetadata(deckId, currentIndex)) {
                    setSubmitting(false);
                    close();
                }
            } finally {
                setSubmitting(false);
            }
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (isSubmitting) return;
            let startOffset;
            try {
                startOffset = this.app.parseTrackStartOffset(startOffsetInput.value);
            } catch (error) {
                this.app.updateStatus(error.message, 'warning');
                startOffsetInput.focus();
                startOffsetInput.select();
                return;
            }
            setSubmitting(true);
            try {
                const currentIndex = deck.tracks.indexOf(track);
                if (currentIndex < 0) {
                    this.app.updateStatus('Плейлист изменился. Откройте параметры трека заново', 'warning');
                    return;
                }
                const saved = await this.app.saveTrackMetadata(deckId, currentIndex, {
                    title: titleInput.value,
                    artist: artistInput.value,
                    trackNumber: numberInput.value,
                    startOffset
                });
                if (saved) {
                    setSubmitting(false);
                    close();
                }
            } finally {
                setSubmitting(false);
            }
        });

        document.body.appendChild(overlay);
        titleInput.focus();
        titleInput.select();
    }

    async saveTrackMetadata(deckIdOrIndex, maybeIndexOrMetadata, maybeMetadata) {
        let deckId = this.app.activeDeck;
        let index = deckIdOrIndex;
        let metadata = maybeIndexOrMetadata;
        if (typeof deckIdOrIndex === 'string') {
            deckId = deckIdOrIndex;
            index = maybeIndexOrMetadata;
            metadata = maybeMetadata;
        }

        const deck = this.app.decks[deckId];
        const track = deck?.tracks?.[index];
        if (!track) return false;
        const playlistAtStart = deck?.playlist || this.app.currentPlaylist;

        try {
            const result = await window.electronAPI.saveTrackMetadata(track.path, metadata);
            if (!result?.success) {
                throw new Error(result?.error || 'Не удалось сохранить метаданные');
            }

            const saved = result.data || {};
            track.metadataKey = saved.metadataKey || track.metadataKey;
            track.metadataOverride = saved.metadataOverride || {};
            track.title = Object.prototype.hasOwnProperty.call(track.metadataOverride, 'title')
                ? track.metadataOverride.title
                : null;
            track.artist = Object.prototype.hasOwnProperty.call(track.metadataOverride, 'artist')
                ? track.metadataOverride.artist
                : null;
            track.trackNumber = Object.prototype.hasOwnProperty.call(track.metadataOverride, 'trackNumber')
                ? track.metadataOverride.trackNumber
                : null;
            track.startOffset = Object.prototype.hasOwnProperty.call(track.metadataOverride, 'startOffset')
                ? track.metadataOverride.startOffset
                : 0;
            this.trackMetadataTasks.delete(track);
            track.metadataLoaded = false;
            await this.app.loadTrackMetadata(track, {}, deckId);

            if ((deck?.playlist === playlistAtStart || this.app.currentPlaylist === playlistAtStart) &&
                (deck?.tracks?.includes(track) || this.app.playlistTracks.includes(track))) {
                this.app.displayTracks(deckId);
                const isCurrentTrack = (this.app.playingDeck === deckId && deck?.currentTrackIndex === index) || (this.app.playlistTracks[this.app.currentTrackIndex] === track);
                if (isCurrentTrack && this.app.musicPlayer && !this.app.isPlaying && !this.app.pendingMusicStart) {
                    this.app.loadTrack(index, { deckId });
                }
                if (isCurrentTrack) {
                    this.app.updateCurrentTrackDisplay(track);
                    this.app.updateMediaSessionMetadata(track);
                }
            }
            this.app.updateStatus('Метаданные трека сохранены', 'success');
            return true;
        } catch (error) {
            this.app.updateStatus('Ошибка сохранения метаданных', 'error');
            return false;
        }
    }

    async clearTrackMetadata(deckIdOrIndex, maybeIndex) {
        let deckId = this.app.activeDeck;
        let index = deckIdOrIndex;
        if (typeof deckIdOrIndex === 'string') {
            deckId = deckIdOrIndex;
            index = maybeIndex;
        }

        const deck = this.app.decks[deckId];
        const track = deck?.tracks?.[index];
        if (!track) return false;
        const playlistAtStart = deck?.playlist || this.app.currentPlaylist;

        try {
            const result = await window.electronAPI.clearTrackMetadata(track.path);
            if (!result?.success) {
                throw new Error(result?.error || 'Не удалось сбросить метаданные');
            }

            track.metadataOverride = {};
            track.title = null;
            track.artist = null;
            track.trackNumber = null;
            track.startOffset = 0;
            this.trackMetadataTasks.delete(track);
            track.metadataLoaded = false;
            await this.app.loadTrackMetadata(track, {}, deckId);
            if ((deck?.playlist === playlistAtStart || this.app.currentPlaylist === playlistAtStart) &&
                (deck?.tracks?.includes(track) || this.app.playlistTracks.includes(track))) {
                this.app.displayTracks(deckId);
                const isCurrentTrack = (this.app.playingDeck === deckId && deck?.currentTrackIndex === index) || (this.app.playlistTracks[this.app.currentTrackIndex] === track);
                if (isCurrentTrack && this.app.musicPlayer && !this.app.isPlaying && !this.app.pendingMusicStart) {
                    this.app.loadTrack(index, { deckId });
                }
                if (isCurrentTrack) {
                    this.app.updateCurrentTrackDisplay(track);
                    this.app.updateMediaSessionMetadata(track);
                }
            }
            this.app.updateStatus('Ручные метаданные сброшены', 'success');
            return true;
        } catch (error) {
            this.app.updateStatus('Ошибка сброса метаданных', 'error');
            return false;
        }
    }

    updateCurrentTrackDisplay(track) {
        const currentTrackEl = document.getElementById('currentTrack');
        if (!currentTrackEl) return;

        const title = this.app.getTrackTitle(track);
        const artist = track?.artist && track.artist !== 'Неизвестный исполнитель' ? track.artist : '';
        currentTrackEl.textContent = artist ? `${title} — ${artist}` : title;
        currentTrackEl.title = track?.filename || title;
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

    return { CASLibraryController };
});
