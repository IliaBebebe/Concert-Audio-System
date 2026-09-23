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
        this.isMuted = false;
        this.trackFilterQuery = '';
        this.decks = {
            A: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' },
            B: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' }
        };
        this.activeDeck = 'A';
        this.playingDeck = null;
        this.viewMode = 'split';
        this.dragState = null;
        this.playlistRequestId = 0;
        this.refreshRequestId = 0;
        this.musicPlayerToken = 0;
        this.pendingMusicStart = false;
        this.musicRetryTimeout = null;
        this.detachedBlocks = new Map();
        this.floatingWindowZ = 1100;
        this.modalCloseMs = 150;
        this.retiringMusicPlayers = new Set();
        this.crossfadeTimers = new Set();
        this.isCrossfading = false;
        this.crossfadeEnabled = false;
        this.crossfadeDuration = 3;
        this.waveformCache = new Map();
        this.waveformRequestId = 0;
        this.waveformPeaks = [];
        this.waveformResizeObserver = null;
        
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
        this.retiringMusicPlayers.forEach((player) => this.connectHowlToAnalyser(player, 'music'));
        this.soundEffects.forEach((soundData) => this.connectHowlToAnalyser(soundData?.sound, 'effects'));

        const hasRetiringMusic = Array.from(this.retiringMusicPlayers).some((player) => {
            try { return player?.playing(); } catch { return false; }
        });
        const musicTarget = (this.isPlaying && !this.isPaused) || hasRetiringMusic
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

    setupDetachableBlocks() {
        this.modalCloseMs = this.readCssDuration('--modal-close-dur', 150);

        const detachableBlocks = [
            { key: 'appHeader', selector: '.header', title: 'Concert Audio System' },
            { key: 'playlists', selector: '.left-panel > .section:nth-of-type(2)', title: 'Плейлисты' },
            { key: 'soundPads', selector: '.left-panel > .section:nth-of-type(3)', title: 'Звуковые эффекты' },
            { key: 'tracks', selector: '.tracks-section', title: 'Треки в плейлисте', fillPlaceholder: true },
            { key: 'nowPlaying', selector: '.now-playing', title: 'Сейчас играет' },
            { key: 'progress', selector: '.progress-section', title: 'Прогресс' },
            { key: 'volume', selector: '.volume-section', title: 'Громкость' },
            { key: 'countdown', selector: '.countdown-section', title: 'Таймер' },
            { key: 'hotkeys', selector: '.hotkeys-info', title: 'Горячие клавиши' }
        ];

        detachableBlocks.forEach((definition) => {
            const block = document.querySelector(definition.selector);
            if (!block || block.dataset.detachableReady === 'true') return;

            block.classList.add('detachable-block');
            block.dataset.detachableReady = 'true';
            block.dataset.detachableKey = definition.key;
            block.dataset.detachableTitle = definition.title;

            const detachButton = document.createElement('button');
            detachButton.type = 'button';
            detachButton.className = 'block-detach-btn';
            detachButton.title = `Вынести "${definition.title}" в отдельное окно`;
            detachButton.setAttribute('aria-label', `Вынести "${definition.title}" в отдельное окно`);
            detachButton.innerHTML = '<i class="fas fa-up-right-from-square"></i>';
            detachButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.detachBlock(definition, block);
            });

            block.appendChild(detachButton);
        });

        window.addEventListener('resize', () => this.clampFloatingWindows());
    }

    readCssDuration(name, fallback) {
        const rawValue = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (!rawValue) return fallback;

        const numericValue = parseFloat(rawValue);
        if (!Number.isFinite(numericValue)) return fallback;
        return rawValue.endsWith('ms') ? numericValue : numericValue * 1000;
    }

    getFloatingWindowLayer() {
        let layer = document.querySelector('.detached-window-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'detached-window-layer';
            document.body.appendChild(layer);
        }
        return layer;
    }

    detachBlock(definition, block) {
        const existing = this.detachedBlocks.get(definition.key);
        if (existing) {
            this.bringFloatingWindowToFront(existing.windowEl);
            return;
        }

        const parent = block.parentElement;
        if (!parent) return;

        const rect = block.getBoundingClientRect();
        const placeholder = document.createElement('div');
        placeholder.className = 'detached-block-placeholder';
        if (definition.fillPlaceholder) placeholder.classList.add('is-fill');
        placeholder.innerHTML = `
            <div class="detached-placeholder-title">${definition.title}</div>
            <button type="button" class="detached-placeholder-btn">
                <i class="fas fa-window-restore"></i>
                Вернуть
            </button>
        `;
        placeholder.querySelector('.detached-placeholder-btn')?.addEventListener('click', () => {
            this.restoreDetachedBlock(definition.key);
        });

        parent.insertBefore(placeholder, block);

        const windowEl = document.createElement('div');
        windowEl.className = 'floating-window detached-window t-modal';
        windowEl.setAttribute('role', 'dialog');
        windowEl.setAttribute('aria-modal', 'false');
        windowEl.setAttribute('aria-label', definition.title);
        windowEl.tabIndex = -1;
        windowEl.innerHTML = `
            <div class="floating-titlebar">
                <div class="traffic-lights" aria-label="Управление окном">
                    <button type="button" class="traffic-light close" data-window-action="close" aria-label="Закрыть окно"></button>
                    <button type="button" class="traffic-light minimize" data-window-action="minimize" aria-label="Свернуть окно"></button>
                    <button type="button" class="traffic-light zoom" data-window-action="zoom" aria-label="Расширить окно"></button>
                </div>
                <div class="floating-title">${definition.title}</div>
            </div>
            <div class="floating-window-content"></div>
            <div class="floating-resize-handle" aria-hidden="true"></div>
        `;

        const content = windowEl.querySelector('.floating-window-content');
        content.appendChild(block);
        block.classList.add('is-detached');

        const layer = this.getFloatingWindowLayer();
        layer.appendChild(windowEl);
        this.positionFloatingWindow(windowEl, rect, definition);

        const state = { definition, block, placeholder, windowEl, isClosing: false };
        this.detachedBlocks.set(definition.key, state);
        this.bindFloatingWindowControls(definition.key);
        this.bringFloatingWindowToFront(windowEl);

        requestAnimationFrame(() => {
            windowEl.classList.add('is-open');
            windowEl.focus({ preventScroll: true });
        });

        this.updateStatus(`${definition.title}: вынесено в окно`);
    }

    positionFloatingWindow(windowEl, rect, definition) {
        const margin = 18;
        const viewportWidth = Math.max(window.innerWidth, 1);
        const viewportHeight = Math.max(window.innerHeight, 1);
        const minWidth = definition.key === 'tracks' ? 560 : 320;
        const minHeight = definition.key === 'tracks' ? 420 : 180;
        const width = Math.min(Math.max(rect.width, minWidth), viewportWidth - margin * 2);
        const height = Math.min(Math.max(rect.height, minHeight), viewportHeight - margin * 2);
        const left = Math.min(Math.max(rect.left, margin), viewportWidth - width - margin);
        const top = Math.min(Math.max(rect.top, margin), viewportHeight - height - margin);

        this.setFloatingWindowGeometry(windowEl, {
            left: Math.max(margin, left),
            top: Math.max(margin, top),
            width,
            height
        });
    }

    setFloatingWindowGeometry(windowEl, geometry) {
        windowEl.style.left = `${Math.round(geometry.left)}px`;
        windowEl.style.top = `${Math.round(geometry.top)}px`;
        windowEl.style.width = `${Math.round(geometry.width)}px`;
        windowEl.style.height = `${Math.round(geometry.height)}px`;
    }

    bindFloatingWindowControls(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        windowEl.addEventListener('mousedown', () => this.bringFloatingWindowToFront(windowEl));
        windowEl.querySelector('[data-window-action="close"]')?.addEventListener('click', () => this.restoreDetachedBlock(key));
        windowEl.querySelector('[data-window-action="minimize"]')?.addEventListener('click', () => this.toggleFloatingWindowMinimized(key));
        windowEl.querySelector('[data-window-action="zoom"]')?.addEventListener('click', () => this.toggleFloatingWindowMaximized(key));
        windowEl.querySelector('.floating-titlebar')?.addEventListener('mousedown', (event) => this.startFloatingWindowDrag(event, key));
        windowEl.querySelector('.floating-resize-handle')?.addEventListener('mousedown', (event) => this.startFloatingWindowResize(event, key));
    }

    bringFloatingWindowToFront(windowEl) {
        this.floatingWindowZ += 1;
        windowEl.style.zIndex = String(this.floatingWindowZ);
    }

    restoreDetachedBlock(key) {
        const state = this.detachedBlocks.get(key);
        if (!state || state.isClosing) return;

        const { definition, block, placeholder, windowEl } = state;
        state.isClosing = true;

        const finishRestore = () => {
            if (placeholder.parentElement) {
                placeholder.parentElement.insertBefore(block, placeholder);
            }
            block.classList.remove('is-detached');
            placeholder.remove();
            windowEl.remove();
            this.detachedBlocks.delete(key);
            this.updateStatus(`${definition.title}: возвращено на место`);
        };

        windowEl.classList.remove('is-open');
        windowEl.classList.add('is-closing');
        setTimeout(finishRestore, this.modalCloseMs);
    }

    toggleFloatingWindowMinimized(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        if (windowEl.classList.contains('is-minimized')) {
            windowEl.classList.remove('is-minimized');
            windowEl.style.height = state.heightBeforeMinimize || windowEl.style.height;
            windowEl.querySelector('[data-window-action="minimize"]')?.setAttribute('aria-pressed', 'false');
            return;
        }

        if (windowEl.classList.contains('is-maximized')) {
            this.toggleFloatingWindowMaximized(key);
        }

        state.heightBeforeMinimize = windowEl.style.height;
        windowEl.classList.add('is-minimized');
        windowEl.style.height = 'auto';
        windowEl.querySelector('[data-window-action="minimize"]')?.setAttribute('aria-pressed', 'true');
    }

    toggleFloatingWindowMaximized(key) {
        const state = this.detachedBlocks.get(key);
        if (!state) return;

        const { windowEl } = state;
        const margin = 12;

        if (windowEl.classList.contains('is-maximized')) {
            windowEl.classList.remove('is-maximized');
            if (state.geometryBeforeMaximize) {
                this.setFloatingWindowGeometry(windowEl, state.geometryBeforeMaximize);
            }
            windowEl.querySelector('[data-window-action="zoom"]')?.setAttribute('aria-pressed', 'false');
            return;
        }

        if (windowEl.classList.contains('is-minimized')) {
            this.toggleFloatingWindowMinimized(key);
        }

        const rect = windowEl.getBoundingClientRect();
        state.geometryBeforeMaximize = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        };

        windowEl.classList.add('is-maximized');
        this.setFloatingWindowGeometry(windowEl, {
            left: margin,
            top: margin,
            width: window.innerWidth - margin * 2,
            height: window.innerHeight - margin * 2
        });
        windowEl.querySelector('[data-window-action="zoom"]')?.setAttribute('aria-pressed', 'true');
    }

    startFloatingWindowDrag(event, key) {
        if (event.button !== 0 || event.target.closest('button')) return;

        const state = this.detachedBlocks.get(key);
        if (!state) return;
        const { windowEl } = state;
        if (windowEl.classList.contains('is-maximized') || windowEl.classList.contains('is-minimized')) return;

        event.preventDefault();
        this.bringFloatingWindowToFront(windowEl);

        const rect = windowEl.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const margin = 8;

        const onMove = (moveEvent) => {
            const width = rect.width;
            const height = rect.height;
            const left = Math.min(Math.max(moveEvent.clientX - offsetX, margin), window.innerWidth - width - margin);
            const top = Math.min(Math.max(moveEvent.clientY - offsetY, margin), window.innerHeight - 38);
            windowEl.style.left = `${Math.round(left)}px`;
            windowEl.style.top = `${Math.round(top)}px`;
            windowEl.style.width = `${Math.round(width)}px`;
            windowEl.style.height = `${Math.round(height)}px`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
    }

    startFloatingWindowResize(event, key) {
        if (event.button !== 0) return;

        const state = this.detachedBlocks.get(key);
        if (!state) return;
        const { windowEl } = state;
        if (windowEl.classList.contains('is-maximized') || windowEl.classList.contains('is-minimized')) return;

        event.preventDefault();
        event.stopPropagation();
        this.bringFloatingWindowToFront(windowEl);

        const rect = windowEl.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const minWidth = state.definition.key === 'tracks' ? 520 : 300;
        const minHeight = state.definition.key === 'tracks' ? 360 : 150;
        const margin = 10;

        const onMove = (moveEvent) => {
            const width = Math.min(Math.max(rect.width + moveEvent.clientX - startX, minWidth), window.innerWidth - rect.left - margin);
            const height = Math.min(Math.max(rect.height + moveEvent.clientY - startY, minHeight), window.innerHeight - rect.top - margin);
            windowEl.style.width = `${Math.round(width)}px`;
            windowEl.style.height = `${Math.round(height)}px`;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
    }

    clampFloatingWindows() {
        this.detachedBlocks.forEach(({ windowEl }) => {
            if (windowEl.classList.contains('is-maximized')) {
                this.setFloatingWindowGeometry(windowEl, {
                    left: 12,
                    top: 12,
                    width: window.innerWidth - 24,
                    height: window.innerHeight - 24
                });
                return;
            }

            const rect = windowEl.getBoundingClientRect();
            const margin = 8;
            const width = Math.min(rect.width, window.innerWidth - margin * 2);
            const height = Math.min(rect.height, window.innerHeight - margin * 2);
            const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
            const top = Math.min(Math.max(rect.top, margin), window.innerHeight - 38);
            this.setFloatingWindowGeometry(windowEl, { left, top, width, height });
        });
    }

    async initializeApp() {
        await this.loadConfig();
        this.setupEventListeners();
        this.createSoundPads();
        this.setupResizers();
        this.setupDetachableBlocks();
        this.setupWaveformCanvas();
        this.initVuMeters();
        this.startClock();
        this.updateCountdownDisplay();
        await this.loadStoredData();
        this.updateCrossfadeControls();
        await this.refreshPlaylists();
        this.updateDeckUI();
        this.displayTracks();
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
        document.getElementById('waveformPanel')?.addEventListener('click', (e) => this.seekFromWaveform(e));

        const crossfadeEnabled = document.getElementById('crossfadeEnabled');
        const crossfadeDuration = document.getElementById('crossfadeDuration');
        if (crossfadeEnabled) {
            crossfadeEnabled.addEventListener('change', (e) => {
                this.crossfadeEnabled = e.target.checked;
                this.updateCrossfadeControls();
                this.saveStoredData();
                this.updateStatus(this.crossfadeEnabled ? 'Crossfade включен' : 'Crossfade выключен');
            });
        }
        if (crossfadeDuration) {
            crossfadeDuration.addEventListener('input', (e) => {
                this.crossfadeDuration = this.normalizeCrossfadeDuration(e.target.value);
                this.updateCrossfadeControls();
                this.saveStoredData();
            });
        }
        
        document.getElementById('trackSearchInputA')?.addEventListener('input', (e) => {
            this.filterTracksInDeck('A', e.target.value);
        });
        document.getElementById('trackSearchInputB')?.addEventListener('input', (e) => {
            this.filterTracksInDeck('B', e.target.value);
        });
        
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

        // Переключение режимов отображения деков (Рядом / Deck A / Deck B)
        this.onClick('viewModeSplit', () => this.setViewMode('split'));
        this.onClick('viewModeA', () => this.setViewMode('A'));
        this.onClick('viewModeB', () => this.setViewMode('B'));

        // Клик по шапке дека делает его активным
        this.onClick('deckHeaderA', () => this.setActiveDeck('A'));
        this.onClick('deckHeaderB', () => this.setActiveDeck('B'));
    }

    onClick(id, handler) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    normalizeCrossfadeDuration(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return 3;
        return Math.max(1, Math.min(10, Math.round(numericValue)));
    }

    updateCrossfadeControls() {
        const enabledInput = document.getElementById('crossfadeEnabled');
        const durationInput = document.getElementById('crossfadeDuration');
        const durationValue = document.getElementById('crossfadeDurationValue');

        if (enabledInput) enabledInput.checked = this.crossfadeEnabled;
        if (durationInput) {
            durationInput.value = String(this.crossfadeDuration);
            durationInput.disabled = !this.crossfadeEnabled;
        }
        if (durationValue) {
            durationValue.textContent = `${this.crossfadeDuration} с`;
            durationValue.classList.toggle('is-disabled', !this.crossfadeEnabled);
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
        return index + 1;
    }

    getTrackDisplayName(track, index) {
        return `${this.getTrackDisplayNumber(track, index)}. ${this.getTrackTitle(track)}`;
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
            <button class="action-btn" id="openMusicFolderBtn"><i class="fas fa-folder-open"></i> Открыть папку с музыкой</button>
            <button class="action-btn" id="changeFolderBtn"><i class="fas fa-folder-open"></i> Изменить папку с музыкой</button>
        `;
        wrapper.querySelector('.hint').textContent = `В ${folderName} нет плейлистов (подпапок с музыкой)`;
        container.appendChild(wrapper);
        
        document.getElementById('changeFolderBtn').addEventListener('click', () => this.changeMusicFolder());
        document.getElementById('openMusicFolderBtn').addEventListener('click', () => this.openMusicFolder());
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
            <button class="action-btn" id="openMusicFolderBtn"><i class="fas fa-folder-open"></i> Открыть папку с музыкой</button>
            <button class="action-btn" id="changeFolderBtn2"><i class="fas fa-folder-open"></i> Изменить папку</button>
        `;
        wrapper.querySelector('.error-detail').textContent = error || 'Неизвестная ошибка';
        container.appendChild(wrapper);
        
        document.getElementById('retryBtn').addEventListener('click', () => this.refreshPlaylists());
        document.getElementById('openMusicFolderBtn').addEventListener('click', () => this.openMusicFolder());
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
        
        document.getElementById('openMusicFolderSmall').addEventListener('click', () => this.openMusicFolder());
        document.getElementById('changeMusicFolderSmall').addEventListener('click', () => this.changeMusicFolder());
    }

    async loadPlaylist(playlist) {
        const requestId = ++this.playlistRequestId;
        const targetDeck = this.activeDeck;
        try {
            this.updateStatus(`Загрузка в Deck ${targetDeck}: ${playlist.name}`);
            const result = await window.electronAPI.getPlaylistTracks(playlist.path);
            if (requestId !== this.playlistRequestId) return;
            
            if (result.success) {
                if (this.playingDeck === targetDeck) {
                    this.stopMusic({ silent: true });
                }

                this.trackLoadGeneration++;
                const deck = this.decks[targetDeck];
                deck.playlist = playlist;
                deck.tracks = result.data;
                deck.currentTrackIndex = 0;
                deck.filterQuery = '';

                const searchInput = document.getElementById(targetDeck === 'A' ? 'trackSearchInputA' : 'trackSearchInputB');
                if (searchInput) searchInput.value = '';

                this.currentPlaylist = playlist;
                this.playlistTracks = result.data;
                this.currentTrackIndex = 0;
                this.trackFilterQuery = '';

                this.displayTracks(targetDeck);
                this.updateDeckUI();
                this.updateTrackCounter();
                this.updateStatus(`Плейлист загружен в Deck ${targetDeck}: ${playlist.name}`, 'success');
                
                if (!this.isPlaying && this.playlistTracks.length > 0) {
                    this.loadTrack(0);
                }
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            if (requestId !== this.playlistRequestId) return;
            this.updateStatus('Ошибка загрузки плейлиста', 'error');
        }
    }

    async openMusicFolder() {
        try {
            const result = await window.electronAPI.openMusicFolder();
            if (!result?.success) {
                throw new Error(result?.error || 'Не удалось открыть папку с музыкой');
            }
            this.updateStatus('Папка с музыкой открыта');
        } catch (error) {
            this.updateStatus('Не удалось открыть папку с музыкой', 'error');
        }
    }

    updatePlaylistSelection() {
        const pathA = this.decks.A.playlist?.path;
        const pathB = this.decks.B.playlist?.path;
        const currentActivePath = this.decks[this.activeDeck].playlist?.path;

        document.querySelectorAll('.playlist-btn').forEach((button) => {
            const btnPath = button.dataset.playlistPath;
            button.classList.toggle('active', btnPath === currentActivePath);

            let deckBadge = button.querySelector('.playlist-deck-badge');
            const isDeckA = btnPath === pathA;
            const isDeckB = btnPath === pathB;

            if (isDeckA && isDeckB) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge';
                    button.appendChild(deckBadge);
                }
                deckBadge.textContent = 'A+B';
                deckBadge.className = 'playlist-deck-badge';
            } else if (isDeckA) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge';
                    button.appendChild(deckBadge);
                }
                deckBadge.textContent = 'Deck A';
                deckBadge.className = 'playlist-deck-badge';
            } else if (isDeckB) {
                if (!deckBadge) {
                    deckBadge = document.createElement('span');
                    deckBadge.className = 'playlist-deck-badge deck-b';
                    button.appendChild(deckBadge);
                }
                deckBadge.textContent = 'Deck B';
                deckBadge.className = 'playlist-deck-badge deck-b';
            } else if (deckBadge) {
                deckBadge.remove();
            }
        });
    }

    resetPlaylistState() {
        this.playlistRequestId++;
        this.refreshRequestId++;
        this.stopMusic({ silent: true });
        this.trackLoadGeneration++;
        this.decks = {
            A: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' },
            B: { playlist: null, tracks: [], currentTrackIndex: 0, filterQuery: '' }
        };
        this.currentPlaylist = null;
        this.playlistTracks = [];
        this.currentTrackIndex = 0;
        this.trackFilterQuery = '';

        const searchInputA = document.getElementById('trackSearchInputA');
        const searchInputB = document.getElementById('trackSearchInputB');
        if (searchInputA) searchInputA.value = '';
        if (searchInputB) searchInputB.value = '';

        const currentTrack = document.getElementById('currentTrack');
        if (currentTrack) {
            currentTrack.textContent = 'Трек не выбран';
            currentTrack.title = '';
        }
        this.displayTracks();
        this.updateDeckUI();
        this.updateTrackCounter();
        this.clearWaveform('Waveform ожидает трек');
    }

    displayTracks(targetDeckId = null) {
        const decksToRender = targetDeckId ? [targetDeckId] : ['A', 'B'];

        decksToRender.forEach((deckId) => {
            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const container = document.getElementById(containerId);
            if (!container) return;
            container.replaceChildren();

            const deck = this.decks[deckId];
            if (!deck) return;
            const filterQuery = (deck.filterQuery || '').toLowerCase().trim();
            const tracks = deck.tracks || [];

            const list = tracks
                .map((t, i) => ({ t, i }))
                .filter(({ t }) => {
                    if (!filterQuery) return true;
                    const name = (t.name || '').toLowerCase();
                    const title = (t.title || '').toLowerCase();
                    const artist = (t.artist || '').toLowerCase();
                    const trackNumber = String(t.trackNumber || '');
                    return name.includes(filterQuery)
                        || title.includes(filterQuery)
                        || artist.includes(filterQuery)
                        || trackNumber.includes(filterQuery);
                });

            const fragment = document.createDocumentFragment();
            const pendingTrackLoads = [];
            const isDragEnabled = !filterQuery;

            list.forEach(({ t: track, i: index }) => {
                const row = document.createElement('div');
                row.className = 'track-row';
                row.dataset.index = String(index);
                row.dataset.deck = deckId;

                // Drag handle
                const dragHandle = document.createElement('div');
                dragHandle.className = 'track-drag-handle';
                dragHandle.innerHTML = '<i class="fas fa-grip-vertical"></i>';
                dragHandle.setAttribute('aria-hidden', 'true');

                if (isDragEnabled) {
                    row.draggable = true;
                    row.addEventListener('dragstart', (e) => this.handleTrackDragStart(e, deckId, index));
                    row.addEventListener('dragover', (e) => this.handleTrackDragOver(e, deckId));
                    row.addEventListener('dragenter', (e) => this.handleTrackDragEnter(e, row));
                    row.addEventListener('dragleave', (e) => this.handleTrackDragLeave(e, row));
                    row.addEventListener('drop', (e) => this.handleTrackDrop(e, deckId, index));
                    row.addEventListener('dragend', (e) => this.handleTrackDragEnd(e));
                } else {
                    dragHandle.style.opacity = '0.15';
                    dragHandle.style.cursor = 'default';
                }

                const btn = document.createElement('button');
                btn.className = 'track-btn';
                btn.dataset.index = String(index);
                btn.dataset.deck = deckId;
                if (this.playingDeck === deckId && index === deck.currentTrackIndex) {
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
                this.renderTrackArtist(trackArtist, track);

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

                btn.addEventListener('click', () => this.playTrackInDeck(deckId, index));

                const editBtn = document.createElement('button');
                editBtn.className = 'track-edit-btn';
                editBtn.type = 'button';
                editBtn.title = 'Редактировать параметры трека';
                editBtn.setAttribute('aria-label', 'Редактировать параметры трека');
                editBtn.innerHTML = '<i class="fas fa-pen"></i>';
                editBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.openTrackMetadataEditor(deckId, index);
                });

                row.append(dragHandle, btn, editBtn);
                fragment.appendChild(row);

                if (!track.duration || !track.artist || !track.title || !track.trackNumber) {
                    pendingTrackLoads.push({ track, trackDuration, trackName, trackArtist, index, deckId });
                }
            });

            container.appendChild(fragment);
            pendingTrackLoads.forEach(({ track, trackDuration, trackName, trackArtist, index }) => {
                if (!track.duration) this.loadTrackDuration(track, trackDuration);
                if (!track.artist || !track.title || !track.trackNumber) {
                    this.loadTrackMetadata(track, { nameElement: trackName, artistElement: trackArtist, index });
                }
            });
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
        const startOffset = this.getTrackStartOffset(track);
        if (startOffset > 0) {
            const startBadge = document.createElement('span');
            startBadge.className = 'track-start-badge';
            startBadge.textContent = `старт ${this.formatTrackStartOffset(startOffset)}`;
            element.appendChild(startBadge);
        }
    }

    // ===== Drag & Drop Track Reordering =====

    handleTrackDragStart(e, deckId, index) {
        this.dragState = { deckId, sourceIndex: index, insertAfter: false };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `${deckId}:${index}`);
        const row = e.target.closest('.track-row');
        if (row) {
            setTimeout(() => row.classList.add('dragging'), 0);
        }
    }

    handleTrackDragOver(e, deckId) {
        if (!this.dragState || this.dragState.deckId !== deckId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const row = e.target.closest('.track-row');
        if (!row) return;

        const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
        const container = document.getElementById(containerId);
        if (container) {
            container.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach((r) => {
                if (r !== row) r.classList.remove('drag-over-top', 'drag-over-bottom');
            });
        }

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isTop = e.clientY < midY;

        row.classList.toggle('drag-over-top', isTop);
        row.classList.toggle('drag-over-bottom', !isTop);
        this.dragState.insertAfter = !isTop;
    }

    handleTrackDragEnter(e, row) {
        e.preventDefault();
    }

    handleTrackDragLeave(e, row) {
        if (!row.contains(e.relatedTarget)) {
            row.classList.remove('drag-over-top', 'drag-over-bottom');
        }
    }

    handleTrackDrop(e, deckId, targetIndex) {
        if (!this.dragState || this.dragState.deckId !== deckId) return;
        e.preventDefault();

        const sourceIndex = this.dragState.sourceIndex;
        const insertAfterTarget = this.dragState.insertAfter;

        if (sourceIndex === targetIndex) {
            this.handleTrackDragEnd(e);
            return;
        }

        const deck = this.decks[deckId];
        const tracks = deck.tracks;

        const [movedTrack] = tracks.splice(sourceIndex, 1);

        let insertAt;
        if (insertAfterTarget) {
            insertAt = sourceIndex < targetIndex ? targetIndex : targetIndex + 1;
        } else {
            insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        }

        tracks.splice(insertAt, 0, movedTrack);

        let newCurrentIndex = deck.currentTrackIndex;
        if (deck.currentTrackIndex === sourceIndex) {
            newCurrentIndex = insertAt;
        } else {
            if (deck.currentTrackIndex > sourceIndex) newCurrentIndex--;
            if (newCurrentIndex >= insertAt) newCurrentIndex++;
        }
        deck.currentTrackIndex = newCurrentIndex;

        if (this.activeDeck === deckId) {
            this.playlistTracks = tracks;
            this.currentTrackIndex = newCurrentIndex;
        }

        this.dragState = null;
        this.displayTracks(deckId);
        this.highlightCurrentTrack();
        this.updateTrackCounter();
        this.updateStatus(`Deck ${deckId}: трек перемещён на позицию ${insertAt + 1}`);
    }

    handleTrackDragEnd(e) {
        this.dragState = null;
        document.querySelectorAll('.track-row.dragging, .track-row.drag-over-top, .track-row.drag-over-bottom').forEach((r) => {
            r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
        });
    }

    // ===== Dual Playlist Deck Management =====

    playTrackInDeck(deckId, index, options = {}) {
        if (this.playingDeck && this.playingDeck !== deckId) {
            this.stopMusic({ silent: true });
        }

        this.activeDeck = deckId;
        this.playingDeck = deckId;

        const deck = this.decks[deckId];
        this.currentPlaylist = deck.playlist;
        this.playlistTracks = deck.tracks;
        this.currentTrackIndex = index;
        deck.currentTrackIndex = index;

        this.loadTrack(index, options);
        this.playMusic();
        this.highlightCurrentTrack();
        this.updateDeckUI();
    }

    playTrack(index, options = {}) {
        this.playTrackInDeck(this.activeDeck, index, options);
    }

    filterTracksInDeck(deckId, query) {
        if (!this.decks[deckId]) return;
        this.decks[deckId].filterQuery = (query || '').toLowerCase().trim();
        if (this.activeDeck === deckId) {
            this.trackFilterQuery = this.decks[deckId].filterQuery;
        }
        this.displayTracks(deckId);
    }

    filterTracks(query) {
        this.filterTracksInDeck(this.activeDeck, query);
    }

    setActiveDeck(deckId) {
        if (deckId !== 'A' && deckId !== 'B') return;
        this.activeDeck = deckId;

        const deck = this.decks[deckId];
        this.currentPlaylist = deck.playlist;
        this.playlistTracks = deck.tracks;
        this.currentTrackIndex = deck.currentTrackIndex;
        this.trackFilterQuery = deck.filterQuery || '';

        this.updateDeckUI();
        this.updatePlaylistSelection();
        this.updateTrackCounter();
        this.updateStatus(`Выбран целевой ${deckId === 'A' ? 'Deck A' : 'Deck B'}`);
    }

    setViewMode(mode) {
        if (!['split', 'A', 'B'].includes(mode)) return;
        this.viewMode = mode;

        const container = document.getElementById('decksContainer');
        if (container) {
            container.classList.remove('view-a', 'view-b');
            if (mode === 'A') container.classList.add('view-a');
            if (mode === 'B') container.classList.add('view-b');
        }

        const btnSplit = document.getElementById('viewModeSplit');
        const btnA = document.getElementById('viewModeA');
        const btnB = document.getElementById('viewModeB');

        btnSplit?.classList.toggle('active', mode === 'split');
        btnA?.classList.toggle('active', mode === 'A');
        btnB?.classList.toggle('active', mode === 'B');

        if (mode === 'A' || mode === 'B') {
            this.setActiveDeck(mode);
        }
    }

    updateDeckUI() {
        const nameA = document.getElementById('deckNameA');
        const nameB = document.getElementById('deckNameB');
        const countA = document.getElementById('deckCountA');
        const countB = document.getElementById('deckCountB');
        const colA = document.getElementById('deckColumnA');
        const colB = document.getElementById('deckColumnB');
        const stateA = document.getElementById('deckStateA');
        const stateB = document.getElementById('deckStateB');
        const badge = document.getElementById('activeDeckBadge');

        if (nameA) {
            nameA.textContent = this.decks.A.playlist ? this.decks.A.playlist.name : 'Плейлист A (не выбран)';
        }
        if (countA) {
            const total = this.decks.A.tracks?.length || 0;
            countA.textContent = `${total} треков`;
        }

        if (nameB) {
            nameB.textContent = this.decks.B.playlist ? this.decks.B.playlist.name : 'Плейлист B (не выбран)';
        }
        if (countB) {
            const total = this.decks.B.tracks?.length || 0;
            countB.textContent = `${total} треков`;
        }

        if (colA) colA.classList.toggle('active', this.activeDeck === 'A');
        if (colB) colB.classList.toggle('active', this.activeDeck === 'B');

        if (badge) {
            badge.textContent = this.activeDeck === 'A' ? 'DECK A' : 'DECK B';
            badge.classList.toggle('deck-b', this.activeDeck === 'B');
        }

        if (stateA) {
            stateA.classList.remove('playing', 'active', 'standby');
            if (this.playingDeck === 'A' && this.isPlaying && !this.isPaused) {
                stateA.textContent = 'ИГРАЕТ ▶';
                stateA.classList.add('playing');
            } else if (this.activeDeck === 'A') {
                stateA.textContent = 'АКТИВЕН';
                stateA.classList.add('active');
            } else {
                stateA.textContent = 'ОЖИДАНИЕ';
                stateA.classList.add('standby');
            }
        }

        if (stateB) {
            stateB.classList.remove('playing', 'active', 'standby');
            if (this.playingDeck === 'B' && this.isPlaying && !this.isPaused) {
                stateB.textContent = 'ИГРАЕТ ▶';
                stateB.classList.add('playing');
            } else if (this.activeDeck === 'B') {
                stateB.textContent = 'АКТИВЕН';
                stateB.classList.add('active');
            } else {
                stateB.textContent = 'ОЖИДАНИЕ';
                stateB.classList.add('standby');
            }
        }

        this.updatePlaylistSelection();
    }

    updateTrackRowDetails(track) {
        ['A', 'B'].forEach((deckId) => {
            const deck = this.decks[deckId];
            const index = deck.tracks.indexOf(track);
            if (index < 0) return;

            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const row = document.querySelector(`#${containerId} .track-row[data-index="${index}"]`);
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
            if (this.playingDeck === deckId && deck.currentTrackIndex === index) {
                this.updateCurrentTrackDisplay(track);
            }
        });
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

    openTrackMetadataEditor(deckIdOrIndex, maybeIndex) {
        let deckId = this.activeDeck;
        let index = deckIdOrIndex;
        if (typeof deckIdOrIndex === 'string') {
            deckId = deckIdOrIndex;
            index = maybeIndex;
        }

        const deck = this.decks[deckId] || this.decks[this.activeDeck];
        const track = deck.tracks[index] || this.playlistTracks[index];
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
        startOffsetInput.value = this.formatTrackStartOffset(this.getTrackStartOffset(track));
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
            let startOffset;
            try {
                startOffset = this.parseTrackStartOffset(startOffsetInput.value);
            } catch (error) {
                this.updateStatus(error.message, 'warning');
                startOffsetInput.focus();
                startOffsetInput.select();
                return;
            }
            setSubmitting(true);
            try {
                const saved = await this.saveTrackMetadata(index, {
                    title: titleInput.value,
                    artist: artistInput.value,
                    trackNumber: numberInput.value,
                    startOffset
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
            track.startOffset = Object.prototype.hasOwnProperty.call(track.metadataOverride, 'startOffset')
                ? track.metadataOverride.startOffset
                : 0;
            this.trackMetadataTasks.delete(track);
            await this.loadTrackMetadata(track);

            if (this.currentPlaylist === playlistAtStart && this.playlistTracks.includes(track)) {
                this.displayTracks();
                const isCurrentTrack = this.playlistTracks[this.currentTrackIndex] === track;
                if (isCurrentTrack && this.musicPlayer && !this.isPlaying && !this.pendingMusicStart) {
                    this.loadTrack(this.currentTrackIndex);
                }
                if (isCurrentTrack) {
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
            track.startOffset = 0;
            this.trackMetadataTasks.delete(track);
            await this.loadTrackMetadata(track);
            if (this.currentPlaylist === playlistAtStart && this.playlistTracks.includes(track)) {
                this.displayTracks();
                const isCurrentTrack = this.playlistTracks[this.currentTrackIndex] === track;
                if (isCurrentTrack && this.musicPlayer && !this.isPlaying && !this.pendingMusicStart) {
                    this.loadTrack(this.currentTrackIndex);
                }
                if (isCurrentTrack) {
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

    loadTrack(index, options = {}) {
        if (index < 0 || index >= this.playlistTracks.length) return;

        const {
            preserveCurrent = false,
            initialVolume = this.musicVolume,
            fadeInMs = 0
        } = options;
        this.currentTrackIndex = index;
        const track = this.playlistTracks[index];
        if (!preserveCurrent) {
            this.stopMusic({ silent: true });
        } else {
            this.stopProgressTracking(false);
            this.pendingMusicStart = false;
            this.isPlaying = false;
            this.isPaused = false;
        }

        const playerToken = ++this.musicPlayerToken;
        let player = null;
        let fadeInApplied = false;
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
            volume: initialVolume,
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
                if (fadeInMs > 0 && !fadeInApplied) {
                    fadeInApplied = true;
                    try {
                        player.volume(0);
                        player.fade(0, this.musicVolume, fadeInMs);
                    } catch {
                        try { player.volume(this.musicVolume); } catch {}
                    }
                }
                this.updateStatus(`Воспроизведение: ${this.getTrackTitle(track)}`);
                this.startProgressTracking();
                this.updateVuMeters();
                this.playingDeck = this.activeDeck;
                this.updateDeckUI();
            },
            onpause: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPaused = true;
                this.stopProgressTracking(false);
                this.updateStatus('Пауза');
                this.updateDeckUI();
            },
            onstop: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.updateStatus('Остановлено');
                this.stopProgressTracking();
                this.playingDeck = null;
                this.updateDeckUI();
            },
            onend: () => {
                this.handleTrackEnd(player, playerToken);
            },
            onload: () => {
                if (!isCurrentPlayer()) return;
                this.connectHowlToAnalyser(player, 'music');
                const startOffset = this.getTrackStartOffset(track);
                const duration = player.duration();
                const initialSeek = startOffset > 0 && Number.isFinite(duration) && startOffset < duration
                    ? startOffset
                    : 0;
                if (initialSeek > 0) {
                    player.seek(initialSeek);
                }
                const progress = Number.isFinite(duration) && duration > 0 ? (initialSeek / duration) * 100 : 0;
                const progressBar = document.getElementById('progressBar');
                if (progressBar) progressBar.value = progress;
                this.updateWaveformProgress(progress);
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
        this.loadWaveformForTrack(track);
        return player;
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

    shouldCrossfadeTo(index) {
        return this.crossfadeEnabled
            && this.crossfadeDuration > 0
            && this.musicPlayer
            && this.isPlaying
            && !this.isPaused
            && !this.pendingMusicStart
            && this.playlistTracks.length > 1
            && index >= 0
            && index < this.playlistTracks.length
            && index !== this.currentTrackIndex;
    }

    getCrossfadeDurationMs(player = this.musicPlayer) {
        const requestedMs = this.normalizeCrossfadeDuration(this.crossfadeDuration) * 1000;
        try {
            const duration = player?.duration();
            const seek = player?.seek();
            if (Number.isFinite(duration) && Number.isFinite(seek) && duration > seek) {
                return Math.max(250, Math.min(requestedMs, Math.round((duration - seek) * 1000)));
            }
        } catch {}
        return requestedMs;
    }

    startCrossfadeToIndex(index, { automatic = false } = {}) {
        if (!this.shouldCrossfadeTo(index) || this.isCrossfading) {
            this.playTrack(index, { forceDirect: true });
            return;
        }

        const outgoingPlayer = this.musicPlayer;
        const outgoingTrack = this.playlistTracks[this.currentTrackIndex];
        const incomingTrack = this.playlistTracks[index];
        const fadeMs = this.getCrossfadeDurationMs(outgoingPlayer);

        this.isCrossfading = true;
        const incomingPlayer = this.loadTrack(index, {
            preserveCurrent: true,
            initialVolume: 0,
            fadeInMs: fadeMs
        });

        if (!incomingPlayer) {
            this.isCrossfading = false;
            return;
        }

        this.fadeOutAndUnloadMusicPlayer(outgoingPlayer, fadeMs);
        this.playMusic();

        const timer = setTimeout(() => {
            this.crossfadeTimers.delete(timer);
            this.isCrossfading = false;
        }, fadeMs + 120);
        this.crossfadeTimers.add(timer);

        const fromTitle = this.getTrackTitle(outgoingTrack);
        const toTitle = this.getTrackTitle(incomingTrack);
        this.updateStatus(`${automatic ? 'Авто-' : ''}Crossfade: ${fromTitle} → ${toTitle}`);
    }

    fadeOutAndUnloadMusicPlayer(player, durationMs) {
        if (!player) return;
        this.retiringMusicPlayers.add(player);

        try {
            const currentVolume = Number(player.volume());
            player.fade(Number.isFinite(currentVolume) ? currentVolume : this.musicVolume, 0, durationMs);
        } catch {
            try { player.volume(0); } catch {}
        }

        const timer = setTimeout(() => {
            this.crossfadeTimers.delete(timer);
            this.retiringMusicPlayers.delete(player);
            try { player.unload(); } catch {}
        }, durationMs + 180);
        this.crossfadeTimers.add(timer);
    }

    maybeStartAutomaticCrossfade(player, playerToken, seek, duration) {
        if (!this.crossfadeEnabled
            || this.playbackMode !== 'sequential'
            || this.isCrossfading
            || this.musicPlayer !== player
            || this.musicPlayerToken !== playerToken
            || this.playlistTracks.length < 2
            || !Number.isFinite(seek)
            || !Number.isFinite(duration)
            || duration <= 0) {
            return;
        }

        const fadeSeconds = this.normalizeCrossfadeDuration(this.crossfadeDuration);
        const remaining = duration - seek;
        if (remaining > 0 && remaining <= fadeSeconds && seek > 0.5) {
            const nextIndex = (this.currentTrackIndex + 1) % this.playlistTracks.length;
            this.startCrossfadeToIndex(nextIndex, { automatic: true });
        }
    }

    playTrack(index, { forceDirect = false } = {}) {
        if (!forceDirect && this.shouldCrossfadeTo(index)) {
            this.startCrossfadeToIndex(index);
            return;
        }
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
            } else {
                this.playingDeck = this.activeDeck;
                this.updateDeckUI();
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
            this.updateDeckUI();
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
        this.crossfadeTimers.forEach((timer) => clearTimeout(timer));
        this.crossfadeTimers.clear();
        this.retiringMusicPlayers.forEach((retiringPlayer) => {
            try { retiringPlayer.unload(); } catch {}
        });
        this.retiringMusicPlayers.clear();
        this.isCrossfading = false;
        this.isPlaying = false;
        this.isPaused = false;
        this.playingDeck = null;
        this.stopProgressTracking();
        this.updateDeckUI();

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
        const deckId = this.playingDeck || this.activeDeck;
        const deck = this.decks[deckId];
        if (!deck || deck.tracks.length === 0) return;
        const newIndex = (deck.currentTrackIndex + direction + deck.tracks.length) % deck.tracks.length;
        this.playTrackInDeck(deckId, newIndex);
    }

    highlightCurrentTrack() {
        ['A', 'B'].forEach((deckId) => {
            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const container = document.getElementById(containerId);
            if (!container) return;

            const isPlayingThisDeck = this.playingDeck === deckId;
            const currentIndex = this.decks[deckId].currentTrackIndex;

            container.querySelectorAll('.track-row').forEach((row) => {
                const rowIdx = Number(row.dataset.index);
                const btn = row.querySelector('.track-btn');
                const isActive = isPlayingThisDeck && rowIdx === currentIndex;

                row.classList.toggle('active', isActive);
                btn?.classList.toggle('active', isActive);

                if (isActive) {
                    (row || btn).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        });
        this.updateTrackCounter();
        this.updateDeckUI();
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
                    this.updateWaveformProgress(progress);
                    this.maybeStartAutomaticCrossfade(player, playerToken, seek, duration);
                    
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
        this.updateWaveformProgress(0);
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
                    this.updateWaveformProgress(Math.min(100, Math.max(0, Number(progress) || 0)));
                    this.updateTimeDisplays();
                }
            } catch (error) {
                this.updateStatus('Ошибка перемотки', 'error');
            }
        }
    }

    setupWaveformCanvas() {
        const canvas = document.getElementById('trackWaveform');
        const panel = document.getElementById('waveformPanel');
        if (!canvas || !panel) return;

        this.clearWaveform('Waveform ожидает трек');
        this.waveformResizeObserver = new ResizeObserver(() => this.drawWaveform());
        this.waveformResizeObserver.observe(panel);
    }

    setWaveformState(message, loading = false) {
        const state = document.getElementById('waveformState');
        const panel = document.getElementById('waveformPanel');
        if (state) state.textContent = message;
        if (panel) {
            panel.classList.toggle('is-loading', loading);
            panel.classList.toggle('has-waveform', this.waveformPeaks.length > 0);
        }
    }

    clearWaveform(message = 'Waveform недоступна') {
        this.waveformPeaks = [];
        this.updateWaveformProgress(0);
        const canvas = document.getElementById('trackWaveform');
        if (canvas) {
            const context = canvas.getContext('2d');
            if (context) context.clearRect(0, 0, canvas.width, canvas.height);
        }
        this.setWaveformState(message, false);
    }

    async loadWaveformForTrack(track) {
        const requestId = ++this.waveformRequestId;
        this.updateWaveformProgress(0);
        if (!track?.path) {
            this.clearWaveform('Waveform ожидает трек');
            return;
        }

        const cachedPeaks = this.waveformCache.get(track.path);
        if (cachedPeaks) {
            this.waveformPeaks = cachedPeaks;
            this.drawWaveform();
            this.setWaveformState('', false);
            return;
        }

        this.clearWaveform('Строю waveform...');
        this.setWaveformState('Строю waveform...', true);

        try {
            const result = await window.electronAPI.getAudioFileBuffer(track.path);
            if (requestId !== this.waveformRequestId) return;
            if (!result?.success || !result.data) {
                this.clearWaveform(result?.error || 'Waveform недоступна');
                return;
            }

            const audioData = this.toArrayBuffer(result.data);
            const audioContext = this.getWaveformAudioContext();
            const decodedBuffer = await audioContext.decodeAudioData(audioData.slice(0));
            if (requestId !== this.waveformRequestId) return;

            const peaks = this.createWaveformPeaks(decodedBuffer, 320);
            this.waveformCache.set(track.path, peaks);
            while (this.waveformCache.size > 32) {
                this.waveformCache.delete(this.waveformCache.keys().next().value);
            }

            this.waveformPeaks = peaks;
            this.drawWaveform();
            this.setWaveformState('', false);
        } catch {
            if (requestId === this.waveformRequestId) {
                this.clearWaveform('Waveform недоступна для этого файла');
            }
        }
    }

    toArrayBuffer(data) {
        if (data instanceof ArrayBuffer) return data;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        if (Array.isArray(data)) {
            return new Uint8Array(data).buffer;
        }
        throw new Error('Unsupported audio buffer');
    }

    getWaveformAudioContext() {
        this.setupAudioAnalysers();
        if (this.audioContext) return this.audioContext;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('AudioContext unavailable');
        }
        this.audioContext = new AudioContextClass();
        return this.audioContext;
    }

    createWaveformPeaks(audioBuffer, sampleCount) {
        const peaks = [];
        const channelCount = Math.min(2, audioBuffer.numberOfChannels || 1);
        const totalSamples = audioBuffer.length;
        const bucketSize = Math.max(1, Math.floor(totalSamples / sampleCount));
        let maxPeak = 0;

        for (let bucket = 0; bucket < sampleCount; bucket++) {
            const start = bucket * bucketSize;
            const end = Math.min(totalSamples, start + bucketSize);
            const step = Math.max(1, Math.floor((end - start) / 90));
            let peak = 0;

            for (let channel = 0; channel < channelCount; channel++) {
                const samples = audioBuffer.getChannelData(channel);
                for (let i = start; i < end; i += step) {
                    peak = Math.max(peak, Math.abs(samples[i] || 0));
                }
            }

            peaks.push(peak);
            maxPeak = Math.max(maxPeak, peak);
        }

        const normalizer = maxPeak > 0 ? maxPeak : 1;
        return peaks.map((peak) => Math.max(0.03, peak / normalizer));
    }

    getWaveformPeaksForWidth(targetWidth, scale) {
        if (this.waveformPeaks.length === 0) return [];

        const minPitch = Math.max(1, 1.8 * scale);
        const maxBarsForWidth = Math.max(1, Math.floor(targetWidth / minPitch));
        const targetCount = Math.min(this.waveformPeaks.length, maxBarsForWidth);
        if (targetCount >= this.waveformPeaks.length) {
            return this.waveformPeaks;
        }

        const resampledPeaks = [];
        const samplesPerBucket = this.waveformPeaks.length / targetCount;
        for (let bucket = 0; bucket < targetCount; bucket++) {
            const start = Math.floor(bucket * samplesPerBucket);
            const end = Math.max(start + 1, Math.ceil((bucket + 1) * samplesPerBucket));
            let peak = 0;
            for (let i = start; i < end && i < this.waveformPeaks.length; i++) {
                peak = Math.max(peak, this.waveformPeaks[i]);
            }
            resampledPeaks.push(peak);
        }
        return resampledPeaks;
    }

    drawWaveform() {
        const canvas = document.getElementById('trackWaveform');
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const scale = window.devicePixelRatio || 1;
        const targetWidth = Math.floor(width * scale);
        const targetHeight = Math.floor(height * scale);

        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }

        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, targetWidth, targetHeight);

        if (this.waveformPeaks.length === 0) return;

        const visiblePeaks = this.getWaveformPeaksForWidth(targetWidth, scale);
        if (visiblePeaks.length === 0) return;

        const centerY = targetHeight / 2;
        const pitch = targetWidth / visiblePeaks.length;
        const barGap = pitch >= 4 * scale ? Math.min(1.5 * scale, pitch * 0.28) : Math.max(0, pitch * 0.18);
        const barWidth = Math.max(0.5, pitch - barGap);
        const gradient = context.createLinearGradient(0, 0, 0, targetHeight);
        gradient.addColorStop(0, 'rgba(131, 184, 255, 0.88)');
        gradient.addColorStop(0.5, 'rgba(106, 168, 255, 0.58)');
        gradient.addColorStop(1, 'rgba(45, 204, 112, 0.62)');
        context.fillStyle = gradient;

        visiblePeaks.forEach((peak, index) => {
            const barHeight = Math.max(2 * scale, peak * targetHeight * 0.82);
            const x = index * pitch + barGap / 2;
            const y = centerY - barHeight / 2;
            context.fillRect(x, y, barWidth, barHeight);
        });
    }

    updateWaveformProgress(progress) {
        const panel = document.getElementById('waveformPanel');
        const playhead = document.getElementById('waveformPlayhead');
        const clampedProgress = Math.min(100, Math.max(0, Number(progress) || 0));
        if (panel) panel.style.setProperty('--waveform-progress', `${clampedProgress}%`);
        if (playhead) playhead.style.left = `${clampedProgress}%`;
    }

    seekFromWaveform(event) {
        const canvas = document.getElementById('trackWaveform');
        if (!canvas || !this.musicPlayer) return;

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const progress = ((event.clientX - rect.left) / rect.width) * 100;
        this.seekMusic(progress);
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
            case 'Tab':
                event.preventDefault();
                this.setActiveDeck(this.activeDeck === 'A' ? 'B' : 'A');
                break;
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
            playbackMode: this.playbackMode,
            crossfadeEnabled: this.crossfadeEnabled,
            crossfadeDuration: this.crossfadeDuration,
            viewMode: this.viewMode,
            activeDeck: this.activeDeck
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
            this.crossfadeEnabled = Boolean(data.crossfadeEnabled);
            this.crossfadeDuration = this.normalizeCrossfadeDuration(data.crossfadeDuration ?? 3);

            if (['split', 'A', 'B'].includes(data.viewMode)) {
                this.setViewMode(data.viewMode);
            }
            if (data.activeDeck === 'A' || data.activeDeck === 'B') {
                this.setActiveDeck(data.activeDeck);
            }

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
            this.updateCrossfadeControls();

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
        if (!counterEl) return;
        const deckId = this.playingDeck || this.activeDeck;
        const deck = this.decks[deckId];
        const tracks = deck?.tracks || [];
        if (tracks.length > 0) {
            const current = (deck.currentTrackIndex || 0) + 1;
            const total = tracks.length;
            counterEl.textContent = `${current} / ${total}`;
        } else {
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
