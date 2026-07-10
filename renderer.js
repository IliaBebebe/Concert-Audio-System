﻿class TheatreSoundMixer {
    constructor() {
        this.musicPlayer = null;
        this.soundEffects = new Map();
        this.currentPlaylist = null;
        this.currentTrackIndex = 0;
        this.playlistTracks = [];
        this.selectedPad = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.isMuted = false;
        this.trackFilterQuery = '';
        this.playlistRequestId = 0;
        this.refreshRequestId = 0;
        this.musicPlayerToken = 0;
        this.pendingMusicStart = false;
        this.musicRetryTimeout = null;
        
        // Режимы воспроизведения
        this.playbackMode = 'sequential';
        
        this.musicVolume = 0.7;
        this.effectsVolume = 0.7;
        
        this.config = null;
        
        // Оптимизация производительности
        this.progressAnimationFrame = null;
        this.lastTimeUpdate = null;
        this.statusUpdateTimeout = null;
        
        // Debouncing для обновления громкости
        this.volumeUpdateTimeout = null;
        this.musicVolumeTimeout = null;
        this.effectsVolumeTimeout = null;
        
        // Интервал для часов
        this.clockInterval = null;
        
        // VU-метры
        this.vuMeterInterval = null;
        this.lastMusicLevel = 0;
        this.lastEffectsLevel = 0;
        this.musicVuBar = null;
        this.effectsVuBar = null;
        this.audioContext = null;
        this.musicAnalyser = null;
        this.effectsAnalyser = null;
        this.musicAnalyserData = null;
        this.effectsAnalyserData = null;
        this.connectedAudioNodes = new WeakSet();
        this.audioSources = new WeakMap();
        this.audioSourceTypes = new WeakMap();
        
        // Прогресс падов
        this.padProgressIntervals = new Map();
        this.padActiveSoundIds = new Map();
        this.effectGenerations = new Map();
        this.padLabels = new Map();

        // Очереди исключают десятки одновременных декодирований/IPC-запросов
        // при открытии большого плейлиста или вводе в поиске.
        this.durationLoadQueue = [];
        this.metadataLoadQueue = [];
        this.activeDurationLoads = 0;
        this.activeMetadataLoads = 0;
        this.maxDurationLoads = 3;
        this.maxMetadataLoads = 3;
        this.trackDurationTasks = new WeakMap();
        this.trackMetadataTasks = new WeakMap();
        this.trackLoadGeneration = 0;
        
        // Таймер обратного отсчета
        this.countdownTime = 0;
        this.countdownInterval = null;
        this.isCountdownRunning = false;
        
        // Обработчик видимости страницы для оптимизации
        this.setupVisibilityHandlers();
        
        this.initializeApp();
    }
    
    setupVisibilityHandlers() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.pauseVuMeters();
                this.stopProgressTracking(false);
            } else {
                this.startVuMeters();
                if (this.isPlaying && !this.isPaused) {
                    this.startProgressTracking();
                }
            }
        });
    }
    
    initVuMeters() {
        // Кэшируем ссылки на DOM элементы
        this.musicVuBar = document.querySelector('#musicVuMeter .vu-bar');
        this.effectsVuBar = document.querySelector('#effectsVuMeter .vu-bar');
        this.setupAudioAnalysers();
        this.startVuMeters();
    }

    setupAudioAnalysers() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        if (!this.audioContext) {
            this.audioContext = new AudioContextClass();
        }

        const createAnalyser = () => {
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.72;
            analyser.connect(this.audioContext.destination);
            return analyser;
        };

        this.musicAnalyser = this.musicAnalyser || createAnalyser();
        this.effectsAnalyser = this.effectsAnalyser || createAnalyser();
        this.musicAnalyserData = this.musicAnalyserData || new Uint8Array(this.musicAnalyser.fftSize);
        this.effectsAnalyserData = this.effectsAnalyserData || new Uint8Array(this.effectsAnalyser.fftSize);
    }

    resumeAudioContext() {
        if (this.audioContext?.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }
    }

    connectHowlToAnalyser(howl, type) {
        if (!howl) return;
        this.setupAudioAnalysers();

        const analyser = type === 'effects' ? this.effectsAnalyser : this.musicAnalyser;
        if (!analyser || !Array.isArray(howl._sounds)) return;

        howl._sounds.forEach((sound) => {
            const node = sound?._node;
            if (!node) return;

            try {
                if (node instanceof HTMLAudioElement) {
                    const source = this.audioSources.get(node) || this.audioContext.createMediaElementSource(node);
                    const previousType = this.audioSourceTypes.get(node);

                    // Howler возвращает HTMLAudioElement в общий пул. Когда тот же
                    // элемент переходит от музыки к эффектам (или наоборот), его
                    // нужно перенаправить в соответствующий analyser.
                    if (previousType && previousType !== type) {
                        source.disconnect();
                        this.connectedAudioNodes.delete(node);
                    }

                    if (previousType !== type || !this.connectedAudioNodes.has(node)) {
                        source.connect(analyser);
                        this.audioSourceTypes.set(node, type);
                    }
                    this.audioSources.set(node, source);
                } else if (typeof node.connect === 'function') {
                    if (this.connectedAudioNodes.has(node)) return;
                    node.connect(analyser);
                }
                this.connectedAudioNodes.add(node);
            } catch (error) {
                if (error?.name === 'InvalidStateError') {
                    this.connectedAudioNodes.add(node);
                }
            }
        });
    }

    closeAudioAnalysers() {
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {});
        }
    }

    startVuMeters() {
        if (this.vuMeterInterval) {
            clearInterval(this.vuMeterInterval);
        }
        
        this.vuMeterInterval = setInterval(() => {
            this.updateVuMeters();
        }, 100);
    }
    
    pauseVuMeters() {
        if (this.vuMeterInterval) {
            clearInterval(this.vuMeterInterval);
            this.vuMeterInterval = null;
        }

        if (this.musicVuBar) this.musicVuBar.style.height = '0%';
        if (this.effectsVuBar) this.effectsVuBar.style.height = '0%';
    }

    updateVuMeters() {
        const getLevel = (analyser, buffer) => {
            if (!analyser || !buffer || this.audioContext?.state !== 'running') return 0;
            analyser.getByteTimeDomainData(buffer);

            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
                const centered = (buffer[i] - 128) / 128;
                sum += centered * centered;
            }

            const rms = Math.sqrt(sum / buffer.length);
            return Math.min(1, rms * 3.8);
        };

        this.connectHowlToAnalyser(this.musicPlayer, 'music');
        this.soundEffects.forEach((soundData) => this.connectHowlToAnalyser(soundData?.sound, 'effects'));

        const musicTarget = this.isPlaying && !this.isPaused
            ? getLevel(this.musicAnalyser, this.musicAnalyserData)
            : 0;
        const effectsTarget = Array.from(this.soundEffects.values()).some((soundData) => soundData?.sound?.playing())
            ? getLevel(this.effectsAnalyser, this.effectsAnalyserData)
            : 0;

        this.lastMusicLevel = Math.max(musicTarget, this.lastMusicLevel * 0.82);
        this.lastEffectsLevel = Math.max(effectsTarget, this.lastEffectsLevel * 0.78);

        if (this.musicVuBar) {
            this.musicVuBar.style.height = `${Math.round(this.lastMusicLevel * 100)}%`;
        }

        if (this.effectsVuBar) {
            this.effectsVuBar.style.height = `${Math.round(this.lastEffectsLevel * 100)}%`;
        }
    }

    setupResizers() {
        const appContainer = document.querySelector('.app-container');
        if (!appContainer) return;
        const minLeft = 260;
        const minRight = 260;
        const minCenter = 360;
        const resizerSize = 6;
        
        const applyInitialSizes = () => {
            try {
                const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
                const leftWidth = Number(saved.leftWidth);
                const rightWidth = Number(saved.rightWidth);
                if (Number.isFinite(leftWidth) && leftWidth >= minLeft) appContainer.style.setProperty('--left-width', `${leftWidth}px`);
                if (Number.isFinite(rightWidth) && rightWidth >= minRight) appContainer.style.setProperty('--right-width', `${rightWidth}px`);
            } catch {}
        };
        
        const saveSizes = (sizes) => {
            try {
                const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
                localStorage.setItem('tsmLayout', JSON.stringify({ ...saved, ...sizes }));
            } catch {}
        };
        
        const constrainSizes = () => {
            const rect = appContainer.getBoundingClientRect();
            const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 360;
            const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 340;
            const totalNeeded = leftWidth + rightWidth + 2 * resizerSize + minCenter;

            if (rect.width >= totalNeeded) return;

            let overflow = totalNeeded - rect.width;
            let newLeft = leftWidth;
            let newRight = rightWidth;

            const leftReduction = Math.min(Math.max(0, newLeft - minLeft), overflow / 2);
            newLeft -= leftReduction;
            overflow -= leftReduction;
            const rightReduction = Math.min(Math.max(0, newRight - minRight), overflow);
            newRight -= rightReduction;
            overflow -= rightReduction;
            if (overflow > 0) {
                const extraLeftReduction = Math.min(Math.max(0, newLeft - minLeft), overflow);
                newLeft -= extraLeftReduction;
                overflow -= extraLeftReduction;
            }
            appContainer.style.setProperty('--left-width', `${newLeft}px`);
            appContainer.style.setProperty('--right-width', `${newRight}px`);
        };

        applyInitialSizes();
        constrainSizes();
        
        const startDrag = (type, e) => {
            e.preventDefault();
            const rect = appContainer.getBoundingClientRect();
            
            const onMove = (ev) => {
                if (type === 'left') {
                    let x = ev.clientX - rect.left;
                    const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 340;
                    const total = rect.width;
                    const maxLeft = total - rightWidth - 2 * resizerSize - minCenter;
                    x = Math.max(minLeft, Math.min(maxLeft, x));
                    appContainer.style.setProperty('--left-width', `${x}px`);
                } else if (type === 'right') {
                    let x = rect.right - ev.clientX;
                    const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 360;
                    const total = rect.width;
                    const maxRight = total - leftWidth - 2 * resizerSize - minCenter;
                    x = Math.max(minRight, Math.min(maxRight, x));
                    appContainer.style.setProperty('--right-width', `${x}px`);
                }
            };
            
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                window.removeEventListener('blur', onUp);
                const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 0;
                const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 0;
                const sizes = {};
                if (leftWidth) sizes.leftWidth = leftWidth;
                if (rightWidth) sizes.rightWidth = rightWidth;
                saveSizes(sizes);
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            window.addEventListener('blur', onUp);
        };
        
        document.querySelectorAll('.resizer.vertical').forEach(el => {
            const type = el.dataset.resizer;
            el.addEventListener('mousedown', (e) => startDrag(type, e));
        });

        this.setupBlockHeightPersistence();
        
        window.addEventListener('resize', constrainSizes);
    }

    setupBlockHeightPersistence() {
        const resizableBlocks = [
            ['leftPlaylistsSection', '.left-panel > .section:nth-of-type(2)'],
            ['leftPadsSection', '.left-panel > .section:nth-of-type(3)'],
            ['playlistsContainer', '#playlistsContainer'],
            ['soundPadsGrid', '#soundPadsGrid'],
            ['tracksContainer', '#tracksContainer'],
            ['nowPlaying', '.now-playing'],
            ['progressSection', '.progress-section'],
            ['volumeSection', '.volume-section'],
            ['countdownSection', '.countdown-section'],
            ['hotkeysInfo', '.hotkeys-info']
        ];

        let savedHeights = {};
        try {
            savedHeights = JSON.parse(localStorage.getItem('tsmBlockHeights') || '{}');
        } catch {}

        const saveHeights = () => {
            try {
                localStorage.setItem('tsmBlockHeights', JSON.stringify(savedHeights));
            } catch {}
        };

        const saveTimers = new Map();
        const observer = new ResizeObserver((entries) => {
            entries.forEach((entry) => {
                const key = entry.target.dataset.blockHeightKey;
                if (!key) return;

                clearTimeout(saveTimers.get(key));
                saveTimers.set(key, setTimeout(() => {
                    const borderBox = Array.isArray(entry.borderBoxSize)
                        ? entry.borderBoxSize[0]
                        : entry.borderBoxSize;
                    const height = Math.round(borderBox?.blockSize || entry.target.getBoundingClientRect().height);
                    if (height > 40) {
                        savedHeights[key] = height;
                        saveHeights();
                    }
                }, 250));
            });
        });

        resizableBlocks.forEach(([key, selector]) => {
            const element = document.querySelector(selector);
            if (!element) return;

            element.dataset.blockHeightKey = key;
            const savedHeight = Number(savedHeights[key]);
            if (savedHeight > 40) {
                element.style.height = `${savedHeight}px`;
            }
            observer.observe(element);
        });
    }

    async initializeApp() {
        await this.loadConfig();
        this.setupEventListeners();
        this.createSoundPads();
        this.setupResizers();
        this.initVuMeters();
        this.startClock();
        this.updateCountdownDisplay();
        await this.loadStoredData();
        await this.refreshPlaylists();
    }

    async loadConfig() {
        try {
            this.config = await window.electronAPI.getConfig();
        } catch (error) {
            this.config = { firstRun: false, musicFolder: null };
        }
    }

    setupEventListeners() {
        this.onClick('refreshPlaylists', () => this.refreshPlaylists());
        
        this.onClick('playBtn', () => this.playMusic());
        this.onClick('pauseBtn', () => this.pauseMusic());
        this.onClick('stopBtn', () => this.stopMusic());
        this.onClick('prevTrack', () => this.previousTrack());
        this.onClick('nextTrack', () => this.nextTrack());
        
        const panicBtn = document.getElementById('panicMuteBtn');
        if (panicBtn) panicBtn.addEventListener('click', () => this.togglePanicMute());
        
        this.onClick('assignSound', () => this.assignSoundToPad());
        this.onClick('renamePad', () => this.renameSelectedPad());
        this.onClick('clearPad', () => this.clearSelectedPad());
        this.onClick('stopAllEffects', () => this.stopAllEffects());
        
        document.getElementById('musicVolume')?.addEventListener('input', (e) => {
            this.setMusicVolume(e.target.value / 100);
            this.updateVuMeters();
        });
        document.getElementById('effectsVolume')?.addEventListener('input', (e) => {
            this.setEffectsVolume(e.target.value / 100);
            this.updateVuMeters();
        });
        
        document.getElementById('progressBar')?.addEventListener('input', (e) => this.seekMusic(e.target.value));
        
        const searchInput = document.getElementById('trackSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.filterTracks(e.target.value));
        }
        
        const countdownStart = document.getElementById('countdownStart');
        const countdownStop = document.getElementById('countdownStop');
        const countdownReset = document.getElementById('countdownReset');
        if (countdownStart) countdownStart.addEventListener('click', () => this.startCountdown());
        if (countdownStop) countdownStop.addEventListener('click', () => this.stopCountdown());
        if (countdownReset) countdownReset.addEventListener('click', () => this.resetCountdown());
        
        document.querySelectorAll('input[name="playbackMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.playbackMode = e.target.value;
                if (this.musicPlayer) {
                    try {
                        this.musicPlayer.loop(this.playbackMode === 'loop');
                    } catch {}
                }
                this.updateStatus(`Режим: ${this.getPlaybackModeName()}`);
                this.saveStoredData();
            });
        });
        
        document.addEventListener('keydown', (e) => this.handleHotkeys(e));
        document.addEventListener('wheel', (e) => this.handleVolumeWheel(e), { passive: false });
    }

    onClick(id, handler) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    togglePanicMute() {
        this.isMuted = !this.isMuted;
        if (this.musicPlayer) {
            try {
                this.musicPlayer.mute(this.isMuted);
            } catch {}
        }
        this.soundEffects.forEach(sd => {
            if (sd?.sound) {
                try { sd.sound.mute(this.isMuted); } catch {}
            }
            if (sd?.loadingSound) {
                try { sd.loadingSound.mute(this.isMuted); } catch {}
            }
        });
        const btn = document.getElementById('panicMuteBtn');
        if (btn) {
            btn.innerHTML = this.isMuted ? 
                '<i class="fas fa-volume-up"></i> Unmute' : 
                '<i class="fas fa-volume-mute"></i> Mute (паника)';
        }
        this.updateStatus(this.isMuted ? 'Звук выключен (паника)' : 'Звук включен');
    }

    filterTracks(query) {
        this.trackFilterQuery = (query || '').toLowerCase().trim();
        this.displayTracks();
    }

    getTrackTitle(track) {
        return track?.title || track?.name || 'Без названия';
    }

    getTrackArtist(track) {
        return track?.artist || 'Неизвестный исполнитель';
    }

    getTrackDisplayNumber(track, index) {
        return track?.trackNumber || index + 1;
    }

    getTrackDisplayName(track, index) {
        return `${this.getTrackDisplayNumber(track, index)}. ${this.getTrackTitle(track)}`;
    }

    isTrackMetadataOverridden(track, field) {
        return Boolean(track?.metadataOverride && Object.prototype.hasOwnProperty.call(track.metadataOverride, field));
    }

    async changeMusicFolder() {
        try {
            this.updateStatus('Изменение папки с музыкой...');
            const result = await window.electronAPI.selectMusicFolder();
            
            if (result.success) {
                const saveResult = await window.electronAPI.setMusicFolder(result.path);
                
                if (saveResult.success) {
                    await this.loadConfig();
                    this.resetPlaylistState();
                    this.updateStatus(`Папка изменена: ${result.path}`);
                    await this.refreshPlaylists();
                } else {
                    throw new Error('Ошибка сохранения настроек');
                }
            } else {
                this.updateStatus('Папка не выбрана');
            }
        } catch (error) {
            this.updateStatus('Ошибка изменения папки');
        }
    }

    async refreshPlaylists() {
        const requestId = ++this.refreshRequestId;
        const musicFolder = this.config?.musicFolder;
        try {
            this.updateStatus('Загрузка плейлистов...');
            const result = await window.electronAPI.readDirectory();
            if (requestId !== this.refreshRequestId || musicFolder !== this.config?.musicFolder) return;
            
            if (result.success) {
                if (result.data.length === 0) {
                    this.displayNoPlaylists();
                } else {
                    this.displayPlaylists(result.data);
                    this.updateStatus(`Найдено плейлистов: ${result.data.length}`);
                }
            } else {
                this.displayPlaylistError(result.error);
            }
        } catch (error) {
            if (requestId !== this.refreshRequestId || musicFolder !== this.config?.musicFolder) return;
            this.displayPlaylistError(error.message);
        }
    }

    displayNoPlaylists() {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.config.musicFolder ? this.config.musicFolder.split(/[\\/]/).pop() : 'папке';
        
        container.replaceChildren();
        const wrapper = document.createElement('div');
        wrapper.className = 'no-playlists';
        wrapper.innerHTML = `
            <p><i class="fas fa-music"></i> Плейлисты не найдены</p>
            <p class="hint"></p>
            <p class="hint">Создайте подпапки с музыкой или выберите другую папку</p>
            <button class="action-btn" id="changeFolderBtn"><i class="fas fa-folder-open"></i> Изменить папку с музыкой</button>
        `;
        wrapper.querySelector('.hint').textContent = `В ${folderName} нет плейлистов (подпапок с музыкой)`;
        container.appendChild(wrapper);
        
        document.getElementById('changeFolderBtn').addEventListener('click', () => this.changeMusicFolder());
        this.updateStatus('Плейлисты не найдены в текущей папке');
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
            <button class="action-btn" id="changeFolderBtn2"><i class="fas fa-folder-open"></i> Изменить папку</button>
        `;
        wrapper.querySelector('.error-detail').textContent = error || 'Неизвестная ошибка';
        container.appendChild(wrapper);
        
        document.getElementById('retryBtn').addEventListener('click', () => this.refreshPlaylists());
        document.getElementById('changeFolderBtn2').addEventListener('click', () => this.changeMusicFolder());
        this.updateStatus(`Ошибка: ${error}`);
    }

    displayPlaylists(playlists) {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.config.musicFolder ? this.config.musicFolder.split(/[\\/]/).pop() : 'Неизвестная папка';
        
        container.replaceChildren();
        const currentFolder = document.createElement('div');
        currentFolder.className = 'current-folder';
        const folderPath = document.createElement('span');
        folderPath.className = 'folder-path';
        const folderIcon = document.createElement('i');
        folderIcon.className = 'fas fa-folder';
        folderPath.append(folderIcon, ` ${folderName}`);
        const changeButton = document.createElement('button');
        changeButton.className = 'folder-change-btn';
        changeButton.id = 'changeMusicFolderSmall';
        changeButton.setAttribute('aria-label', 'Изменить папку с музыкой');
        changeButton.innerHTML = '<i class="fas fa-edit"></i>';
        currentFolder.append(folderPath, changeButton);
        container.appendChild(currentFolder);
        
        playlists.forEach(playlist => {
            const btn = document.createElement('button');
            btn.className = 'playlist-btn';
            btn.dataset.playlistPath = playlist.path;
            btn.classList.toggle('active', playlist.path === this.currentPlaylist?.path);
            const icon = document.createElement('i');
            icon.className = 'fas fa-list';
            const name = document.createElement('span');
            name.className = 'playlist-title';
            name.textContent = playlist.name;
            const count = document.createElement('small');
            count.textContent = `(${playlist.trackCount} треков)`;
            btn.append(icon, name, count);
            btn.addEventListener('click', () => this.loadPlaylist(playlist));
            container.appendChild(btn);
        });
        
        document.getElementById('changeMusicFolderSmall').addEventListener('click', () => this.changeMusicFolder());
    }

    async loadPlaylist(playlist) {
        const requestId = ++this.playlistRequestId;
        try {
            this.updateStatus(`Загрузка плейлиста: ${playlist.name}`);
            const result = await window.electronAPI.getPlaylistTracks(playlist.path);
            if (requestId !== this.playlistRequestId) return;
            
            if (result.success) {
                this.stopMusic({ silent: true });
                this.trackLoadGeneration++;
                this.currentPlaylist = playlist;
                this.playlistTracks = result.data;
                this.currentTrackIndex = 0;
                
                const playlistNameEl = document.getElementById('currentPlaylistName');
                if (playlistNameEl) {
                    playlistNameEl.textContent = `(${playlist.name})`;
                }
                this.displayTracks();
                this.updatePlaylistSelection();
                this.updateTrackCounter();
                this.updateStatus(`Плейлист загружен: ${playlist.name}`, 'success');
                
                if (this.playlistTracks.length > 0) {
                    this.loadTrack(0);
                }
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            if (requestId !== this.playlistRequestId) return;
            this.updateStatus('Ошибка загрузки плейлиста');
        }
    }

    updatePlaylistSelection() {
        const currentPath = this.currentPlaylist?.path;
        document.querySelectorAll('.playlist-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.playlistPath === currentPath);
        });
    }

    resetPlaylistState() {
        this.playlistRequestId++;
        this.refreshRequestId++;
        this.stopMusic({ silent: true });
        this.currentPlaylist = null;
        this.trackLoadGeneration++;
        this.playlistTracks = [];
        this.currentTrackIndex = 0;
        this.trackFilterQuery = '';

        const searchInput = document.getElementById('trackSearchInput');
        if (searchInput) searchInput.value = '';
        const playlistName = document.getElementById('currentPlaylistName');
        if (playlistName) playlistName.textContent = '(не выбран)';
        const currentTrack = document.getElementById('currentTrack');
        if (currentTrack) {
            currentTrack.textContent = 'Трек не выбран';
            currentTrack.title = '';
        }
        this.displayTracks();
        this.updateTrackCounter();
    }

    displayTracks() {
        const container = document.getElementById('tracksContainer');
        container.replaceChildren();

        const list = this.playlistTracks
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => {
                if (!this.trackFilterQuery) return true;
                const name = (t.name || '').toLowerCase();
                const title = (t.title || '').toLowerCase();
                const artist = (t.artist || '').toLowerCase();
                const trackNumber = String(t.trackNumber || '');
                return name.includes(this.trackFilterQuery)
                    || title.includes(this.trackFilterQuery)
                    || artist.includes(this.trackFilterQuery)
                    || trackNumber.includes(this.trackFilterQuery);
            });

        // Используем DocumentFragment для оптимизации DOM
        const fragment = document.createDocumentFragment();
        const pendingTrackLoads = [];

        list.forEach(({ t: track, i: index }) => {
            const row = document.createElement('div');
            row.className = 'track-row';
            row.dataset.index = String(index);

            const btn = document.createElement('button');
            btn.className = 'track-btn';
            btn.dataset.index = String(index);
            if (index === this.currentTrackIndex) {
                btn.classList.add('active');
                row.classList.add('active');
            }

            const trackContent = document.createElement('div');
            trackContent.className = 'track-content';

            const trackInfo = document.createElement('div');
            trackInfo.className = 'track-info';

            const trackName = document.createElement('span');
            trackName.className = 'track-name';
            trackName.textContent = this.getTrackDisplayName(track, index);

            const trackArtist = document.createElement('span');
            trackArtist.className = 'track-artist';
            trackArtist.textContent = this.getTrackArtist(track);

            if (track.metadataOverride && Object.keys(track.metadataOverride).length > 0) {
                const editedBadge = document.createElement('span');
                editedBadge.className = 'track-edited-badge';
                editedBadge.textContent = 'ручн.';
                trackArtist.appendChild(editedBadge);
            }

            trackInfo.appendChild(trackName);
            trackInfo.appendChild(trackArtist);

            const trackDuration = document.createElement('span');
            trackDuration.className = 'track-duration';
            trackDuration.textContent = track.duration
                ? this.formatTime(track.duration)
                : (track.durationUnavailable ? 'N/A' : '--:--');

            trackContent.appendChild(trackInfo);
            trackContent.appendChild(trackDuration);
            btn.appendChild(trackContent);

            // Метаданные редактируются отдельной кнопкой: это исключает
            // случайный запуск музыки при обычном двойном клике.
            btn.addEventListener('click', () => this.playTrack(index));

            const editBtn = document.createElement('button');
            editBtn.className = 'track-edit-btn';
            editBtn.type = 'button';
            editBtn.title = 'Редактировать метаданные';
            editBtn.setAttribute('aria-label', 'Редактировать метаданные трека');
            editBtn.innerHTML = '<i class="fas fa-pen"></i>';
            editBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.openTrackMetadataEditor(index);
            });

            row.append(btn, editBtn);
            fragment.appendChild(row);

            if (!track.duration || !track.artist || !track.title || !track.trackNumber) {
                pendingTrackLoads.push({ track, trackDuration, trackName, trackArtist, index });
            }
        });

        container.appendChild(fragment);
        pendingTrackLoads.forEach(({ track, trackDuration, trackName, trackArtist, index }) => {
            if (!track.duration) this.loadTrackDuration(track, trackDuration);
            if (!track.artist || !track.title || !track.trackNumber) {
                this.loadTrackMetadata(track, { nameElement: trackName, artistElement: trackArtist, index });
            }
        });
    }

    renderTrackArtist(element, track) {
        if (!element) return;
        element.textContent = this.getTrackArtist(track);
        if (track.metadataOverride && Object.keys(track.metadataOverride).length > 0) {
            const editedBadge = document.createElement('span');
            editedBadge.className = 'track-edited-badge';
            editedBadge.textContent = 'ручн.';
            element.appendChild(editedBadge);
        }
    }

    updateTrackRowDetails(track) {
        const index = this.playlistTracks.indexOf(track);
        if (index < 0) return;

        const row = document.querySelector(`.track-row[data-index="${index}"]`);
        if (!row) return;

        const nameElement = row.querySelector('.track-name');
        const artistElement = row.querySelector('.track-artist');
        const durationElement = row.querySelector('.track-duration');
        if (nameElement) nameElement.textContent = this.getTrackDisplayName(track, index);
        this.renderTrackArtist(artistElement, track);
        if (durationElement) {
            durationElement.textContent = track.duration
                ? this.formatTime(track.duration)
                : (track.durationUnavailable ? 'N/A' : '--:--');
        }
        if (this.playlistTracks[this.currentTrackIndex] === track) {
            this.updateCurrentTrackDisplay(track);
        }
    }

    enqueueDurationLoad(track) {
        return new Promise((resolve) => {
            this.durationLoadQueue.push({ track, resolve, generation: this.trackLoadGeneration });
            this.processDurationLoadQueue();
        });
    }

    processDurationLoadQueue() {
        while (this.activeDurationLoads < this.maxDurationLoads && this.durationLoadQueue.length > 0) {
            const { track, resolve, generation } = this.durationLoadQueue.shift();
            if (generation !== this.trackLoadGeneration) {
                resolve(null);
                continue;
            }
            this.activeDurationLoads++;
            this.readTrackDuration(track)
                .then(resolve, () => resolve(null))
                .finally(() => {
                    this.activeDurationLoads--;
                    this.processDurationLoadQueue();
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
                    src: [track.path],
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

    loadTrackDuration(track, durationElement) {
        let task = this.trackDurationTasks.get(track);
        if (!task) {
            task = this.enqueueDurationLoad(track).then((duration) => {
                if (duration) {
                    track.duration = duration;
                    delete track.durationUnavailable;
                } else {
                    track.durationUnavailable = true;
                }
                this.updateTrackRowDetails(track);
                return duration;
            });
            this.trackDurationTasks.set(track, task);
        }

        return task.then((duration) => {
            if (durationElement?.isConnected) {
                durationElement.textContent = duration ? this.formatTime(duration) : 'N/A';
            }
            return duration;
        });
    }

    enqueueMetadataLoad(track) {
        return new Promise((resolve) => {
            this.metadataLoadQueue.push({ track, resolve, generation: this.trackLoadGeneration });
            this.processMetadataLoadQueue();
        });
    }

    processMetadataLoadQueue() {
        while (this.activeMetadataLoads < this.maxMetadataLoads && this.metadataLoadQueue.length > 0) {
            const { track, resolve, generation } = this.metadataLoadQueue.shift();
            if (generation !== this.trackLoadGeneration) {
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
                    this.processMetadataLoadQueue();
                });
        }
    }

    applyTrackMetadata(track, result) {
        const defaultArtist = 'Неизвестный исполнитель';
        if (result?.success && result.data) {
            const artist = result.data.artist
                ? (Array.isArray(result.data.artist) ? result.data.artist.join(', ') : result.data.artist)
                : defaultArtist;

            if (!this.isTrackMetadataOverridden(track, 'artist')) track.artist = artist;
            if (result.data.title && !this.isTrackMetadataOverridden(track, 'title')) track.title = result.data.title;
            if (result.data.trackNumber && !this.isTrackMetadataOverridden(track, 'trackNumber')) {
                track.trackNumber = result.data.trackNumber;
            }
        } else if (!this.isTrackMetadataOverridden(track, 'artist')) {
            track.artist = defaultArtist;
        }
    }

    loadTrackMetadata(track, elements = {}) {
        let task = this.trackMetadataTasks.get(track);
        if (!task) {
            task = this.enqueueMetadataLoad(track).then((result) => {
                this.applyTrackMetadata(track, result);
                this.updateTrackRowDetails(track);
                return result;
            });
            this.trackMetadataTasks.set(track, task);
        }

        return task.then((result) => {
            if (elements.nameElement?.isConnected) {
                elements.nameElement.textContent = this.getTrackDisplayName(track, elements.index);
            }
            if (elements.artistElement?.isConnected) this.renderTrackArtist(elements.artistElement, track);
            if (this.playlistTracks[this.currentTrackIndex] === track) {
                this.updateCurrentTrackDisplay(track);
            }
            return result;
        });
    }

    openTrackMetadataEditor(index) {
        const track = this.playlistTracks[index];
        if (!track) return;

        const existing = document.querySelector('.metadata-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'metadata-modal-overlay';
        overlay.innerHTML = `
            <form class="metadata-modal" aria-label="Редактирование метаданных трека" role="dialog" aria-modal="true">
                <div class="metadata-modal-header">
                    <div>
                        <span class="metadata-modal-kicker">Метаданные трека</span>
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
        const sourceName = overlay.querySelector('.metadata-source-name');
        const close = () => overlay.remove();
        let isSubmitting = false;
        const setSubmitting = (value) => {
            isSubmitting = value;
            form.querySelectorAll('input, button').forEach((element) => {
                element.disabled = value;
            });
        };

        titleInput.value = this.getTrackTitle(track);
        artistInput.value = track.artist && track.artist !== 'Неизвестный исполнитель' ? track.artist : '';
        numberInput.value = track.trackNumber || index + 1;
        sourceName.textContent = track.filename || track.name || '';

        overlay.querySelector('.metadata-close-btn').addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('[data-action="reset"]').addEventListener('click', async () => {
            if (isSubmitting) return;
            setSubmitting(true);
            try {
                if (await this.clearTrackMetadata(index)) close();
            } finally {
                setSubmitting(false);
            }
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (isSubmitting) return;
            setSubmitting(true);
            try {
                const saved = await this.saveTrackMetadata(index, {
                    title: titleInput.value,
                    artist: artistInput.value,
                    trackNumber: numberInput.value
                });
                if (saved) close();
            } finally {
                setSubmitting(false);
            }
        });

        document.body.appendChild(overlay);
        titleInput.focus();
        titleInput.select();
    }

    async saveTrackMetadata(index, metadata) {
        const track = this.playlistTracks[index];
        if (!track) return;
        const playlistAtStart = this.currentPlaylist;

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
            this.trackMetadataTasks.delete(track);
            await this.loadTrackMetadata(track);

            if (this.currentPlaylist === playlistAtStart && this.playlistTracks.includes(track)) {
                this.displayTracks();
                if (this.playlistTracks[this.currentTrackIndex] === track) {
                    this.updateCurrentTrackDisplay(track);
                    this.updateMediaSessionMetadata(track);
                }
            }
            this.updateStatus('Метаданные трека сохранены', 'success');
            return true;
        } catch (error) {
            this.updateStatus('Ошибка сохранения метаданных', 'error');
            return false;
        }
    }

    async clearTrackMetadata(index) {
        const track = this.playlistTracks[index];
        if (!track) return;
        const playlistAtStart = this.currentPlaylist;

        try {
            const result = await window.electronAPI.clearTrackMetadata(track.path);
            if (!result?.success) {
                throw new Error(result?.error || 'Не удалось сбросить метаданные');
            }

            track.metadataOverride = {};
            track.title = null;
            track.artist = null;
            track.trackNumber = null;
            this.trackMetadataTasks.delete(track);
            await this.loadTrackMetadata(track);
            if (this.currentPlaylist === playlistAtStart && this.playlistTracks.includes(track)) {
                this.displayTracks();
                if (this.playlistTracks[this.currentTrackIndex] === track) {
                    this.updateCurrentTrackDisplay(track);
                    this.updateMediaSessionMetadata(track);
                }
            }
            this.updateStatus('Ручные метаданные сброшены', 'success');
            return true;
        } catch (error) {
            this.updateStatus('Ошибка сброса метаданных', 'error');
            return false;
        }
    }

    updateCurrentTrackDisplay(track) {
        const currentTrackEl = document.getElementById('currentTrack');
        if (!currentTrackEl) return;

        const title = this.getTrackTitle(track);
        const artist = track?.artist && track.artist !== 'Неизвестный исполнитель' ? track.artist : '';
        currentTrackEl.textContent = artist ? `${title} — ${artist}` : title;
        currentTrackEl.title = track?.filename || title;
    }

    loadTrack(index) {
        if (index < 0 || index >= this.playlistTracks.length) return;

        this.currentTrackIndex = index;
        const track = this.playlistTracks[index];
        this.stopMusic({ silent: true });

        const playerToken = ++this.musicPlayerToken;
        let player = null;
        const isCurrentPlayer = () => this.musicPlayer === player && this.musicPlayerToken === playerToken;
        const discardFailedPlayer = (message) => {
            if (!isCurrentPlayer()) return;
            this.musicPlayer = null;
            this.musicPlayerToken++;
            this.pendingMusicStart = false;
            this.isPlaying = false;
            this.isPaused = false;
            this.stopProgressTracking();
            try { player.unload(); } catch {}
            this.updateStatus(message, 'error');
        };

        player = new Howl({
            src: [track.path],
            html5: true,
            volume: this.musicVolume,
            mute: this.isMuted,
            loop: this.playbackMode === 'loop',
            onplay: () => {
                if (!isCurrentPlayer()) return;
                if (this.musicRetryTimeout) {
                    clearTimeout(this.musicRetryTimeout);
                    this.musicRetryTimeout = null;
                }
                this.resumeAudioContext();
                setTimeout(() => {
                    if (isCurrentPlayer()) this.connectHowlToAnalyser(player, 'music');
                }, 0);
                this.pendingMusicStart = false;
                this.isPlaying = true;
                this.isPaused = false;
                this.updateStatus(`Воспроизведение: ${this.getTrackTitle(track)}`);
                this.startProgressTracking();
                this.updateVuMeters();
            },
            onpause: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPaused = true;
                this.stopProgressTracking(false);
                this.updateStatus('Пауза');
            },
            onstop: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.updateStatus('Остановлено');
                this.stopProgressTracking();
            },
            onend: () => {
                this.handleTrackEnd(player, playerToken);
            },
            onload: () => {
                if (!isCurrentPlayer()) return;
                this.connectHowlToAnalyser(player, 'music');
                this.updateTimeDisplays(player);
            },
            onloaderror: () => {
                discardFailedPlayer('Ошибка загрузки трека');
            },
            onplayerror: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.stopProgressTracking(false);
                this.updateStatus('Ошибка воспроизведения', 'error');
                if (this.playbackMode === 'sequential' && !this.musicRetryTimeout) {
                    this.musicRetryTimeout = setTimeout(() => {
                        this.musicRetryTimeout = null;
                        if (isCurrentPlayer()) this.nextTrack();
                    }, 1000);
                }
            }
        });
        this.musicPlayer = player;
        
        this.updateCurrentTrackDisplay(track);
        this.updateMediaSessionMetadata(track);
        this.highlightCurrentTrack();
    }

    handleTrackEnd(player = this.musicPlayer, playerToken = this.musicPlayerToken) {
        if (this.musicPlayer !== player || this.musicPlayerToken !== playerToken) return;
        if (this.playbackMode === 'loop') {
            return;
        }
        
        switch (this.playbackMode) {
            case 'sequential':
                this.nextTrack();
                break;
            case 'single':
                this.stopMusic();
                break;
        }
    }

    playTrack(index) {
        if (!this.musicPlayer || index !== this.currentTrackIndex) {
            this.loadTrack(index);
        }
        this.playMusic();
    }

    playMusic() {
        if (!this.musicPlayer) {
            if (this.playlistTracks.length === 0) {
                this.updateStatus('Сначала выберите трек', 'warning');
                return;
            }
            this.loadTrack(this.currentTrackIndex);
        }

        this.resumeAudioContext();
        const player = this.musicPlayer;
        if (!player || this.pendingMusicStart || (this.isPlaying && !this.isPaused)) return;

        this.pendingMusicStart = true;
        try {
            const soundId = player.play();
            if (soundId === null || soundId === undefined) {
                this.pendingMusicStart = false;
                this.updateStatus('Не удалось запустить трек', 'error');
            }
        } catch {
            if (this.musicPlayer === player) this.pendingMusicStart = false;
            this.updateStatus('Ошибка воспроизведения', 'error');
        }
    }

    pauseMusic() {
        if (!this.musicPlayer) return;
        if (this.pendingMusicStart && !this.isPlaying) {
            this.stopMusic({ silent: true });
            this.updateStatus('Запуск отменен');
            return;
        }
        if (this.isPlaying && !this.isPaused) {
            this.musicPlayer.pause();
        }
    }

    stopMusic({ silent = false } = {}) {
        const player = this.musicPlayer;
        this.musicPlayer = null;
        this.musicPlayerToken++;
        this.pendingMusicStart = false;
        if (this.musicRetryTimeout) {
            clearTimeout(this.musicRetryTimeout);
            this.musicRetryTimeout = null;
        }
        this.isPlaying = false;
        this.isPaused = false;
        this.stopProgressTracking();

        if (player) {
            try {
                player.unload(); // unload вместо stop для освобождения памяти
            } catch (e) {
                console.warn('Ошибка при выгрузке:', e);
            }
        }
        if (!silent) this.updateStatus('Остановлено');
    }

    previousTrack() {
        this._navigateTrack(-1);
    }

    nextTrack() {
        this._navigateTrack(1);
    }

    _navigateTrack(direction) {
        if (this.playlistTracks.length === 0) return;
        let newIndex = (this.currentTrackIndex + direction + this.playlistTracks.length) % this.playlistTracks.length;
        this.playTrack(newIndex);
    }

    highlightCurrentTrack() {
        const tracks = document.querySelectorAll('.track-btn');
        tracks.forEach((track, index) => {
            const row = track.closest('.track-row');
            const trackIndex = Number(track.dataset.index);
            const isActive = trackIndex === this.currentTrackIndex;
            track.classList.toggle('active', isActive);
            row?.classList.toggle('active', isActive);
            
            if (isActive) {
                (row || track).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
        this.updateTrackCounter();
    }

    startProgressTracking() {
        this.stopProgressTracking(false);
        const player = this.musicPlayer;
        const playerToken = this.musicPlayerToken;
        if (!player || !this.isPlaying || this.isPaused) return;

        let frameId = null;
        const updateProgress = () => {
            if (this.musicPlayer !== player || this.musicPlayerToken !== playerToken || !this.isPlaying || this.isPaused) {
                if (this.progressAnimationFrame === frameId) this.progressAnimationFrame = null;
                return;
            }

            try {
                const seek = player.seek();
                const duration = player.duration();
                
                if (duration > 0 && !isNaN(seek) && !isNaN(duration)) {
                    const progress = Math.min(100, Math.max(0, (seek / duration) * 100));
                    const progressBar = document.getElementById('progressBar');
                    if (progressBar) {
                        progressBar.value = progress;
                    }
                    
                    const now = Date.now();
                    if (!this.lastTimeUpdate || now - this.lastTimeUpdate >= 250) {
                        this.updateTimeDisplays(player);
                        this.lastTimeUpdate = now;
                    }
                }
            } catch {}

            frameId = requestAnimationFrame(updateProgress);
            this.progressAnimationFrame = frameId;
        };
        
        frameId = requestAnimationFrame(updateProgress);
        this.progressAnimationFrame = frameId;
    }

    updateTimeDisplays(player = this.musicPlayer) {
        if (player) {
            try {
                const seek = player.seek();
                const duration = player.duration();
                
                if (!isNaN(seek) && !isNaN(duration) && duration > 0) {
                    const currentTime = this.formatTime(seek);
                    const totalTime = this.formatTime(duration);
                    const remaining = Math.max(0, duration - seek);
                    const remainingTime = `-${this.formatTime(remaining)}`;
                    
                    const currentTimeDisplay = document.getElementById('currentTimeDisplay');
                    const totalTimeDisplay = document.getElementById('totalTimeDisplay');
                    const remainingTimeDisplay = document.getElementById('remainingTimeDisplay');
                    
                    if (currentTimeDisplay) currentTimeDisplay.textContent = currentTime;
                    if (totalTimeDisplay) totalTimeDisplay.textContent = totalTime;
                    if (remainingTimeDisplay) {
                        remainingTimeDisplay.textContent = remainingTime;
                        remainingTimeDisplay.classList.remove('warning', 'danger');
                        if (remaining <= 10) {
                            remainingTimeDisplay.classList.add('danger');
                        } else if (remaining <= 30) {
                            remainingTimeDisplay.classList.add('warning');
                        }
                    }
                }
            } catch (error) {}
        }
    }

    stopProgressTracking(reset = true) {
        if (this.progressAnimationFrame) {
            cancelAnimationFrame(this.progressAnimationFrame);
            this.progressAnimationFrame = null;
        }
        if (!reset) return;
        
        const progressBar = document.getElementById('progressBar');
        const currentTimeDisplay = document.getElementById('currentTimeDisplay');
        const totalTimeDisplay = document.getElementById('totalTimeDisplay');
        const remainingTimeDisplay = document.getElementById('remainingTimeDisplay');
        
        if (progressBar) progressBar.value = 0;
        if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
        if (totalTimeDisplay) totalTimeDisplay.textContent = '0:00';
        if (remainingTimeDisplay) {
            remainingTimeDisplay.textContent = '-0:00';
            remainingTimeDisplay.classList.remove('warning', 'danger');
        }
        
        this.lastTimeUpdate = null;
    }

    seekMusic(progress) {
        if (this.musicPlayer) {
            try {
                const duration = this.musicPlayer.duration();
                if (duration && duration > 0) {
                    const seekTime = Math.max(0, Math.min(duration, (progress / 100) * duration));
                    this.musicPlayer.seek(seekTime);
                    this.updateTimeDisplays();
                }
            } catch (error) {
                this.updateStatus('Ошибка перемотки', 'error');
            }
        }
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    selectPad(index) {
        document.querySelectorAll('.sound-pad').forEach(pad => {
            pad.classList.remove('selected');
        });
        
        const pad = document.querySelector(`.sound-pad[data-index="${index}"]`);
        if (pad) {
            pad.classList.add('selected');
            this.selectedPad = index;

            const padStatus = document.getElementById('padStatus');
            if (padStatus) padStatus.textContent = `Выбран: ${this.getPadLabel(index)}`;
        }
    }

    getPadLabel(padIndex) {
        return this.soundEffects.get(padIndex)?.name || this.padLabels.get(padIndex) || `Пад ${padIndex + 1}`;
    }

    getPadDisplayName(padIndex) {
        if (!this.soundEffects.has(padIndex) && !this.padLabels.has(padIndex)) {
            return String(padIndex + 1);
        }
        const name = this.getPadLabel(padIndex);
        return name.length > 12 ? `${name.substring(0, 12)}...` : name;
    }

    updatePadLabel(padIndex) {
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (!pad) return;
        const name = this.getPadLabel(padIndex);
        pad.textContent = this.getPadDisplayName(padIndex);
        pad.title = name.startsWith('Пад ') ? '' : name;
    }

    nextEffectGeneration(padIndex) {
        const generation = (this.effectGenerations.get(padIndex) || 0) + 1;
        this.effectGenerations.set(padIndex, generation);
        return generation;
    }

    isCurrentEffectData(padIndex, soundData, generation = soundData?.generation) {
        return this.soundEffects.get(padIndex) === soundData
            && this.effectGenerations.get(padIndex) === generation
            && soundData?.generation === generation;
    }

    getActivePadSoundIds(padIndex) {
        let ids = this.padActiveSoundIds.get(padIndex);
        if (!ids) {
            ids = new Set();
            this.padActiveSoundIds.set(padIndex, ids);
        }
        return ids;
    }

    disposeEffectData(padIndex, soundData, { unload = true, keepAssignment = false } = {}) {
        const generation = this.nextEffectGeneration(padIndex);
        if (soundData) {
            soundData.pendingPlay = false;
            if (soundData.loadingSound) {
                try { soundData.loadingSound.stop(); } catch {}
                try { soundData.loadingSound.unload(); } catch {}
                soundData.loadingSound = null;
            }
            if (soundData.sound) {
                try { soundData.sound.stop(); } catch {}
                if (unload) {
                    try { soundData.sound.unload(); } catch {}
                    soundData.sound = null;
                }
            }
            if (keepAssignment) soundData.generation = generation;
        }

        this.padActiveSoundIds.delete(padIndex);
        this.stopPadProgress(padIndex);
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        pad?.classList.remove('playing');
        return generation;
    }

    async assignSoundToPad() {
        if (this.selectedPad === null) {
            this.updateStatus('Сначала выберите пад правой кнопкой мыши');
            return;
        }

        try {
            const result = await window.electronAPI.openFileDialog({
                title: 'Выберите звуковой эффект',
                filters: [
                    { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }
                ],
                properties: ['openFile']
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                await this.assignSound(this.selectedPad, filePath);
            }
        } catch (error) {
            this.updateStatus('Ошибка выбора файла');
        }
    }

    async assignSound(padIndex, filePath, { name: savedName, persist = true } = {}) {
        try {
            if (!Number.isInteger(padIndex) || padIndex < 0 || padIndex > 11 || typeof filePath !== 'string' || !filePath) {
                throw new Error('Некорректные данные звукового эффекта');
            }

            const fileName = filePath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "");
            const name = typeof savedName === 'string' && savedName.trim() ? savedName.trim() : fileName;
            const previous = this.soundEffects.get(padIndex);
            if (previous) this.disposeEffectData(padIndex, previous);

            const generation = this.nextEffectGeneration(padIndex);
            this.padLabels.set(padIndex, name);
            this.soundEffects.set(padIndex, {
                sound: null,
                loadingSound: null,
                pendingPlay: false,
                generation,
                name,
                path: filePath
            });

            this.updatePadLabel(padIndex);

            this.updateStatus(`Звук "${name}" назначен на пад ${padIndex + 1}`, 'success');
            if (persist) this.saveStoredData();
        } catch (error) {
            this.updateStatus('Ошибка назначения звука', 'error');
        }
    }

    renameSelectedPad() {
        if (this.selectedPad === null) {
            this.updateStatus('Сначала выберите пад правой кнопкой мыши', 'warning');
            return;
        }

        const padIndex = this.selectedPad;
        const current = this.getPadLabel(padIndex);
        const name = prompt('Название для пэда:', current);
        if (name === null) return;

        const normalizedName = name.trim() || `Пад ${padIndex + 1}`;
        const soundData = this.soundEffects.get(padIndex);
        if (soundData) soundData.name = normalizedName;
        this.padLabels.set(padIndex, normalizedName);
        this.updatePadLabel(padIndex);
        const padStatus = document.getElementById('padStatus');
        if (padStatus) padStatus.textContent = `Выбран: ${normalizedName}`;
        this.saveStoredData();
    }

    playSoundEffect(padIndex) {
        const soundData = this.soundEffects.get(padIndex);
        if (!soundData || !soundData.path) {
            this.updateStatus('Пад не настроен', 'warning');
            return;
        }

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        this.animatePadPress(pad);

        if (soundData.sound) {
            this.playLoadedEffect(padIndex, soundData, soundData.sound, pad);
            return;
        }

        if (soundData.loadingSound) {
            soundData.pendingPlay = true;
            this.updateStatus(`Загрузка: ${soundData.name}...`);
            return;
        }

        const generation = this.nextEffectGeneration(padIndex);
        soundData.generation = generation;
        soundData.pendingPlay = true;
        this.updateStatus(`Загрузка: ${soundData.name}...`);

        let sound = null;
        try {
            sound = new Howl({
                src: [soundData.path],
                volume: this.effectsVolume,
                mute: this.isMuted,
                html5: true,
                onload: () => {
                    if (!this.isCurrentEffectData(padIndex, soundData, generation)) {
                        try { sound.unload(); } catch {}
                        return;
                    }
                    soundData.loadingSound = null;
                    soundData.sound = sound;
                    try {
                        sound.volume(this.effectsVolume);
                        sound.mute(this.isMuted);
                    } catch {}
                    this.connectHowlToAnalyser(sound, 'effects');
                    if (!soundData.pendingPlay) return;
                    soundData.pendingPlay = false;
                    this.playLoadedEffect(padIndex, soundData, sound, pad);
                },
                onloaderror: () => {
                    if (!this.isCurrentEffectData(padIndex, soundData, generation)) return;
                    soundData.loadingSound = null;
                    soundData.pendingPlay = false;
                    try { sound.unload(); } catch {}
                    this.updateStatus(`Ошибка загрузки: ${soundData.name}`, 'error');
                },
                onplayerror: () => {
                    if (this.soundEffects.get(padIndex) === soundData && soundData.sound === sound) {
                        this.updateStatus('Ошибка воспроизведения эффекта', 'error');
                    }
                }
            });
            soundData.loadingSound = sound;
        } catch {
            soundData.pendingPlay = false;
            this.updateStatus('Ошибка воспроизведения эффекта', 'error');
        }
    }

    playLoadedEffect(padIndex, soundData, sound, pad) {
        const generation = soundData.generation;
        if (!this.isCurrentEffectData(padIndex, soundData, generation) || soundData.sound !== sound) return;

        try {
            this.resumeAudioContext();
            sound.mute(this.isMuted);
            sound.volume(this.effectsVolume);
            const soundId = sound.play();
            if (soundId === null || soundId === undefined) {
                throw new Error('Не удалось запустить эффект');
            }

            setTimeout(() => {
                if (this.isCurrentEffectData(padIndex, soundData, generation)) {
                    this.connectHowlToAnalyser(sound, 'effects');
                }
            }, 0);

            const activeIds = this.getActivePadSoundIds(padIndex);
            activeIds.add(soundId);
            pad?.classList.add('playing');
            const duration = sound.duration();
            if (duration && duration > 0) this.startPadProgress(padIndex, duration);

            const finish = () => this.finishPadSound(padIndex, soundData, generation, soundId);
            sound.once('end', finish, soundId);
            sound.once('stop', finish, soundId);
            sound.once('playerror', finish, soundId);
            this.updateStatus(`Эффект: ${soundData.name}`, 'success');
        } catch {
            this.finishPadSound(padIndex, soundData, generation);
            this.updateStatus('Ошибка воспроизведения эффекта', 'error');
        }
    }

    finishPadSound(padIndex, soundData, generation, soundId) {
        if (!this.isCurrentEffectData(padIndex, soundData, generation)) return;
        const activeIds = this.padActiveSoundIds.get(padIndex);
        if (soundId !== undefined) activeIds?.delete(soundId);
        if (activeIds?.size) return;

        this.padActiveSoundIds.delete(padIndex);
        this.stopPadProgress(padIndex);
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        pad?.classList.remove('playing');
    }
    
    startPadProgress(padIndex, duration) {
        this.stopPadProgress(padIndex);
        
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (!pad) return;
        
        const startTime = Date.now();
        const updateProgress = () => {
            const padEl = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
            if (!padEl || !padEl.classList.contains('playing')) {
                this.stopPadProgress(padIndex);
                return;
            }
            
            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min(100, (elapsed / duration) * 100);
            
            let progressBar = padEl.querySelector('.pad-progress-bar');
            if (!progressBar) {
                progressBar = document.createElement('div');
                progressBar.className = 'pad-progress-bar';
                padEl.appendChild(progressBar);
            }
            progressBar.style.width = `${progress}%`;
            
            if (progress >= 100) {
                this.stopPadProgress(padIndex);
            }
        };
        
        const intervalId = setInterval(updateProgress, 50);
        this.padProgressIntervals.set(padIndex, intervalId);
    }
    
    stopPadProgress(padIndex) {
        const intervalId = this.padProgressIntervals.get(padIndex);
        if (intervalId) {
            clearInterval(intervalId);
            this.padProgressIntervals.delete(padIndex);
        }
        
        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        if (pad) {
            const progressBar = pad.querySelector('.pad-progress-bar');
            if (progressBar) {
                progressBar.remove();
            }
        }
    }
    
    animatePadPress(pad) {
        if (pad) {
            pad.classList.add('pressed');
            setTimeout(() => {
                pad.classList.remove('pressed');
            }, 150);
        }
    }

    clearSelectedPad() {
        if (this.selectedPad !== null) {
            const padIndex = this.selectedPad;
            const soundData = this.soundEffects.get(padIndex);
            this.disposeEffectData(padIndex, soundData);
            this.soundEffects.delete(padIndex);
            this.padLabels.delete(padIndex);
            const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
            if (pad) {
                this.updatePadLabel(padIndex);
                pad.title = '';
                pad.classList.remove('selected', 'playing');
            }
            
            this.updateStatus(`Пад ${padIndex + 1} очищен`, 'success');
            this.selectedPad = null;
            const padStatus = document.getElementById('padStatus');
            if (padStatus) {
                padStatus.textContent = 'Выберите пад правой кнопкой';
            }
            
            this.saveStoredData();
        } else {
            this.updateStatus('Сначала выберите пад правой кнопкой мыши', 'warning');
        }
    }

    stopAllEffects() {
        let stoppedCount = 0;
        this.soundEffects.forEach((soundData, padIndex) => {
            const wasPlaying = Boolean(soundData?.sound?.playing?.());
            this.disposeEffectData(padIndex, soundData, { unload: false, keepAssignment: true });
            if (wasPlaying) stoppedCount++;
        });
        
        document.querySelectorAll('.sound-pad').forEach(pad => {
            pad.classList.remove('playing');
            const progressBar = pad.querySelector('.pad-progress-bar');
            if (progressBar) {
                progressBar.remove();
            }
        });
        
        this.updateStatus(`Остановлено эффектов: ${stoppedCount}`, 'success');
    }

    setMusicVolume(volume) {
        volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.musicVolume = volume;

        const volumeValueEl = document.getElementById('musicVolumeValue');
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }

        if (this.musicVolumeTimeout) {
            clearTimeout(this.musicVolumeTimeout);
        }

        this.musicVolumeTimeout = setTimeout(() => {
            if (this.musicPlayer) {
                try {
                    this.musicPlayer.volume(volume);
                } catch (error) {
                    console.warn('Ошибка установки громкости музыки:', error);
                }
            }
            this.saveStoredData();
        }, 50);
    }

    setEffectsVolume(volume) {
        volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.effectsVolume = volume;

        const volumeValueEl = document.getElementById('effectsVolumeValue');
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }

        if (this.effectsVolumeTimeout) {
            clearTimeout(this.effectsVolumeTimeout);
        }

        this.effectsVolumeTimeout = setTimeout(() => {
            this.soundEffects.forEach(soundData => {
                if (soundData?.sound) {
                    try {
                        soundData.sound.volume(volume);
                    } catch (error) {
                        console.warn('Ошибка установки громкости эффекта:', error);
                    }
                }
                if (soundData?.loadingSound) {
                    try { soundData.loadingSound.volume(volume); } catch {}
                }
            });
            this.saveStoredData();
        }, 50);
    }

    getPlaybackModeName() {
        switch (this.playbackMode) {
            case 'sequential': return 'Автоматически следующий';
            case 'loop': return 'Зациклить трек';
            case 'single': return 'Только текущий';
            default: return 'Неизвестно';
        }
    }

    handleHotkeys(event) {
        const metadataModal = document.querySelector('.metadata-modal-overlay');
        if (metadataModal) {
            if (event.code === 'Escape') {
                event.preventDefault();
                metadataModal.remove();
            }
            return;
        }

        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const tagName = event.target?.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || event.target?.isContentEditable) return;

        const repeatedTriggerKeys = new Set([
            'Space', 'Escape', 'KeyM', 'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
            'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Minus', 'Equal',
            'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5',
            'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9'
        ]);
        if (event.repeat && repeatedTriggerKeys.has(event.code)) {
            event.preventDefault();
            return;
        }

        switch (event.code) {
            case 'Space':
                event.preventDefault();
                if (this.isPlaying && !this.isPaused) {
                    this.pauseMusic();
                } else {
                    this.playMusic();
                }
                break;
            case 'Escape':
                event.preventDefault();
                this.stopMusic();
                this.stopAllEffects();
                break;
            case 'KeyM':
                event.preventDefault();
                this.togglePanicMute();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.previousTrack();
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.nextTrack();
                break;
            case 'ArrowUp':
                event.preventDefault();
                if (event.shiftKey) {
                    this.setEffectsVolume(Math.min(1, this.effectsVolume + 0.01));
                    document.getElementById('effectsVolume').value = this.effectsVolume * 100;
                } else {
                    this.setMusicVolume(Math.min(1, this.musicVolume + 0.01));
                    document.getElementById('musicVolume').value = this.musicVolume * 100;
                }
                break;
            case 'ArrowDown':
                event.preventDefault();
                if (event.shiftKey) {
                    this.setEffectsVolume(Math.max(0, this.effectsVolume - 0.01));
                    document.getElementById('effectsVolume').value = this.effectsVolume * 100;
                } else {
                    this.setMusicVolume(Math.max(0, this.musicVolume - 0.01));
                    document.getElementById('musicVolume').value = this.musicVolume * 100;
                }
                break;
            default:
                const padHotkeys = {
                    Digit1: 0,
                    Digit2: 1,
                    Digit3: 2,
                    Digit4: 3,
                    Digit5: 4,
                    Digit6: 5,
                    Digit7: 6,
                    Digit8: 7,
                    Digit9: 8,
                    Digit0: 9,
                    Minus: 10,
                    Equal: 11,
                    Numpad1: 0,
                    Numpad2: 1,
                    Numpad3: 2,
                    Numpad4: 3,
                    Numpad5: 4,
                    Numpad6: 5,
                    Numpad7: 6,
                    Numpad8: 7,
                    Numpad9: 8,
                    Numpad0: 9
                };
                if (Object.prototype.hasOwnProperty.call(padHotkeys, event.code)) {
                    event.preventDefault();
                    this.playSoundEffect(padHotkeys[event.code]);
                }
                break;
        }
    }
    
    handleVolumeWheel(event) {
        const volumeSection = document.querySelector('.volume-section');
        if (!volumeSection) return;
        
        const rect = volumeSection.getBoundingClientRect();
        const isOverVolume = (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
        );
        
        if (!isOverVolume) return;
        
        const musicControl = document.querySelector('.volume-control:first-of-type');
        const effectsControl = document.querySelector('.volume-control:last-of-type');
        
        let targetVolume = null;
        let isMusic = false;
        
        if (musicControl) {
            const musicRect = musicControl.getBoundingClientRect();
            if (event.clientY >= musicRect.top && event.clientY <= musicRect.bottom) {
                isMusic = true;
                targetVolume = this.musicVolume;
            }
        }
        
        if (!isMusic && effectsControl) {
            const effectsRect = effectsControl.getBoundingClientRect();
            if (event.clientY >= effectsRect.top && event.clientY <= effectsRect.bottom) {
                isMusic = false;
                targetVolume = this.effectsVolume;
            }
        }
        
        if (targetVolume === null) return;
        
        event.preventDefault();
        
        const delta = event.deltaY > 0 ? -0.01 : 0.01;
        const newVolume = Math.max(0, Math.min(1, targetVolume + delta));
        
        if (isMusic) {
            this.setMusicVolume(newVolume);
            const musicSlider = document.getElementById('musicVolume');
            if (musicSlider) musicSlider.value = newVolume * 100;
        } else {
            this.setEffectsVolume(newVolume);
            const effectsSlider = document.getElementById('effectsVolume');
            if (effectsSlider) effectsSlider.value = newVolume * 100;
        }
    }

    saveStoredData() {
        const data = {
            soundEffects: Array.from(this.soundEffects.entries())
                .filter(([, soundData]) => typeof soundData?.path === 'string' && soundData.path)
                .map(([index, soundData]) => ({
                    index,
                    name: soundData.name,
                    path: soundData.path
                })),
            padLabels: Array.from(this.padLabels.entries()).map(([index, name]) => ({ index, name })),
            musicVolume: this.musicVolume,
            effectsVolume: this.effectsVolume,
            playbackMode: this.playbackMode
        };
        try {
            localStorage.setItem('theatreSoundMixer', JSON.stringify(data));
        } catch {}
    }

    async loadStoredData() {
        try {
            const stored = localStorage.getItem('theatreSoundMixer');
            if (!stored) return;
            const data = JSON.parse(stored);
            if (!data || typeof data !== 'object') return;

            const normalizeVolume = (value, fallback) => {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
            };
            this.musicVolume = normalizeVolume(data.musicVolume, 0.7);
            this.effectsVolume = normalizeVolume(data.effectsVolume, 0.7);
            this.playbackMode = ['sequential', 'loop', 'single'].includes(data.playbackMode)
                ? data.playbackMode
                : 'sequential';

            const musicSlider = document.getElementById('musicVolume');
            const effectsSlider = document.getElementById('effectsVolume');
            const musicValue = document.getElementById('musicVolumeValue');
            const effectsValue = document.getElementById('effectsVolumeValue');
            if (musicSlider) musicSlider.value = this.musicVolume * 100;
            if (effectsSlider) effectsSlider.value = this.effectsVolume * 100;
            if (musicValue) musicValue.textContent = `${Math.round(this.musicVolume * 100)}%`;
            if (effectsValue) effectsValue.textContent = `${Math.round(this.effectsVolume * 100)}%`;

            const playbackModeInput = document.querySelector(`input[name="playbackMode"][value="${this.playbackMode}"]`);
            if (playbackModeInput) playbackModeInput.checked = true;

            if (Array.isArray(data.padLabels)) {
                data.padLabels.forEach((label) => {
                    if (Number.isInteger(label?.index) && label.index >= 0 && label.index < 12 && typeof label.name === 'string' && label.name.trim()) {
                        this.padLabels.set(label.index, label.name.trim());
                        this.updatePadLabel(label.index);
                    }
                });
            }

            if (Array.isArray(data.soundEffects)) {
                for (const effect of data.soundEffects) {
                    if (!Number.isInteger(effect?.index) || typeof effect.path !== 'string' || !effect.path) continue;
                    await this.assignSound(effect.index, effect.path, {
                        name: typeof effect.name === 'string' ? effect.name : this.padLabels.get(effect.index),
                        persist: false
                    });
                }
            }
        } catch {}
    }

    updateStatus(message, type = 'info') {
        const statusElement = document.getElementById('status');
        if (!statusElement) return;
        
        if (this.statusUpdateTimeout) {
            clearTimeout(this.statusUpdateTimeout);
        }
        
        statusElement.textContent = message;
        statusElement.classList.add('pulse');
        
        statusElement.classList.remove('status-error', 'status-success', 'status-warning');
        if (type === 'error') {
            statusElement.classList.add('status-error');
        } else if (type === 'success') {
            statusElement.classList.add('status-success');
        } else if (type === 'warning') {
            statusElement.classList.add('status-warning');
        }
        
        this.statusUpdateTimeout = setTimeout(() => {
            statusElement.classList.remove('pulse');
        }, 500);
    }

    createSoundPads() {
        const grid = document.getElementById('soundPadsGrid');
        if (!grid) return;
        grid.innerHTML = '';
        
        for (let i = 0; i < 12; i++) {
            const pad = document.createElement('div');
            pad.className = 'sound-pad';
            pad.textContent = this.getPadDisplayName(i);
            pad.dataset.index = i;
            pad.dataset.key = i + 1;
            
            pad.addEventListener('click', () => this.playSoundEffect(i));
            pad.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.selectPad(i);
            });
            
            grid.appendChild(pad);
        }
    }

    startClock() {
        const updateTime = () => {
            const now = new Date();
            const timeString = now.toLocaleTimeString('ru-RU', { 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            });
            const currentTimeEl = document.getElementById('currentTime');
            if (currentTimeEl) {
                currentTimeEl.textContent = timeString;
            }
        };
        
        updateTime();
        this.clockInterval = setInterval(updateTime, 1000);
        this.setupMediaSession();
    }
    
    setupMediaSession() {
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Theatre Sound Mixer',
                    artist: 'Concert Audio System',
                    album: 'Sound Mixing'
                });
                
                try {
                    navigator.mediaSession.setActionHandler('play', () => {
                        this.playMusic();
                    });
                    navigator.mediaSession.setActionHandler('pause', () => {
                        this.pauseMusic();
                    });
                    navigator.mediaSession.setActionHandler('stop', () => {
                        this.stopMusic();
                        this.stopAllEffects();
                    });
                    navigator.mediaSession.setActionHandler('previoustrack', () => {
                        this.previousTrack();
                    });
                    navigator.mediaSession.setActionHandler('nexttrack', () => {
                        this.nextTrack();
                    });
                } catch (e) {}
            } catch (error) {}
        }
    }
    
    updateMediaSessionMetadata(track) {
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                const title = typeof track === 'string' ? track : this.getTrackTitle(track);
                const artist = typeof track === 'string' ? 'Concert Audio System' : this.getTrackArtist(track);
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: title || 'Theatre Sound Mixer',
                    artist: artist || 'Concert Audio System',
                    album: 'Sound Mixing'
                });
            } catch (error) {}
        }
    }
    
    updateTrackCounter() {
        const counterEl = document.getElementById('trackCounter');
        if (counterEl && this.playlistTracks.length > 0) {
            const current = this.currentTrackIndex + 1;
            const total = this.playlistTracks.length;
            counterEl.textContent = `${current} / ${total}`;
        } else if (counterEl) {
            counterEl.textContent = '— / —';
        }
    }
    
    startCountdown() {
        const minutesInput = document.getElementById('countdownMinutes');
        const secondsInput = document.getElementById('countdownSeconds');
        const clampTimerValue = (value) => Math.max(0, Math.min(59, Number.parseInt(value, 10) || 0));
        const minutes = clampTimerValue(minutesInput?.value);
        const seconds = clampTimerValue(secondsInput?.value);
        if (minutesInput) minutesInput.value = minutes;
        if (secondsInput) secondsInput.value = seconds;
        
        this.countdownTime = minutes * 60 + seconds;
        
        if (this.countdownTime <= 0) {
            this.updateStatus('Установите время для таймера', 'warning');
            return;
        }
        
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
        
        this.isCountdownRunning = true;
        this.updateCountdownDisplay();
        
        this.countdownInterval = setInterval(() => {
            this.countdownTime--;
            this.updateCountdownDisplay();
            
            if (this.countdownTime <= 0) {
                this.stopCountdown();
                this.updateStatus('Таймер завершен!', 'warning');
            }
        }, 1000);
    }
    
    stopCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
        this.isCountdownRunning = false;
    }
    
    resetCountdown() {
        this.stopCountdown();
        this.countdownTime = 0;
        document.getElementById('countdownMinutes').value = 0;
        document.getElementById('countdownSeconds').value = 0;
        this.updateCountdownDisplay();
    }
    
    updateCountdownDisplay() {
        const displayEl = document.getElementById('countdownDisplay');
        if (!displayEl) return;
        
        const minutes = Math.floor(this.countdownTime / 60);
        const seconds = this.countdownTime % 60;
        const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        displayEl.textContent = timeString;
        displayEl.classList.remove('warning', 'danger');
        
        if (this.countdownTime > 0 && this.countdownTime <= 10) {
            displayEl.classList.add('danger');
        } else if (this.countdownTime > 10 && this.countdownTime <= 30) {
            displayEl.classList.add('warning');
        }
    }
}

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    window.soundMixer = new TheatreSoundMixer();
});

// Очистка ресурсов при закрытии окна
window.addEventListener('beforeunload', () => {
    if (window.soundMixer) {
        window.soundMixer.stopMusic();
        window.soundMixer.stopAllEffects();
        
        if (window.soundMixer.clockInterval) {
            clearInterval(window.soundMixer.clockInterval);
        }
        if (window.soundMixer.progressAnimationFrame) {
            cancelAnimationFrame(window.soundMixer.progressAnimationFrame);
        }
        if (window.soundMixer.volumeUpdateTimeout) {
            clearTimeout(window.soundMixer.volumeUpdateTimeout);
        }
        if (window.soundMixer.musicVolumeTimeout) {
            clearTimeout(window.soundMixer.musicVolumeTimeout);
        }
        if (window.soundMixer.effectsVolumeTimeout) {
            clearTimeout(window.soundMixer.effectsVolumeTimeout);
        }
        if (window.soundMixer.statusUpdateTimeout) {
            clearTimeout(window.soundMixer.statusUpdateTimeout);
        }
        if (window.soundMixer.countdownInterval) {
            clearInterval(window.soundMixer.countdownInterval);
        }
        if (window.soundMixer.vuMeterInterval) {
            clearInterval(window.soundMixer.vuMeterInterval);
        }
        
        if (window.soundMixer.musicPlayer) {
            try {
                window.soundMixer.musicPlayer.unload();
            } catch (e) {}
        }
        
        window.soundMixer.soundEffects.forEach((soundData) => {
            if (soundData?.sound) {
                try {
                    soundData.sound.unload();
                } catch (e) {}
            }
        });

        window.soundMixer.closeAudioAnalysers();
        
        window.soundMixer.saveStoredData();
    }
});

// Обработка ошибок на уровне приложения
window.addEventListener('error', (event) => {
    if (window.soundMixer) {
        window.soundMixer.updateStatus('Произошла ошибка приложения', 'error');
    }
});

window.addEventListener('unhandledrejection', (event) => {
    if (window.soundMixer) {
        window.soundMixer.updateStatus('Ошибка выполнения операции', 'error');
    }
});
