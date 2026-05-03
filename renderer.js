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
        
        // Прогресс падов
        this.padProgressIntervals = new Map();
        
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
                if (this.progressAnimationFrame) {
                    cancelAnimationFrame(this.progressAnimationFrame);
                    this.progressAnimationFrame = null;
                }
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
            if (!node || this.connectedAudioNodes.has(node)) return;

            try {
                if (node instanceof HTMLAudioElement) {
                    const source = this.audioSources.get(node) || this.audioContext.createMediaElementSource(node);
                    this.audioSources.set(node, source);
                    source.connect(analyser);
                } else if (typeof node.connect === 'function') {
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
        const resizerSize = 6;
        
        const applyInitialSizes = () => {
            try {
                const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
                if (saved.leftWidth) appContainer.style.setProperty('--left-width', `${saved.leftWidth}px`);
                if (saved.rightWidth) appContainer.style.setProperty('--right-width', `${saved.rightWidth}px`);
            } catch {}
        };
        
        const saveSizes = (sizes) => {
            try {
                const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
                localStorage.setItem('tsmLayout', JSON.stringify({ ...saved, ...sizes }));
            } catch {}
        };
        
        applyInitialSizes();
        
        const startDrag = (type, e) => {
            e.preventDefault();
            const rect = appContainer.getBoundingClientRect();
            
            const onMove = (ev) => {
                if (type === 'left') {
                    let x = ev.clientX - rect.left;
                    const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 340;
                    const total = rect.width;
                    const maxLeft = total - rightWidth - resizerSize - 300;
                    x = Math.max(minLeft, Math.min(maxLeft, x));
                    appContainer.style.setProperty('--left-width', `${x}px`);
                } else if (type === 'right') {
                    let x = rect.right - ev.clientX;
                    const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 360;
                    const total = rect.width;
                    const maxRight = total - leftWidth - resizerSize - 300;
                    x = Math.max(minRight, Math.min(maxRight, x));
                    appContainer.style.setProperty('--right-width', `${x}px`);
                }
            };
            
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 0;
                const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 0;
                const sizes = {};
                if (leftWidth) sizes.leftWidth = leftWidth;
                if (rightWidth) sizes.rightWidth = rightWidth;
                saveSizes(sizes);
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        
        document.querySelectorAll('.resizer.vertical').forEach(el => {
            const type = el.dataset.resizer;
            el.addEventListener('mousedown', (e) => startDrag(type, e));
        });

        this.setupBlockHeightPersistence();
        
        window.addEventListener('resize', () => {
            const rect = appContainer.getBoundingClientRect();
            const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 360;
            const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 340;
            const minCenter = 300;
            const totalNeeded = leftWidth + rightWidth + 2 * resizerSize + minCenter;
            if (rect.width < totalNeeded) {
                const overflow = totalNeeded - rect.width;
                const reduceEach = overflow / 2;
                const newLeft = Math.max(minLeft, leftWidth - reduceEach);
                const newRight = Math.max(minRight, rightWidth - reduceEach);
                appContainer.style.setProperty('--left-width', `${newLeft}px`);
                appContainer.style.setProperty('--right-width', `${newRight}px`);
            }
        });
    }

    setupBlockHeightPersistence() {
        const resizableBlocks = [
            ['leftPlaylistsSection', '.left-panel > .section:nth-of-type(1)'],
            ['leftPadsSection', '.left-panel > .section:nth-of-type(2)'],
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
                    const height = Math.round(entry.contentRect.height);
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

    async changeMusicFolder() {
        try {
            this.updateStatus('Изменение папки с музыкой...');
            const result = await window.electronAPI.selectMusicFolder();
            
            if (result.success) {
                const saveResult = await window.electronAPI.setMusicFolder(result.path);
                
                if (saveResult.success) {
                    await this.loadConfig();
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
        try {
            this.updateStatus('Загрузка плейлистов...');
            const result = await window.electronAPI.readDirectory();
            
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
        try {
            this.updateStatus(`Загрузка плейлиста: ${playlist.name}`);
            const result = await window.electronAPI.getPlaylistTracks(playlist.path);
            
            if (result.success) {
                this.currentPlaylist = playlist;
                this.playlistTracks = result.data;
                this.currentTrackIndex = 0;
                
                const playlistNameEl = document.getElementById('currentPlaylistName');
                if (playlistNameEl) {
                    playlistNameEl.textContent = `(${playlist.name})`;
                }
                this.displayTracks();
                this.updateTrackCounter();
                this.updateStatus(`Плейлист загружен: ${playlist.name}`, 'success');
                
                if (this.playlistTracks.length > 0) {
                    this.loadTrack(0);
                }
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            this.updateStatus('Ошибка загрузки плейлиста');
        }
    }

    displayTracks() {
        const container = document.getElementById('tracksContainer');
        container.innerHTML = '';

        const list = this.playlistTracks
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => {
                if (!this.trackFilterQuery) return true;
                const name = (t.name || '').toLowerCase();
                const artist = (t.artist || '').toLowerCase();
                return name.includes(this.trackFilterQuery) || artist.includes(this.trackFilterQuery);
            });

        // Используем DocumentFragment для оптимизации DOM
        const fragment = document.createDocumentFragment();

        list.forEach(({ t: track, i: index }) => {
            const btn = document.createElement('button');
            btn.className = 'track-btn';
            if (index === this.currentTrackIndex) {
                btn.classList.add('active');
            }

            const trackContent = document.createElement('div');
            trackContent.className = 'track-content';

            const trackInfo = document.createElement('div');
            trackInfo.className = 'track-info';

            const trackName = document.createElement('span');
            trackName.className = 'track-name';
            trackName.textContent = `${index + 1}. ${track.name}`;

            const trackArtist = document.createElement('span');
            trackArtist.className = 'track-artist';
            trackArtist.textContent = track.artist || 'Неизвестный исполнитель';

            trackInfo.appendChild(trackName);
            trackInfo.appendChild(trackArtist);

            const trackDuration = document.createElement('span');
            trackDuration.className = 'track-duration';
            trackDuration.textContent = track.duration ? this.formatTime(track.duration) : '--:--';

            trackContent.appendChild(trackInfo);
            trackContent.appendChild(trackDuration);
            btn.appendChild(trackContent);

            btn.addEventListener('click', () => this.playTrack(index));
            fragment.appendChild(btn);

            if (!track.duration) {
                this.loadTrackDuration(track, trackDuration);
            }

            if (!track.artist) {
                this.loadTrackMetadata(track, trackArtist);
            }
        });

        container.appendChild(fragment);
    }
    
    async loadTrackDuration(track, durationElement) {
        try {
            const tempSound = new Howl({
                src: [track.path],
                html5: true,
                volume: 0,
                onload: () => {
                    const duration = tempSound.duration();
                    if (duration && !isNaN(duration) && duration > 0) {
                        track.duration = duration;
                        if (durationElement) {
                            durationElement.textContent = this.formatTime(duration);
                        }
                    }
                    tempSound.unload();
                },
                onloaderror: () => {
                    if (durationElement) {
                        durationElement.textContent = 'N/A';
                    }
                    tempSound.unload();
                }
            });
        } catch (error) {
            if (durationElement) {
                durationElement.textContent = 'N/A';
            }
        }
    }
    
    async loadTrackMetadata(track, artistElement) {
        const defaultArtist = 'Неизвестный исполнитель';
        try {
            const result = await window.electronAPI.getAudioMetadata(track.path);
            const artist = result?.success && result.data?.artist
                ? (Array.isArray(result.data.artist) ? result.data.artist.join(', ') : result.data.artist)
                : defaultArtist;
            track.artist = artist;
        } catch (error) {
            track.artist = defaultArtist;
        }
        
        if (artistElement) {
            artistElement.textContent = track.artist;
        }
    }

    loadTrack(index) {
        if (index < 0 || index >= this.playlistTracks.length) return;
        
        this.currentTrackIndex = index;
        const track = this.playlistTracks[index];
        
        this.stopMusic();
        
        this.musicPlayer = new Howl({
            src: [track.path],
            html5: true,
            volume: this.musicVolume,
            loop: this.playbackMode === 'loop',
            onplay: () => {
                this.resumeAudioContext();
                setTimeout(() => this.connectHowlToAnalyser(this.musicPlayer, 'music'), 0);
                this.isPlaying = true;
                this.isPaused = false;
                this.updateStatus(`Воспроизведение: ${track.name}`);
                this.startProgressTracking();
                this.updateVuMeters();
            },
            onpause: () => {
                this.isPaused = true;
                this.updateStatus('Пауза');
            },
            onstop: () => {
                this.isPlaying = false;
                this.isPaused = false;
                this.updateStatus('Остановлено');
                this.stopProgressTracking();
            },
            onend: () => {
                this.handleTrackEnd();
            },
            onload: () => {
                this.connectHowlToAnalyser(this.musicPlayer, 'music');
                this.updateTimeDisplays();
            },
            onloaderror: (id, error) => {
                this.updateStatus('Ошибка загрузки трека', 'error');
            },
            onplayerror: (id, error) => {
                this.updateStatus('Ошибка воспроизведения', 'error');
                if (this.playbackMode === 'sequential') {
                    setTimeout(() => this.nextTrack(), 1000);
                }
            }
        });
        
        const currentTrackEl = document.getElementById('currentTrack');
        if (currentTrackEl) {
            currentTrackEl.textContent = track.name;
        }
        
        this.updateMediaSessionMetadata(track.name);
        this.highlightCurrentTrack();
    }

    handleTrackEnd() {
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
        if (index !== this.currentTrackIndex) {
            this.loadTrack(index);
        }
        this.playMusic();
    }

    playMusic() {
        this.resumeAudioContext();
        if (this.musicPlayer && !this.isPlaying) {
            this.musicPlayer.play();
        } else if (this.musicPlayer && this.isPaused) {
            this.musicPlayer.play();
            this.isPaused = false;
        }
    }

    pauseMusic() {
        if (this.musicPlayer && this.isPlaying && !this.isPaused) {
            this.musicPlayer.pause();
        }
    }

    stopMusic() {
        if (this.musicPlayer) {
            try {
                this.musicPlayer.unload(); // unload вместо stop для освобождения памяти
            } catch (e) {
                console.warn('Ошибка при выгрузке:', e);
            }
            this.musicPlayer = null;
        }
        this.isPlaying = false;
        this.isPaused = false;
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
            const isActive = index === this.currentTrackIndex;
            track.classList.toggle('active', isActive);
            
            if (isActive) {
                track.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
        this.updateTrackCounter();
    }

    startProgressTracking() {
        const updateProgress = () => {
            if (this.musicPlayer && this.isPlaying && !this.isPaused) {
                const seek = this.musicPlayer.seek();
                const duration = this.musicPlayer.duration();
                
                if (duration > 0 && !isNaN(seek) && !isNaN(duration)) {
                    const progress = Math.min(100, Math.max(0, (seek / duration) * 100));
                    const progressBar = document.getElementById('progressBar');
                    if (progressBar) {
                        progressBar.value = progress;
                    }
                    
                    const now = Date.now();
                    if (!this.lastTimeUpdate || now - this.lastTimeUpdate >= 250) {
                        this.updateTimeDisplays();
                        this.lastTimeUpdate = now;
                    }
                }
            }
            
            if (this.isPlaying && !this.isPaused) {
                this.progressAnimationFrame = requestAnimationFrame(updateProgress);
            }
        };
        
        this.progressAnimationFrame = requestAnimationFrame(updateProgress);
    }

    updateTimeDisplays() {
        if (this.musicPlayer) {
            try {
                const seek = this.musicPlayer.seek();
                const duration = this.musicPlayer.duration();
                
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

    stopProgressTracking() {
        if (this.progressAnimationFrame) {
            cancelAnimationFrame(this.progressAnimationFrame);
            this.progressAnimationFrame = null;
        }
        
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
        if (isNaN(seconds)) return '0:00';
        
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
            
            const soundName = this.soundEffects.get(index)?.name || `Пад ${index + 1}`;
            document.getElementById('padStatus').textContent = `Выбран: ${soundName}`;
        }
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

    async assignSound(padIndex, filePath) {
        try {
            const fileName = filePath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "");
            
            this.soundEffects.set(padIndex, {
                sound: null,
                name: fileName,
                path: filePath
            });

            const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
            if (pad) {
                const displayName = fileName.length > 12 ? fileName.substring(0, 12) + '...' : fileName;
                pad.textContent = displayName;
                pad.title = fileName;
            }

            this.updateStatus(`Звук "${fileName}" назначен на пад ${padIndex + 1}`, 'success');
            this.saveStoredData();
        } catch (error) {
            this.updateStatus('Ошибка назначения звука', 'error');
        }
    }

    playSoundEffect(padIndex) {
        const soundData = this.soundEffects.get(padIndex);
        if (!soundData || !soundData.path) {
            this.updateStatus('Пад не настроен', 'warning');
            return;
        }

        const playSound = (sound, soundData, pad) => {
            try {
                this.resumeAudioContext();
                const soundId = sound.play();
                setTimeout(() => this.connectHowlToAnalyser(sound, 'effects'), 0);
                const duration = sound.duration();
                
                if (pad) {
                    pad.classList.add('playing');
                }
                
                if (duration && duration > 0) {
                    this.startPadProgress(padIndex, duration);
                }
                
                if (soundId !== undefined) {
                    sound.once('end', () => {
                        this.stopPadProgress(padIndex);
                        if (pad) pad.classList.remove('playing');
                    }, soundId);
                } else if (duration && duration > 0) {
                    setTimeout(() => {
                        this.stopPadProgress(padIndex);
                        if (pad) pad.classList.remove('playing');
                    }, duration * 1000 + 100);
                }
                
                this.updateStatus(`Эффект: ${soundData.name}`, 'success');
            } catch (error) {
                this.stopPadProgress(padIndex);
                if (pad) pad.classList.remove('playing');
                this.updateStatus('Ошибка воспроизведения эффекта', 'error');
            }
        };

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        this.animatePadPress(pad);

        if (soundData.sound) {
            playSound(soundData.sound, soundData, pad);
        } else {
            this.updateStatus(`Загрузка: ${soundData.name}...`);
            const sound = new Howl({
                src: [soundData.path],
                volume: this.effectsVolume,
                html5: true,
                onload: () => {
                    soundData.sound = sound;
                    this.connectHowlToAnalyser(sound, 'effects');
                    this.updateStatus(`Готово: ${soundData.name}`);
                    playSound(sound, soundData, pad);
                },
                onloaderror: (id, error) => {
                    this.updateStatus(`Ошибка загрузки: ${soundData.name}`, 'error');
                },
                onplayerror: (id, error) => {
                    this.updateStatus('Ошибка воспроизведения эффекта', 'error');
                }
            });
        }
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
            if (soundData?.sound) {
                try {
                    soundData.sound.stop();
                    soundData.sound.unload();
                } catch (error) {}
            }
            
            this.stopPadProgress(padIndex);
            this.soundEffects.delete(padIndex);
            const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
            if (pad) {
                pad.textContent = padIndex + 1;
                pad.title = '';
                pad.classList.remove('selected', 'playing');
                const progressBar = pad.querySelector('.pad-progress-bar');
                if (progressBar) {
                    progressBar.remove();
                }
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
            if (soundData?.sound) {
                try {
                    soundData.sound.stop();
                    this.stopPadProgress(padIndex);
                    stoppedCount++;
                } catch (error) {}
            }
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
        const tagName = event.target?.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || event.target?.isContentEditable) return;

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
                    Numpad9: 8
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

    enablePadRenaming() {
        const grid = document.getElementById('soundPadsGrid');
        if (!grid) return;
        grid.querySelectorAll('.sound-pad').forEach((pad, idx) => {
            pad.addEventListener('dblclick', async () => {
                const current = this.soundEffects.get(idx)?.name || '';
                const name = prompt('Название для пэда:', current);
                if (name !== null) {
                    const data = this.soundEffects.get(idx) || {};
                    data.name = name || current || `Пад ${idx + 1}`;
                    this.soundEffects.set(idx, data);
                    const displayName = data.name.length > 12 ? data.name.substring(0, 12) + '...' : data.name;
                    pad.textContent = displayName || (idx + 1);
                    pad.title = data.name;
                    this.saveStoredData();
                }
            });
        });
    }

    saveStoredData() {
        const data = {
            soundEffects: Array.from(this.soundEffects.entries()).map(([index, soundData]) => ({
                index,
                name: soundData.name,
                path: soundData.path
            })),
            musicVolume: this.musicVolume,
            effectsVolume: this.effectsVolume,
            playbackMode: this.playbackMode
        };
        localStorage.setItem('theatreSoundMixer', JSON.stringify(data));
    }

    async loadStoredData() {
        try {
            const stored = localStorage.getItem('theatreSoundMixer');
            if (stored) {
                const data = JSON.parse(stored);
                
                this.musicVolume = data.musicVolume || 0.7;
                this.effectsVolume = data.effectsVolume || 0.7;
                this.playbackMode = data.playbackMode || 'sequential';
                
                document.getElementById('musicVolume').value = this.musicVolume * 100;
                document.getElementById('effectsVolume').value = this.effectsVolume * 100;
                document.getElementById('musicVolumeValue').textContent = `${Math.round(this.musicVolume * 100)}%`;
                document.getElementById('effectsVolumeValue').textContent = `${Math.round(this.effectsVolume * 100)}%`;
                
                const playbackModeInput = document.querySelector(`input[name="playbackMode"][value="${this.playbackMode}"]`);
                if (playbackModeInput) {
                    playbackModeInput.checked = true;
                }
                
                if (data.soundEffects) {
                    for (const effect of data.soundEffects) {
                        await this.assignSound(effect.index, effect.path);
                    }
                }
            }
        } catch (error) {}
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
            pad.textContent = i + 1;
            pad.dataset.index = i;
            pad.dataset.key = i + 1;
            
            pad.addEventListener('click', () => this.playSoundEffect(i));
            pad.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.selectPad(i);
            });
            
            grid.appendChild(pad);
        }
        this.enablePadRenaming();
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
    
    updateMediaSessionMetadata(trackName) {
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: trackName || 'Theatre Sound Mixer',
                    artist: 'Concert Audio System',
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
        const minutes = parseInt(document.getElementById('countdownMinutes').value) || 0;
        const seconds = parseInt(document.getElementById('countdownSeconds').value) || 0;
        
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
