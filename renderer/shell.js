(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_LOGGER } = dependencies;

// Native window controls, application menus, status messages and clocks.
class CASShellController {
    constructor(app) {
        this.app = app;
        this.statusUpdateTimeout = null;
        this.clockInterval = null;
        this.countdownTime = 0;
        this.countdownInterval = null;
        this.isCountdownRunning = false;
    }

    initWindowControls() {
        const platform = window.electronAPI?.platform || 'win32';
        const isWindows = platform === 'win32';
        const isMac = platform === 'darwin';
        const body = typeof document !== 'undefined' ? document.body : null;

        if (body) {
            if (isWindows) body.classList.add('platform-win32');
            else if (isMac) body.classList.add('platform-darwin');
            else body.classList.add('platform-linux');
        }

        const winControls = typeof document !== 'undefined' ? document.getElementById('windowsWindowControls') : null;
        const macControls = typeof document !== 'undefined' ? document.getElementById('macWindowControls') : null;

        if (isWindows && winControls && window.electronAPI?.windowControl) {
            winControls.hidden = false;
            if (macControls) macControls.hidden = true;

            const closeBtn = document.getElementById('winCloseBtn');
            const minBtn = document.getElementById('winMinBtn');
            const maxBtn = document.getElementById('winMaxBtn');

            closeBtn?.addEventListener('click', () => {
                window.electronAPI.windowControl('close').catch(console.error);
            });

            minBtn?.addEventListener('click', () => {
                window.electronAPI.windowControl('minimize').catch(console.error);
            });

            const updateMaxIcon = (isMaximized) => {
                if (!maxBtn) return;
                maxBtn.setAttribute('aria-label', isMaximized ? 'Восстановить окно' : 'Развернуть окно');
                maxBtn.title = isMaximized ? 'Восстановить' : 'Развернуть';
                const maxIcon = document.getElementById('winMaxIcon');
                if (maxIcon) {
                    maxIcon.innerHTML = isMaximized
                        ? '<path d="M2.5 1h6.5v6.5H2.5z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M1 3.5v5.5h5.5" fill="none" stroke="currentColor" stroke-width="1"/>'
                        : '<path d="M1 1h8v8H1z" fill="none" stroke="currentColor" stroke-width="1"/>';
                }
            };

            maxBtn?.addEventListener('click', () => {
                window.electronAPI.windowControl('maximize').catch(console.error);
            });

            if (window.electronAPI.isMaximized) {
                window.electronAPI.isMaximized().then(updateMaxIcon).catch(() => {});
            }

            if (window.electronAPI.onWindowStateChange) {
                window.electronAPI.onWindowStateChange((state) => {
                    updateMaxIcon(Boolean(state?.isMaximized));
                });
            }
        } else if (isMac && macControls && window.electronAPI?.windowControl) {
            macControls.hidden = false;
            if (winControls) winControls.hidden = true;

            const macClose = document.getElementById('macCloseBtn');
            const macMin = document.getElementById('macMinBtn');
            const macMax = document.getElementById('macMaxBtn');

            macClose?.addEventListener('click', () => {
                window.electronAPI.windowControl('close').catch(console.error);
            });
            macMin?.addEventListener('click', () => {
                window.electronAPI.windowControl('minimize').catch(console.error);
            });
            macMax?.addEventListener('click', () => {
                window.electronAPI.windowControl('maximize').catch(console.error);
            });
        }
    }

    setupAppMenuBar() {
        const menuBar = document.getElementById('casMenuBar');
        if (!menuBar) return;

        let activeDropdown = null;
        let activeTrigger = null;

        const closeAllMenus = () => {
            menuBar.querySelectorAll('.cas-menu-trigger').forEach(btn => {
                btn.setAttribute('aria-expanded', 'false');
                btn.classList.remove('is-active');
            });
            menuBar.querySelectorAll('.cas-menu-dropdown').forEach(dropdown => {
                dropdown.hidden = true;
            });
            activeDropdown = null;
            activeTrigger = null;
        };

        const openMenu = (trigger, dropdown) => {
            closeAllMenus();
            trigger.setAttribute('aria-expanded', 'true');
            trigger.classList.add('is-active');
            dropdown.hidden = false;
            activeDropdown = dropdown;
            activeTrigger = trigger;
        };

        const triggers = menuBar.querySelectorAll('.cas-menu-trigger');
        const triggerArray = Array.from(triggers);
        triggers.forEach((trigger, index) => {
            const dropdown = trigger.nextElementSibling;
            if (!dropdown) return;

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeDropdown === dropdown) {
                    closeAllMenus();
                } else {
                    openMenu(trigger, dropdown);
                }
            });

            trigger.addEventListener('mouseenter', () => {
                if (activeDropdown && activeDropdown !== dropdown) {
                    openMenu(trigger, dropdown);
                }
            });

            trigger.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    const next = (index + 1) % triggerArray.length;
                    triggerArray[next].focus();
                    if (activeDropdown) {
                        openMenu(triggerArray[next], triggerArray[next].nextElementSibling);
                    }
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const prev = (index - 1 + triggerArray.length) % triggerArray.length;
                    triggerArray[prev].focus();
                    if (activeDropdown) {
                        openMenu(triggerArray[prev], triggerArray[prev].nextElementSibling);
                    }
                } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openMenu(trigger, dropdown);
                    dropdown.querySelector('.cas-menu-action')?.focus();
                }
            });
        });

        menuBar.querySelectorAll('.cas-menu-dropdown').forEach(dropdown => {
            dropdown.addEventListener('keydown', (e) => {
                const actions = Array.from(dropdown.querySelectorAll('.cas-menu-action'));
                const currentIndex = actions.indexOf(document.activeElement);

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const nextIndex = (currentIndex + 1) % actions.length;
                    actions[nextIndex]?.focus();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prevIndex = (currentIndex - 1 + actions.length) % actions.length;
                    actions[prevIndex]?.focus();
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    const currentTriggerIndex = triggerArray.indexOf(activeTrigger);
                    if (currentTriggerIndex !== -1) {
                        const next = (currentTriggerIndex + 1) % triggerArray.length;
                        triggerArray[next].focus();
                        openMenu(triggerArray[next], triggerArray[next].nextElementSibling);
                        triggerArray[next].nextElementSibling?.querySelector('.cas-menu-action')?.focus();
                    }
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const currentTriggerIndex = triggerArray.indexOf(activeTrigger);
                    if (currentTriggerIndex !== -1) {
                        const prev = (currentTriggerIndex - 1 + triggerArray.length) % triggerArray.length;
                        triggerArray[prev].focus();
                        openMenu(triggerArray[prev], triggerArray[prev].nextElementSibling);
                        triggerArray[prev].nextElementSibling?.querySelector('.cas-menu-action')?.focus();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    const trg = activeTrigger;
                    closeAllMenus();
                    trg?.focus();
                }
            });
        });

        document.addEventListener('click', (e) => {
            if (activeDropdown && !e.target.closest('#casMenuBar')) {
                closeAllMenus();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && activeDropdown) {
                closeAllMenus();
            }
        });

        menuBar.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('.cas-menu-action');
            if (!actionBtn) return;
            const action = actionBtn.dataset.action;
            closeAllMenus();

            switch (action) {
                case 'open-folder':
                    this.app.changeMusicFolder();
                    break;
                case 'load-track-a':
                    this.app.openTrackForDeck('A');
                    break;
                case 'load-track-b':
                    this.app.openTrackForDeck('B');
                    break;
                case 'assign-pad':
                    document.getElementById('assignSound')?.click();
                    break;
                case 'online-search':
                    document.getElementById('openOnlineSearch')?.click();
                    break;
                case 'quit':
                    window.electronAPI?.windowControl?.('close').catch(console.error);
                    break;
                case 'deck-split':
                    document.getElementById('viewModeSplit')?.click();
                    break;
                case 'deck-a-only':
                    document.getElementById('viewModeA')?.click();
                    break;
                case 'deck-b-only':
                    document.getElementById('viewModeB')?.click();
                    break;
                case 'refresh-playlists':
                    document.getElementById('refreshPlaylists')?.click();
                    break;
                case 'play-pause':
                    if (this.app.isPlaying && !this.app.isPaused) {
                        document.getElementById('pauseBtn')?.click();
                    } else {
                        document.getElementById('playBtn')?.click();
                    }
                    break;
                case 'stop':
                    document.getElementById('stopBtn')?.click();
                    break;
                case 'next-track':
                    document.getElementById('nextTrack')?.click();
                    break;
                case 'prev-track':
                    document.getElementById('prevTrack')?.click();
                    break;
                case 'mute':
                    document.getElementById('panicMuteBtn')?.click();
                    break;
                case 'stop-pads':
                    document.getElementById('stopAllEffects')?.click();
                    break;
                case 'tab-add':
                    document.getElementById('workspaceAdd')?.click();
                    break;
                case 'tab-rename':
                    document.getElementById('workspaceRename')?.click();
                    break;
                case 'tab-delete':
                    document.getElementById('workspaceDelete')?.click();
                    break;
                case 'open-settings':
                    this.app.workspaces?.activateSettings();
                    break;
                case 'change-folder':
                    this.app.changeMusicFolder();
                    break;
                case 'open-help':
                    document.getElementById('openKeyboardHelp')?.click();
                    break;
                case 'about-app':
                    this.app.showAboutDialog();
                    break;
                case 'open-remote':
                    this.app.showRemoteControlDialog();
                    break;
            }
        });
    }

    async openTrackForDeck(deckId) {
        this.app.setActiveDeck(deckId);
        if (!window.electronAPI?.openFileDialog) return;
        try {
            const result = await window.electronAPI.openFileDialog({
                title: `Выберите треки для деки ${deckId}`,
                properties: ['openFile', 'multiSelections'],
                filters: [{ name: 'Аудиофайлы', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }]
            });
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                const imported = await window.electronAPI.getAudioTracks(result.filePaths);
                if (!imported.success) throw new Error(imported.error);
                const newTracks = imported.data;
                const deck = this.app.decks[deckId];
                if (deck) {
                    deck.tracks = [...(deck.tracks || []), ...newTracks];
                    if (!deck.playlist) deck.playlist = { name: 'Выбранные треки', path: null };
                    deck.customQueue = true;
                    this.app.displayTracks(deckId);
                    this.app.updateDeckUI();
                    this.app.updateTrackCounter();
                    this.app.saveStoredData();
                    this.app.updateStatus(`Добавлено треков в деку ${deckId}: ${newTracks.length}`, 'success');
                }
            }
        } catch (error) {
            CAS_LOGGER.error('Ошибка выбора треков для деки:', error);
            this.app.updateStatus('Ошибка выбора файлов', 'error');
        }
    }

    formatPlatformInfo() {
        const plat = window.electronAPI?.platform || (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Mac') ? 'darwin' : 'win32');
        const arch = window.electronAPI?.arch || 'x64';
        if (plat === 'win32') {
            return arch === 'x64' ? 'Windows x64' : (arch === 'arm64' ? 'Windows ARM64' : `Windows ${arch}`);
        }
        if (plat === 'darwin') {
            const archName = arch === 'arm64' ? 'Apple Silicon' : (arch === 'x64' ? 'Intel' : arch);
            return archName ? `macOS (${archName})` : 'macOS';
        }
        if (plat === 'linux') {
            return arch ? `Linux ${arch}` : 'Linux';
        }
        return plat;
    }

    setupAboutDialog() {
        if (typeof document === 'undefined') return;
        const dialog = document.getElementById('aboutDialog');
        const githubLink = document.getElementById('aboutGithubLink');

        if (githubLink) {
            githubLink.addEventListener('click', (e) => {
                e.preventDefault();
                const url = githubLink.getAttribute('href') || 'https://github.com/IliaBebebe/Concert-Audio-System';
                if (window.electronAPI?.openExternal) {
                    window.electronAPI.openExternal(url).catch((err) => {
                        CAS_LOGGER?.error?.('Ошибка открытия внешней ссылки:', err);
                    });
                } else if (typeof window !== 'undefined') {
                    window.open(url, '_blank', 'noopener,noreferrer');
                }
            });
        }

        if (dialog) {
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) dialog.close();
            });
        }
    }

    showAboutDialog() {
        if (typeof document === 'undefined') return;
        const dialog = document.getElementById('aboutDialog');
        const platformValueEl = document.getElementById('aboutPlatformValue');
        const electronValueEl = document.getElementById('aboutElectronValue');
        const chromeValueEl = document.getElementById('aboutChromeValue');
        const nodeValueEl = document.getElementById('aboutNodeValue');

        if (platformValueEl) {
            platformValueEl.textContent = this.app.formatPlatformInfo();
        }

        const versions = window.electronAPI?.versions || (typeof process !== 'undefined' ? process.versions : null);
        if (electronValueEl) {
            electronValueEl.textContent = versions?.electron ? `v${versions.electron}` : 'v34.3.0';
        }
        if (chromeValueEl) {
            chromeValueEl.textContent = versions?.chrome ? `v${versions.chrome}` : 'v132.0';
        }
        if (nodeValueEl) {
            nodeValueEl.textContent = versions?.node ? `v${versions.node}` : 'v20.18.3';
        }

        if (dialog && typeof dialog.showModal === 'function') {
            dialog.showModal();
        }
    }

    updateStatus(message, type = 'info') {
        const statusElement = document.getElementById('status');
        if (!statusElement) return;

        if (this.statusUpdateTimeout) {
            clearTimeout(this.statusUpdateTimeout);
        }

        const textSpan = statusElement.querySelector('.status-indicator-text');
        if (textSpan) {
            textSpan.textContent = message;
        } else {
            statusElement.textContent = message;
        }
        statusElement.classList.add('pulse');

        statusElement.classList.remove('status-error', 'status-success', 'status-warning', 'status-info');
        if (type === 'error') {
            statusElement.classList.add('status-error');
        } else if (type === 'success') {
            statusElement.classList.add('status-success');
        } else if (type === 'warning') {
            statusElement.classList.add('status-warning');
        } else {
            statusElement.classList.add('status-info');
        }

        this.statusUpdateTimeout = setTimeout(() => {
            statusElement.classList.remove('pulse');
        }, 500);
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
        this.app.setupMediaSession();
    }

    startCountdown() {
        const minutesInput = document.getElementById('countdownMinutes');
        const secondsInput = document.getElementById('countdownSeconds');
        const clampMinutes = (value) => Math.max(0, Math.min(999, Number.parseInt(value, 10) || 0));
        const clampSeconds = (value) => Math.max(0, Math.min(59, Number.parseInt(value, 10) || 0));
        const minutes = clampMinutes(minutesInput?.value);
        const seconds = clampSeconds(secondsInput?.value);
        if (minutesInput) minutesInput.value = minutes;
        if (secondsInput) secondsInput.value = seconds;

        const countdownTime = minutes * 60 + seconds;

        if (countdownTime <= 0) {
            this.app.updateStatus('Установите время для таймера', 'warning');
            return;
        }
        this.countdownTime = countdownTime;

        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }

        this.isCountdownRunning = true;
        this.app.updateCountdownDisplay();

        this.countdownInterval = setInterval(() => {
            this.countdownTime--;
            this.app.updateCountdownDisplay();

            if (this.countdownTime <= 0) {
                this.app.stopCountdown();
                this.app.updateStatus('Таймер завершен!', 'warning');
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
        this.app.stopCountdown();
        this.countdownTime = 0;
        const minEl = document.getElementById('countdownMinutes');
        const secEl = document.getElementById('countdownSeconds');
        if (minEl) minEl.value = 0;
        if (secEl) secEl.value = 0;
        this.app.updateCountdownDisplay();
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

    return { CASShellController };
});
