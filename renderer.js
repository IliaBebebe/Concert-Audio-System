class TheatreSoundMixer {
    constructor() {
        this.musicPlayer = null;
        this.soundEffects = new Map();
        this.currentPlaylist = null;
        this.currentTrackIndex = 0;
        this.playlistTracks = [];
        this.selectedPad = null;
        this.isPlaying = false;
        this.isPaused = false;
        
        // Режимы воспроизведения
        this.playbackMode = 'sequential';
        
        this.musicVolume = 0.7;
        this.effectsVolume = 0.7;
        
        this.config = null;
        
        // Оптимизация производительности
        this.progressAnimationFrame = null;
        this.progressInterval = null;
        this.lastTimeUpdate = null;
        this.statusUpdateTimeout = null;
        
        // Debouncing для обновления громкости
        this.volumeUpdateTimeout = null;
        
        // Интервал для часов
        this.clockInterval = null;
        
        // Web Audio API для реальных VU-метров
        this.audioContext = null;
        this.musicAnalyser = null;
        this.effectsAnalyser = null;
        this.musicGainNode = null;
        this.effectsGainNode = null;
        this.musicSourceNode = null;
        this.effectsSourceNodes = new Map(); // Map<padIndex, sourceNode>
        
        // Прогресс падов
        this.padProgressIntervals = new Map(); // Map<padIndex, intervalId>
        
        // История воспроизведения
        this.playHistory = [];
        this.maxHistoryItems = 20;
        
        // Статистика сессии
        this.tracksPlayedCount = 0;
        this.sessionStartTime = Date.now();
        this.sessionTimeInterval = null;
        
        // Таймер обратного отсчета
        this.countdownTime = 0;
        this.countdownInterval = null;
        this.isCountdownRunning = false;
        
        // Обработчик видимости страницы для оптимизации
        this.setupVisibilityHandlers();
        
        this.initializeApp();
    }
    
    setupVisibilityHandlers() {
        // Оптимизация: снижаем частоту обновлений когда окно не видно
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Когда окно скрыто, можно приостановить некоторые обновления
                // Но не останавливаем аудио - оно должно продолжать играть
            } else {
                // Когда окно видно, обновляем интерфейс
                this.updateTimeDisplays();
            }
        });
    }
    
    initWebAudio() {
        try {
            // Пытаемся использовать Web Audio API для реальных VU-метров
            // Howler.js использует свой AudioContext, но мы можем создать отдельный для анализа
            // или использовать общий контекст через Howler.ctx
            if (typeof Howl !== 'undefined' && Howl.ctx) {
                // Используем AudioContext от Howler.js если доступен
                this.audioContext = Howl.ctx;
            } else {
                // Создаем новый AudioContext
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            // Создаем AnalyserNode для музыки
            this.musicAnalyser = this.audioContext.createAnalyser();
            this.musicAnalyser.fftSize = 256;
            this.musicAnalyser.smoothingTimeConstant = 0.8;
            
            // Создаем AnalyserNode для эффектов
            this.effectsAnalyser = this.audioContext.createAnalyser();
            this.effectsAnalyser.fftSize = 256;
            this.effectsAnalyser.smoothingTimeConstant = 0.8;
            
            // Создаем GainNode для музыки (для подключения к destination)
            this.musicGainNode = this.audioContext.createGain();
            this.musicGainNode.gain.value = this.musicVolume;
            
            // Создаем GainNode для эффектов
            this.effectsGainNode = this.audioContext.createGain();
            this.effectsGainNode.gain.value = this.effectsVolume;
            
            // Примечание: реальное подключение аудио-источников к AnalyserNode
            // будет происходить динамически при воспроизведении
        } catch (error) {
            console.warn('Web Audio API not available, using fallback VU meters:', error);
            this.audioContext = null;
        }
    }

    setupResizers() {
        const appContainer = document.querySelector('.app-container');
        const centerPanel = document.querySelector('.center-panel');
        if (!appContainer || !centerPanel) return;
        
        const minLeft = 260;
        const minRight = 260;
        const minTracks = 180;
        const minPads = 120;
        const resizerSize = 6; // должен совпадать с CSS
        
        const applyInitialSizes = () => {
            try {
                const saved = JSON.parse(localStorage.getItem('tsmLayout') || '{}');
                if (saved.leftWidth) appContainer.style.setProperty('--left-width', `${saved.leftWidth}px`);
                if (saved.rightWidth) appContainer.style.setProperty('--right-width', `${saved.rightWidth}px`);
                if (saved.tracksHeight) centerPanel.style.setProperty('--tracks-height', `${saved.tracksHeight}px`);
                if (saved.padsHeight) centerPanel.style.setProperty('--pads-height', `${saved.padsHeight}px`);
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
            const centerRect = centerPanel.getBoundingClientRect();
            
            const onMove = (ev) => {
                if (type === 'left') {
                    let x = ev.clientX - rect.left;
                    const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 450;
                    const total = rect.width;
                    const maxLeft = total - rightWidth - resizerSize - 300; // минимум для центра
                    x = Math.max(minLeft, Math.min(maxLeft, x));
                    appContainer.style.setProperty('--left-width', `${x}px`);
                } else if (type === 'right') {
                    let x = rect.right - ev.clientX;
                    const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 450;
                    const total = rect.width;
                    const maxRight = total - leftWidth - resizerSize - 300;
                    x = Math.max(minRight, Math.min(maxRight, x));
                    appContainer.style.setProperty('--right-width', `${x}px`);
                } else if (type === 'center') {
                    let y = ev.clientY - centerRect.top;
                    const totalH = centerRect.height;
                    const maxTracks = totalH - resizerSize - minPads;
                    y = Math.max(minTracks, Math.min(maxTracks, y));
                    centerPanel.style.setProperty('--tracks-height', `${y}px`);
                }
            };
            
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 0;
                const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 0;
                const tracksHeight = parseFloat(getComputedStyle(centerPanel).getPropertyValue('--tracks-height')) || 0;
                const sizes = {};
                if (leftWidth) sizes.leftWidth = leftWidth;
                if (rightWidth) sizes.rightWidth = rightWidth;
                if (tracksHeight) sizes.tracksHeight = tracksHeight;
                saveSizes(sizes);
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        
        document.querySelectorAll('.resizer.vertical').forEach(el => {
            const type = el.dataset.resizer;
            el.addEventListener('mousedown', (e) => startDrag(type, e));
        });
        
        const centerResizer = document.querySelector('.resizer.horizontal[data-resizer="center"]');
        if (centerResizer) {
            centerResizer.addEventListener('mousedown', (e) => startDrag('center', e));
        }
        
        window.addEventListener('resize', () => {
            const rect = appContainer.getBoundingClientRect();
            const leftWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--left-width')) || 450;
            const rightWidth = parseFloat(getComputedStyle(appContainer).getPropertyValue('--right-width')) || 450;
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

    async initializeApp() {
        // Сначала загружаем конфигурацию
        await this.loadConfig();
        
        this.setupEventListeners();
        this.createSoundPads();
        this.setupResizers();
        this.initWebAudio();
        this.startClock();
        this.startSessionStats();
        this.updateCountdownDisplay(); // Инициализация отображения таймера
        await this.loadStoredData();
        
        // Если это первый запуск или папка не настроена, показываем настройку
        if (this.config.firstRun || !this.config.musicFolder) {
            await this.showFirstTimeSetup();
        } else {
            await this.refreshPlaylists();
        }
    }

    async loadConfig() {
        try {
            this.config = await window.electronAPI.getConfig();
        } catch (error) {
            console.error('Error loading config:', error);
            this.config = { firstRun: true, musicFolder: null };
        }
    }

    setupEventListeners() {
        // Плейлисты
        document.getElementById('refreshPlaylists').addEventListener('click', () => this.refreshPlaylists());
        
        // Управление воспроизведением
        document.getElementById('playBtn').addEventListener('click', () => this.playMusic());
        document.getElementById('pauseBtn').addEventListener('click', () => this.pauseMusic());
        document.getElementById('stopBtn').addEventListener('click', () => this.stopMusic());
        document.getElementById('prevTrack').addEventListener('click', () => this.previousTrack());
        document.getElementById('nextTrack').addEventListener('click', () => this.nextTrack());
        
        // Быстрые кнопки: паника mute и блокировка UI
        const panicBtn = document.getElementById('panicMuteBtn');
        if (panicBtn) panicBtn.addEventListener('click', () => this.togglePanicMute());
        const lockBtn = document.getElementById('lockUiBtn');
        if (lockBtn) lockBtn.addEventListener('click', () => this.toggleUiLock());
        
        // Саунд-пады
        document.getElementById('assignSound').addEventListener('click', () => this.assignSoundToPad());
        document.getElementById('clearPad').addEventListener('click', () => this.clearSelectedPad());
        document.getElementById('stopAllEffects').addEventListener('click', () => this.stopAllEffects());
        
        // Громкость
        document.getElementById('musicVolume').addEventListener('input', (e) => this.setMusicVolume(e.target.value / 100));
        document.getElementById('effectsVolume').addEventListener('input', (e) => this.setEffectsVolume(e.target.value / 100));
        
        // Прогресс-бар
        document.getElementById('progressBar').addEventListener('input', (e) => this.seekMusic(e.target.value));
        
        // Поиск треков
        const searchInput = document.getElementById('trackSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.filterTracks(e.target.value));
        }
        
        // Таймер обратного отсчета
        const countdownStart = document.getElementById('countdownStart');
        const countdownStop = document.getElementById('countdownStop');
        const countdownReset = document.getElementById('countdownReset');
        if (countdownStart) countdownStart.addEventListener('click', () => this.startCountdown());
        if (countdownStop) countdownStop.addEventListener('click', () => this.stopCountdown());
        if (countdownReset) countdownReset.addEventListener('click', () => this.resetCountdown());
        
        // Режимы воспроизведения
        document.querySelectorAll('input[name="playbackMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.playbackMode = e.target.value;
                this.updateStatus(`Режим: ${this.getPlaybackModeName()}`);
                this.saveStoredData();
            });
        });
        
        // Горячие клавиши
        document.addEventListener('keydown', (e) => this.handleHotkeys(e));
        
        // Горячие клавиши для громкости (колесико мыши)
        document.addEventListener('wheel', (e) => this.handleVolumeWheel(e), { passive: false });
    }

    // Блокировка интерфейса / паника mute
    toggleUiLock() {
        this.uiLocked = !this.uiLocked;
        const btn = document.getElementById('lockUiBtn');
        if (btn) {
            btn.textContent = this.uiLocked ? '🔓 Разблокировать' : '🔒 Блокировка';
        }
        this.updateStatus(this.uiLocked ? 'Интерфейс заблокирован' : 'Интерфейс разблокирован');
    }

    togglePanicMute() {
        this.isMuted = !this.isMuted;
        if (this.musicPlayer) {
            try {
                this.musicPlayer.mute(this.isMuted);
            } catch {}
        }
        this.soundEffects.forEach(sd => {
            if (sd && sd.sound) {
                try { sd.sound.mute(this.isMuted); } catch {}
            }
        });
        const btn = document.getElementById('panicMuteBtn');
        if (btn) {
            btn.textContent = this.isMuted ? '🔈 Unmute' : '🔇 Mute (паника)';
        }
        this.updateStatus(this.isMuted ? 'Звук выключен (паника)' : 'Звук включен');
    }

    // Поиск/фильтр треков
    filterTracks(query) {
        this.trackFilterQuery = (query || '').toLowerCase().trim();
        this.displayTracks(); // перерисуем список
    }

    // Настройка при первом запуске
    async showFirstTimeSetup() {
        const container = document.getElementById('playlistsContainer');
        container.innerHTML = `
            <div class="first-time-setup">
                <div class="setup-header">
                    <h3>🎵 Добро пожаловать в Theatre Sound Mixer!</h3>
                    <p>Для начала работы выберите папку с вашей музыкой</p>
                </div>
                <div class="setup-content">
                    <p>В этой папке должны находиться плейлисты (подпапки) с аудиофайлами.</p>
                    <p><strong>Структура папки:</strong></p>
                    <div class="folder-example">
                        <strong>Ваша_папка/</strong>
                        <div class="folder-structure">
                            ├── <strong>Плейлист 1/</strong><br>
                            │   ├── трек1.mp3<br>
                            │   └── трек2.mp3<br>
                            └── <strong>Плейлист 2/</strong><br>
                                ├── песня1.wav<br>
                                └── песня2.mp3
                        </div>
                    </div>
                    <button class="setup-btn" id="selectFolderBtn">📁 Выбрать папку с музыкой</button>
                </div>
            </div>
        `;
        
        document.getElementById('selectFolderBtn').addEventListener('click', () => this.setupMusicFolder());
        this.updateStatus('Настройте папку с музыкой для начала работы');
    }

    async setupMusicFolder() {
        try {
            this.updateStatus('Выбор папки с музыкой...');
            const result = await window.electronAPI.selectMusicFolder();
            
            if (result.success) {
                // Сохраняем путь
                const saveResult = await window.electronAPI.setMusicFolder(result.path);
                
                if (saveResult.success) {
                    await this.loadConfig();
                    this.updateStatus(`Папка настроена: ${result.path}`);
                    await this.refreshPlaylists();
                } else {
                    throw new Error('Ошибка сохранения настроек');
                }
            } else {
                this.updateStatus('Папка не выбрана');
            }
        } catch (error) {
            this.updateStatus('Ошибка настройки папки');
            console.error('Error setting up music folder:', error);
        }
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
            console.error('Error changing music folder:', error);
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
                if (result.needsSetup) {
                    this.displayNeedsSetup(result.error);
                } else {
                    this.displayPlaylistError(result.error);
                }
            }
        } catch (error) {
            this.displayPlaylistError(error.message);
        }
    }

    displayNoPlaylists() {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.config.musicFolder ? this.config.musicFolder.split(/[\\/]/).pop() : 'папке';
        
        container.innerHTML = `
            <div class="no-playlists">
                <p>🎵 Плейлисты не найдены</p>
                <p class="hint">В ${folderName} нет плейлистов (подпапок с музыкой)</p>
                <p class="hint">Создайте подпапки с музыкой или выберите другую папку</p>
                <button class="action-btn" id="changeFolderBtn">📁 Изменить папку с музыкой</button>
            </div>
        `;
        
        document.getElementById('changeFolderBtn').addEventListener('click', () => this.changeMusicFolder());
        this.updateStatus('Плейлисты не найдены в текущей папке');
    }

    displayNeedsSetup(error) {
        const container = document.getElementById('playlistsContainer');
        container.innerHTML = `
            <div class="needs-setup">
                <p>⚠️ ${error}</p>
                <p class="hint">Необходимо настроить папку с музыкой</p>
                <button class="action-btn" id="setupNowBtn">⚙️ Настроить сейчас</button>
            </div>
        `;
        
        document.getElementById('setupNowBtn').addEventListener('click', () => this.showFirstTimeSetup());
        this.updateStatus(`Требуется настройка: ${error}`);
    }

    displayPlaylistError(error) {
        const container = document.getElementById('playlistsContainer');
        container.innerHTML = `
            <div class="playlist-error">
                <p>❌ Ошибка загрузки плейлистов</p>
                <p class="error-detail">${error}</p>
                <button class="action-btn" id="retryBtn">🔄 Повторить</button>
                <button class="action-btn" id="changeFolderBtn2">📁 Изменить папку</button>
            </div>
        `;
        
        document.getElementById('retryBtn').addEventListener('click', () => this.refreshPlaylists());
        document.getElementById('changeFolderBtn2').addEventListener('click', () => this.changeMusicFolder());
        this.updateStatus(`Ошибка: ${error}`);
    }

    displayPlaylists(playlists) {
        const container = document.getElementById('playlistsContainer');
        const folderName = this.config.musicFolder ? this.config.musicFolder.split(/[\\/]/).pop() : 'Неизвестная папка';
        
        container.innerHTML = `
            <div class="current-folder">
                <span class="folder-path">📁 ${folderName}</span>
                <button class="folder-change-btn" id="changeMusicFolderSmall">✏️</button>
            </div>
        `;
        
        playlists.forEach(playlist => {
            const btn = document.createElement('button');
            btn.className = 'playlist-btn';
            btn.innerHTML = `🎵 ${playlist.name} <small>(${playlist.trackCount} треков)</small>`;
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
            console.error('Error loading playlist:', error);
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

        list.forEach(({ t: track, i: index }) => {
            const btn = document.createElement('button');
            btn.className = 'track-btn';
            if (index === this.currentTrackIndex) {
                btn.classList.add('active');
            }
            
            // Создаем структуру с названием, автором и длительностью
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
            container.appendChild(btn);
            
            // Загружаем длительность трека асинхронно, если еще не загружена
            if (!track.duration) {
                this.loadTrackDuration(track, trackDuration);
            }
            
            // Загружаем метаданные (автора) асинхронно, если еще не загружены
            if (!track.artist) {
                this.loadTrackMetadata(track, trackArtist);
            }
        });
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
            console.warn('Could not load track duration:', error);
            if (durationElement) {
                durationElement.textContent = 'N/A';
            }
        }
    }
    
    async loadTrackMetadata(track, artistElement) {
        try {
            const result = await window.electronAPI.getAudioMetadata(track.path);
            if (result.success && result.data) {
                const artist = result.data.artist;
                if (artist) {
                    track.artist = Array.isArray(artist) ? artist.join(', ') : artist;
                    if (artistElement) {
                        artistElement.textContent = track.artist;
                    }
                } else {
                    track.artist = 'Неизвестный исполнитель';
                    if (artistElement) {
                        artistElement.textContent = track.artist;
                    }
                }
            } else {
                track.artist = 'Неизвестный исполнитель';
                if (artistElement) {
                    artistElement.textContent = track.artist;
                }
            }
        } catch (error) {
            console.warn('Could not load track metadata:', error);
            track.artist = 'Неизвестный исполнитель';
            if (artistElement) {
                artistElement.textContent = track.artist;
            }
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
                this.isPlaying = true;
                this.isPaused = false;
                this.updateStatus(`Воспроизведение: ${track.name}`);
                this.startProgressTracking();
                this.addToHistory(track);
                this.tracksPlayedCount++;
                this.updateTracksPlayedCount();
                
                // Подключаем к Web Audio API для реальных VU-метров
                this.connectMusicToWebAudio();
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
                this.disconnectMusicFromWebAudio();
            },
            onend: () => {
                this.handleTrackEnd();
            },
            onload: () => {
                this.updateTimeDisplays();
            },
            onloaderror: (id, error) => {
                this.updateStatus('Ошибка загрузки трека', 'error');
                console.error('Load error:', error);
            },
            onplayerror: (id, error) => {
                this.updateStatus('Ошибка воспроизведения', 'error');
                console.error('Play error:', error);
                // Пытаемся перейти к следующему треку при ошибке
                if (this.playbackMode === 'sequential') {
                    setTimeout(() => this.nextTrack(), 1000);
                }
            }
        });
        
        const currentTrackEl = document.getElementById('currentTrack');
        if (currentTrackEl) {
            currentTrackEl.textContent = track.name;
        }
        
        // Обновляем метаданные Media Session
        this.updateMediaSessionMetadata(track.name);
        
        this.highlightCurrentTrack();
    }
    
    connectMusicToWebAudio() {
        if (!this.audioContext || !this.musicAnalyser || !this.musicPlayer) return;
        
        try {
            // Howler.js использует Web Audio API через свой AudioContext
            // Пытаемся получить доступ к источнику звука
            // Примечание: Howler.js может использовать HTML5 audio или Web Audio API
            // Для реальных VU-метров нужно подключиться к реальному аудио-потоку
            
            // Если Howler использует Web Audio API, получаем источник
            if (this.musicPlayer._sounds && this.musicPlayer._sounds.length > 0) {
                const sound = this.musicPlayer._sounds[0];
                // Пытаемся получить Web Audio источник
                if (sound._node && sound._node.bufferSource) {
                    // Подключаем к нашему AnalyserNode для анализа
                    try {
                        sound._node.bufferSource.connect(this.musicAnalyser);
                        this.musicAnalyser.connect(this.audioContext.destination);
                        this.musicSourceNode = sound._node.bufferSource;
                    } catch (e) {
                        // Если не получается подключить напрямую, используем fallback
                        console.log('Using fallback VU meter for music');
                    }
                }
            }
        } catch (error) {
            console.warn('Could not connect music to Web Audio API, using fallback:', error);
        }
    }
    
    disconnectMusicFromWebAudio() {
        if (this.musicSourceNode) {
            try {
                this.musicSourceNode.disconnect();
            } catch (e) {
                // Игнорируем ошибки отключения
            }
            this.musicSourceNode = null;
        }
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
            this.musicPlayer.stop();
            this.musicPlayer = null;
        }
        this.isPlaying = false;
        this.isPaused = false;
    }

    previousTrack() {
        if (this.playlistTracks.length === 0) return;
        
        let newIndex = this.currentTrackIndex - 1;
        if (newIndex < 0) {
            newIndex = this.playlistTracks.length - 1;
        }
        this.playTrack(newIndex);
    }

    nextTrack() {
        if (this.playlistTracks.length === 0) return;
        
        let newIndex = this.currentTrackIndex + 1;
        if (newIndex >= this.playlistTracks.length) {
            newIndex = 0;
        }
        this.playTrack(newIndex);
    }

    highlightCurrentTrack() {
        const tracks = document.querySelectorAll('.track-btn');
        tracks.forEach((track, index) => {
            const isActive = index === this.currentTrackIndex;
            track.classList.toggle('active', isActive);
            
            // Прокручиваем к активному треку
            if (isActive) {
                track.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
        this.updateTrackCounter();
    }

    startProgressTracking() {
        // Используем requestAnimationFrame для более плавного обновления
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
                    
                    // Обновляем время только каждые 250ms для оптимизации
                    const now = Date.now();
                    if (!this.lastTimeUpdate || now - this.lastTimeUpdate >= 250) {
                        this.updateTimeDisplays();
                        this.lastTimeUpdate = now;
                    }
                }
            }
            
            // Обновляем VU-метры
            this.updateVuMeters();
            
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
            } catch (error) {
                console.warn('Error updating time displays:', error);
            }
        }
    }

    stopProgressTracking() {
        if (this.progressAnimationFrame) {
            cancelAnimationFrame(this.progressAnimationFrame);
            this.progressAnimationFrame = null;
        }
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        
        const progressBar = document.getElementById('progressBar');
        const currentTimeDisplay = document.getElementById('currentTimeDisplay');
        const totalTimeDisplay = document.getElementById('totalTimeDisplay');
        
        if (progressBar) progressBar.value = 0;
        if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
        if (totalTimeDisplay) totalTimeDisplay.textContent = '0:00';
        
        this.lastTimeUpdate = null;
        
        // Сбрасываем VU-метры
        this.updateVuMeters();
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
                console.error('Error seeking music:', error);
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

    // Саунд-пады
    selectPad(index) {
        document.querySelectorAll('.sound-pad').forEach(pad => {
            pad.classList.remove('selected');
        });
        
        const pad = document.querySelector(`.sound-pad[data-index="${index}"]`);
        pad.classList.add('selected');
        
        this.selectedPad = index;
        
        const soundName = this.soundEffects.get(index)?.name || `Пад ${index + 1}`;
        document.getElementById('padStatus').textContent = `Выбран: ${soundName}`;
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
            console.error('Error selecting file:', error);
        }
    }

    async assignSound(padIndex, filePath) {
        try {
            const fileName = filePath.split(/[\\/]/).pop().replace(/\.[^/.]+$/, "");
            
            // Просто сохраняем информацию о звуке, но не загружаем его
            this.soundEffects.set(padIndex, {
                sound: null, // Загрузим при первом воспроизведении
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
            console.error('Error assigning sound:', error);
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
                const soundId = sound.play();
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
                console.error('Error playing sound effect:', error);
                this.stopPadProgress(padIndex);
                if (pad) pad.classList.remove('playing');
                this.updateStatus('Ошибка воспроизведения эффекта', 'error');
            }
        };

        const pad = document.querySelector(`.sound-pad[data-index="${padIndex}"]`);
        this.animatePadPress(pad);

        if (soundData.sound) {
            // Звук уже загружен, просто воспроизводим
            playSound(soundData.sound, soundData, pad);
        } else {
            // Загружаем звук при первом воспроизведении
            this.updateStatus(`Загрузка: ${soundData.name}...`);
            const sound = new Howl({
                src: [soundData.path],
                volume: this.effectsVolume,
                html5: true,
                onload: () => {
                    soundData.sound = sound; // Сохраняем загруженный звук
                    this.updateStatus(`Готово: ${soundData.name}`);
                    playSound(sound, soundData, pad);
                },
                onloaderror: (id, error) => {
                    this.updateStatus(`Ошибка загрузки: ${soundData.name}`, 'error');
                    console.error('Sound load error:', error);
                },
                onplayerror: (id, error) => {
                    this.updateStatus('Ошибка воспроизведения эффекта', 'error');
                    console.error('Sound play error:', error);
                }
            });
        }
    }
    
    startPadProgress(padIndex, duration) {
        // Останавливаем предыдущий интервал если есть
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
            
            // Обновляем прогресс-бар
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
        
        const intervalId = setInterval(updateProgress, 50); // Обновляем каждые 50ms
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
        // Пад просто становится зеленым, без уменьшения
        // Функция оставлена для возможных будущих анимаций
    }

    clearSelectedPad() {
        if (this.selectedPad !== null) {
            const padIndex = this.selectedPad;
            const soundData = this.soundEffects.get(padIndex);
            if (soundData && soundData.sound) {
                try {
                    soundData.sound.stop();
                    soundData.sound.unload();
                } catch (error) {
                    console.warn('Error unloading sound:', error);
                }
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
            if (soundData && soundData.sound) {
                try {
                    soundData.sound.stop();
                    this.stopPadProgress(padIndex);
                    stoppedCount++;
                } catch (error) {
                    console.error('Error stopping sound effect:', error);
                }
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

    // Громкость с debouncing для оптимизации
    setMusicVolume(volume) {
        this.musicVolume = volume;
        
        // Обновляем отображение сразу
        const volumeValueEl = document.getElementById('musicVolumeValue');
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }
        
        // Обновляем GainNode для Web Audio API
        if (this.musicGainNode) {
            try {
                this.musicGainNode.gain.value = volume;
            } catch (error) {
                console.warn('Error setting music gain node:', error);
            }
        }
        
        // Применяем громкость с небольшой задержкой для плавности
        if (this.volumeUpdateTimeout) {
            clearTimeout(this.volumeUpdateTimeout);
        }
        
        this.volumeUpdateTimeout = setTimeout(() => {
            if (this.musicPlayer) {
                try {
                    this.musicPlayer.volume(volume);
                } catch (error) {
                    console.error('Error setting music volume:', error);
                }
            }
            this.saveStoredData();
        }, 50);
    }

    setEffectsVolume(volume) {
        this.effectsVolume = volume;
        
        // Обновляем отображение сразу
        const volumeValueEl = document.getElementById('effectsVolumeValue');
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }
        
        // Обновляем GainNode для Web Audio API
        if (this.effectsGainNode) {
            try {
                this.effectsGainNode.gain.value = volume;
            } catch (error) {
                console.warn('Error setting effects gain node:', error);
            }
        }
        
        // Применяем громкость с задержкой
        if (this.volumeUpdateTimeout) {
            clearTimeout(this.volumeUpdateTimeout);
        }
        
        this.volumeUpdateTimeout = setTimeout(() => {
            this.soundEffects.forEach(soundData => {
                if (soundData && soundData.sound) {
                    try {
                        soundData.sound.volume(volume);
                    } catch (error) {
                        console.error('Error setting effect volume:', error);
                    }
                }
            });
            this.saveStoredData();
        }, 50);
    }

    // Режимы воспроизведения
    getPlaybackModeName() {
        switch (this.playbackMode) {
            case 'sequential': return 'Автоматически следующий';
            case 'loop': return 'Зациклить трек';
            case 'single': return 'Только текущий';
            default: return 'Неизвестно';
        }
    }

    // Горячие клавиши
    handleHotkeys(event) {
        if (event.target.tagName === 'INPUT') return;
        if (this.uiLocked && !['KeyL', 'KeyM', 'Escape'].includes(event.code)) {
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
            case 'KeyL':
                event.preventDefault();
                this.toggleUiLock();
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
                if (event.code.startsWith('Digit') || event.code.startsWith('Numpad')) {
                    const digit = parseInt(event.code.replace('Digit', '').replace('Numpad', ''));
                    if (digit >= 1 && digit <= 12) {
                        event.preventDefault();
                        this.playSoundEffect(digit - 1);
                    }
                }
                break;
        }
    }
    
    // Обработка колесика мыши для громкости
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
    
    // Обновление VU-метров с реальными данными из Web Audio API
    updateVuMeters() {
        const musicVuMeter = document.getElementById('musicVuMeter');
        if (musicVuMeter) {
            const musicVuBar = musicVuMeter.querySelector('.vu-bar');
            if (musicVuBar) {
                let level = 0;
                if (this.musicAnalyser && this.musicPlayer && this.isPlaying && !this.isPaused) {
                    try {
                        // Пытаемся получить реальные данные из AnalyserNode
                        const dataArray = new Uint8Array(this.musicAnalyser.frequencyBinCount);
                        this.musicAnalyser.getByteFrequencyData(dataArray);
                        
                        // Вычисляем средний уровень
                        let sum = 0;
                        let max = 0;
                        for (let i = 0; i < dataArray.length; i++) {
                            sum += dataArray[i];
                            if (dataArray[i] > max) max = dataArray[i];
                        }
                        // Используем комбинацию среднего и максимума для более реалистичного отображения
                        const average = sum / dataArray.length;
                        const combined = (average * 0.7 + max * 0.3) / 255;
                        // Нормализуем и применяем громкость
                        level = (this.isMuted ? 0 : Math.min(1, combined * 1.5)) * this.musicVolume;
                    } catch (error) {
                        // Fallback на старый метод если Web Audio API не работает
                        level = (this.isMuted ? 0 : this.musicVolume) * (0.7 + Math.random() * 0.3);
                    }
                } else {
                    level = 0;
                }
                musicVuBar.style.width = `${Math.min(100, level * 100)}%`;
            }
        }
        
        const effectsVuMeter = document.getElementById('effectsVuMeter');
        if (effectsVuMeter) {
            const effectsVuBar = effectsVuMeter.querySelector('.vu-bar');
            if (effectsVuBar) {
                let level = 0;
                if (this.effectsAnalyser) {
                    // Проверяем, играют ли какие-то эффекты
                    let isPlaying = false;
                    this.soundEffects.forEach(soundData => {
                        if (soundData && soundData.sound && soundData.sound.playing()) {
                            isPlaying = true;
                        }
                    });
                    
                    if (isPlaying) {
                        try {
                            const dataArray = new Uint8Array(this.effectsAnalyser.frequencyBinCount);
                            this.effectsAnalyser.getByteFrequencyData(dataArray);
                            
                            // Вычисляем средний уровень
                            let sum = 0;
                            let max = 0;
                            for (let i = 0; i < dataArray.length; i++) {
                                sum += dataArray[i];
                                if (dataArray[i] > max) max = dataArray[i];
                            }
                            const average = sum / dataArray.length;
                            const combined = (average * 0.7 + max * 0.3) / 255;
                            level = (this.isMuted ? 0 : Math.min(1, combined * 1.5)) * this.effectsVolume;
                        } catch (error) {
                            // Fallback на старый метод
                            level = (this.isMuted ? 0 : this.effectsVolume) * (0.7 + Math.random() * 0.3);
                        }
                    } else {
                        level = 0;
                    }
                } else {
                    // Fallback если Web Audio API не доступен
                    let isPlaying = false;
                    this.soundEffects.forEach(soundData => {
                        if (soundData && soundData.sound && soundData.sound.playing()) {
                            isPlaying = true;
                        }
                    });
                    level = isPlaying ? (this.isMuted ? 0 : this.effectsVolume) * (0.7 + Math.random() * 0.3) : 0;
                }
                effectsVuBar.style.width = `${Math.min(100, level * 100)}%`;
            }
        }
    }

    // Переименование падов по двойному клику
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

    // Сохранение/загрузка данных
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
        } catch (error) {
            console.error('Error loading stored data:', error);
        }
    }

    updateStatus(message, type = 'info') {
        const statusElement = document.getElementById('status');
        if (!statusElement) return;
        
        // Очищаем предыдущий таймаут
        if (this.statusUpdateTimeout) {
            clearTimeout(this.statusUpdateTimeout);
        }
        
        statusElement.textContent = message;
        statusElement.classList.add('pulse');
        
        // Добавляем класс типа статуса для разных стилей
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
        
        console.log(`Status [${type}]: ${message}`);
    }

    createSoundPads() {
        const grid = document.getElementById('soundPadsGrid');
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
        // Используем более точный интервал для часов
        this.clockInterval = setInterval(updateTime, 1000);
        
        // Интеграция с Media Session API для лучшей поддержки ОС
        this.setupMediaSession();
    }
    
    setupMediaSession() {
        // Media Session API поддерживается в Electron через Chromium
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                // Устанавливаем начальные метаданные
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Theatre Sound Mixer',
                    artist: 'Concert Audio System',
                    album: 'Sound Mixing'
                });
                
                // Обработчики действий медиа-сессии (глобальные горячие клавиши в ОС)
                try {
                    navigator.mediaSession.setActionHandler('play', () => {
                        this.playMusic();
                    });
                } catch (e) {
                    // Игнорируем если не поддерживается
                }
                
                try {
                    navigator.mediaSession.setActionHandler('pause', () => {
                        this.pauseMusic();
                    });
                } catch (e) {
                    // Игнорируем если не поддерживается
                }
                
                try {
                    navigator.mediaSession.setActionHandler('stop', () => {
                        this.stopMusic();
                        this.stopAllEffects();
                    });
                } catch (e) {
                    // Игнорируем если не поддерживается
                }
                
                try {
                    navigator.mediaSession.setActionHandler('previoustrack', () => {
                        this.previousTrack();
                    });
                } catch (e) {
                    // Игнорируем если не поддерживается
                }
                
                try {
                    navigator.mediaSession.setActionHandler('nexttrack', () => {
                        this.nextTrack();
                    });
                } catch (e) {
                    // Игнорируем если не поддерживается
                }
            } catch (error) {
                // Media Session API может быть не полностью поддерживаем в Electron
                console.log('Media Session API partially supported');
            }
        }
    }
    
    updateMediaSessionMetadata(trackName) {
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                // Создаем новый объект метаданных для обновления
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: trackName || 'Theatre Sound Mixer',
                    artist: 'Concert Audio System',
                    album: 'Sound Mixing'
                });
            } catch (error) {
                // Игнорируем ошибки обновления метаданных
                console.log('Could not update media session metadata');
            }
        }
    }
    
    // Счетчик треков
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
    
    // История воспроизведения
    addToHistory(track) {
        const historyItem = {
            name: track.name,
            artist: track.artist || 'Неизвестный исполнитель',
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        };
        
        this.playHistory.unshift(historyItem);
        if (this.playHistory.length > this.maxHistoryItems) {
            this.playHistory.pop();
        }
        
        this.updateHistoryDisplay();
    }
    
    updateHistoryDisplay() {
        const container = document.getElementById('historyContainer');
        if (!container) return;
        
        if (this.playHistory.length === 0) {
            container.innerHTML = '<div class="history-empty">История пуста</div>';
            return;
        }
        
        container.innerHTML = this.playHistory.map(item => {
            const displayName = item.name.length > 25 ? item.name.substring(0, 25) + '...' : item.name;
            return `
                <div class="history-item" title="${item.name}">
                    <div style="font-weight: 500;">${displayName}</div>
                    <div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">
                        ${item.artist} • ${item.time}
                    </div>
                </div>
            `;
        }).join('');
        
        // Добавляем обработчики клика для возврата к треку
        container.querySelectorAll('.history-item').forEach((item, index) => {
            item.addEventListener('click', () => {
                // Можно добавить логику поиска и воспроизведения трека из истории
                this.updateStatus(`История: ${this.playHistory[index].name}`);
            });
        });
    }
    
    // Таймер обратного отсчета
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
                // Можно добавить звуковой сигнал
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
    
    // Статистика сессии
    startSessionStats() {
        this.updateSessionTime();
        this.sessionTimeInterval = setInterval(() => {
            this.updateSessionTime();
        }, 1000);
    }
    
    updateSessionTime() {
        const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
        const hours = Math.floor(elapsed / 3600);
        const minutes = Math.floor((elapsed % 3600) / 60);
        const seconds = elapsed % 60;
        
        const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        const sessionTimeEl = document.getElementById('sessionTime');
        if (sessionTimeEl) {
            sessionTimeEl.textContent = timeString;
        }
    }
    
    updateTracksPlayedCount() {
        const countEl = document.getElementById('tracksPlayedCount');
        if (countEl) {
            countEl.textContent = this.tracksPlayedCount;
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
        // Останавливаем все воспроизведение
        window.soundMixer.stopMusic();
        window.soundMixer.stopAllEffects();
        
        // Очищаем интервалы
        if (window.soundMixer.clockInterval) {
            clearInterval(window.soundMixer.clockInterval);
        }
        if (window.soundMixer.progressAnimationFrame) {
            cancelAnimationFrame(window.soundMixer.progressAnimationFrame);
        }
        if (window.soundMixer.progressInterval) {
            clearInterval(window.soundMixer.progressInterval);
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
        if (window.soundMixer.sessionTimeInterval) {
            clearInterval(window.soundMixer.sessionTimeInterval);
        }
        
        // Выгружаем все звуки
        if (window.soundMixer.musicPlayer) {
            try {
                window.soundMixer.musicPlayer.unload();
            } catch (e) {
                console.warn('Error unloading music player:', e);
            }
        }
        
        window.soundMixer.soundEffects.forEach((soundData) => {
            if (soundData && soundData.sound) {
                try {
                    soundData.sound.unload();
                } catch (e) {
                    console.warn('Error unloading sound effect:', e);
                }
            }
        });
        
        // Сохраняем данные
        window.soundMixer.saveStoredData();
    }
});

// Обработка ошибок на уровне приложения
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    if (window.soundMixer) {
        window.soundMixer.updateStatus('Произошла ошибка приложения', 'error');
    }
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    if (window.soundMixer) {
        window.soundMixer.updateStatus('Ошибка выполнения операции', 'error');
    }
});