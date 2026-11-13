(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG } = dependencies;

// UI event wiring, keyboard shortcuts and the audio settings form.
class CASControlsController {
    constructor(app) {
        this.app = app;
    }

    setupEventListeners() {
        const revealDetachedBlock = key => {
            const changedWorkspace = this.app.workspaces?.reveal(key) || false;
            const state = this.app.detachedBlocks.get(key);
            if (!state) return changedWorkspace;
            const wasMinimized = state.windowEl.classList.contains('is-minimized');
            if (wasMinimized) this.app.toggleFloatingWindowMinimized(key);
            this.app.bringFloatingWindowToFront(state.windowEl);
            return wasMinimized || changedWorkspace;
        };
        this.app.onClick('openOnlineSearch', () => {
            revealDetachedBlock('tracks');
            const panel = document.getElementById('onlineMusicPanel');
            if (panel) panel.open = true;
            document.getElementById('onlineQuery')?.focus();
        });
        this.app.onClick('openRemoteControl', () => this.app.showRemoteControlDialog());
        this.app.onClick('openKeyboardHelp', () => {
            const help = document.getElementById('keyboardHelp');
            if (!help) return;
            const wasMinimized = revealDetachedBlock('hotkeys');
            help.open = wasMinimized || !help.open;
            if (help.open) {
                help.scrollIntoView({ block: 'nearest' });
                help.querySelector('summary')?.focus();
            }
        });
        document.getElementById('keyboardHelp')?.addEventListener('toggle', event => {
            document.getElementById('openKeyboardHelp')?.setAttribute('aria-expanded', String(event.target.open));
        });
        this.app.onClick('refreshPlaylists', () => this.app.refreshPlaylists());

        this.app.onClick('playBtn', () => this.app.playMusic());
        this.app.onClick('pauseBtn', () => this.app.pauseMusic());
        this.app.onClick('stopBtn', () => this.app.stopMusic());
        this.app.onClick('prevTrack', () => this.app.previousTrack());
        this.app.onClick('nextTrack', () => this.app.nextTrack());

        const panicBtn = document.getElementById('panicMuteBtn');
        if (panicBtn) panicBtn.addEventListener('click', () => this.app.togglePanicMute());

        this.app.onClick('assignSound', () => this.app.assignSoundToPad());
        this.app.onClick('renamePad', () => this.app.renameSelectedPad());
        this.app.onClick('clearPad', () => this.app.clearSelectedPad());
        this.app.onClick('stopAllEffects', () => this.app.stopAllEffects());

        document.getElementById('musicVolume')?.addEventListener('input', (e) => {
            this.app.setMusicVolume(e.target.value / 100);
            this.app.updateVuMeters();
        });
        document.getElementById('effectsVolume')?.addEventListener('input', (e) => {
            this.app.setEffectsVolume(e.target.value / 100);
            this.app.updateVuMeters();
        });

        document.getElementById('progressBar')?.addEventListener('input', (e) => this.app.seekMusic(e.target.value));
        document.getElementById('waveformPanel')?.addEventListener('click', (e) => this.app.seekFromWaveform(e));

        const crossfadeEnabled = document.getElementById('crossfadeEnabled');
        const deckCrossfadeEnabled = document.getElementById('deckCrossfadeEnabled');
        const crossfadeDuration = document.getElementById('crossfadeDuration');
        if (crossfadeEnabled) {
            crossfadeEnabled.addEventListener('change', (e) => {
                this.app.crossfadeEnabled = e.target.checked;
                this.app.updateCrossfadeControls();
                this.app.saveStoredData();
                this.app.updateStatus(this.app.crossfadeEnabled ? 'Кроссфейд в треках включен' : 'Кроссфейд в треках выключен');
            });
        }
        if (deckCrossfadeEnabled) {
            deckCrossfadeEnabled.addEventListener('change', (e) => {
                this.app.deckCrossfadeEnabled = e.target.checked;
                this.app.updateCrossfadeControls();
                this.app.saveStoredData();
                this.app.updateStatus(this.app.deckCrossfadeEnabled ? 'Кроссфейд между деками включен' : 'Кроссфейд между деками выключен');
            });
        }
        if (crossfadeDuration) {
            crossfadeDuration.addEventListener('input', (e) => {
                this.app.crossfadeDuration = this.app.normalizeCrossfadeDuration(e.target.value);
                this.app.updateCrossfadeControls();
                this.app.saveStoredData();
            });
        }

        document.getElementById('trackSearchInputA')?.addEventListener('input', (e) => {
            this.app.filterTracksInDeck('A', e.target.value);
        });
        document.getElementById('trackSearchInputB')?.addEventListener('input', (e) => {
            this.app.filterTracksInDeck('B', e.target.value);
        });

        const countdownStart = document.getElementById('countdownStart');
        const countdownStop = document.getElementById('countdownStop');
        const countdownReset = document.getElementById('countdownReset');
        if (countdownStart) countdownStart.addEventListener('click', () => this.app.startCountdown());
        if (countdownStop) countdownStop.addEventListener('click', () => this.app.stopCountdown());
        if (countdownReset) countdownReset.addEventListener('click', () => this.app.resetCountdown());

        document.querySelectorAll('input[name="playbackMode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.app.playbackMode = e.target.value;
                if (this.app.musicPlayer) {
                    try {
                        this.app.musicPlayer.loop(this.app.playbackMode === 'loop');
                    } catch {}
                }
                this.app.updateStatus(`Режим: ${this.app.getPlaybackModeName()}`);
                this.app.saveStoredData();
            });
        });

        document.addEventListener('keydown', (e) => this.app.handleHotkeys(e));
        document.addEventListener('wheel', (e) => this.app.handleVolumeWheel(e), { passive: false });

        // Переключение режимов отображения деков (Рядом / Deck A / Deck B)
        this.app.onClick('viewModeSplit', () => this.app.setViewMode('split'));
        this.app.onClick('viewModeA', () => this.app.setViewMode('A'));
        this.app.onClick('viewModeB', () => this.app.setViewMode('B'));

        // Клик по шапке дека делает его активным
        this.app.onClick('deckHeaderA', () => this.app.setActiveDeck('A'));
        this.app.onClick('deckHeaderB', () => this.app.setActiveDeck('B'));

        // Drag-and-drop треков между деками на уровне контейнеров
        ['A', 'B'].forEach((deckId) => {
            const containerId = deckId === 'A' ? 'tracksContainerA' : 'tracksContainerB';
            const container = document.getElementById(containerId);
            if (container) {
                container.addEventListener('dragover', (e) => this.app.handleContainerDragOver(e, deckId));
                container.addEventListener('dragleave', (e) => this.app.handleContainerDragLeave(e, deckId));
                container.addEventListener('drop', (e) => this.app.handleContainerDrop(e, deckId));
            }
        });
    }

    onClick(id, handler) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    togglePanicMute() {
        this.app.isMuted = !this.app.isMuted;
        if (this.app.musicPlayer) {
            try {
                this.app.musicPlayer.mute(this.app.isMuted);
            } catch {}
        }
        this.app.retiringMusicPlayers.forEach(p => {
            try { p.mute(this.app.isMuted); } catch {}
        });
        this.app.soundEffects.forEach(sd => {
            if (sd?.sound) {
                try { sd.sound.mute(this.app.isMuted); } catch {}
            }
            if (sd?.loadingSound) {
                try { sd.loadingSound.mute(this.app.isMuted); } catch {}
            }
        });
        const btn = document.getElementById('panicMuteBtn');
        if (btn) {
            btn.innerHTML = this.app.isMuted ?
                '<i class="fas fa-volume-up"></i> Unmute' :
                '<i class="fas fa-volume-mute"></i> Mute (паника)';
        }
        this.app.updateStatus(this.app.isMuted ? 'Звук выключен (паника)' : 'Звук включен');
        this.app.broadcastRemoteState();
    }

    setupDialogKeyboard(overlay, canClose = () => true) {
        const previousFocus = document.activeElement;
        const close = () => {
            if (!canClose()) return;
            overlay.remove();
            if (previousFocus?.isConnected) previousFocus.focus();
        };
        overlay.addEventListener('keydown', event => {
            if (event.code === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            } else if (event.code === 'Tab') {
                const elements = Array.from(overlay.querySelectorAll('input:not(:disabled), button:not(:disabled)'));
                const first = elements[0];
                const last = elements[elements.length - 1];
                if (!first) { event.preventDefault(); return; }
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        });
        return close;
    }

    handleHotkeys(event) {
        const metadataModal = document.querySelector('.metadata-modal-overlay');
        if (metadataModal || document.querySelector('dialog[open]')) {
            return;
        }

        if (!event.altKey && !event.shiftKey) {
            let action;
            if (event.ctrlKey || event.metaKey) {
                if (event.code === 'KeyO') action = () => this.app.changeMusicFolder();
                if (event.code === 'KeyQ') action = () => window.electronAPI?.windowControl?.('close')?.catch(console.error);
                if (event.code === 'Comma') action = () => this.app.workspaces?.activateSettings();
            } else if (event.code === 'F5') action = () => this.app.refreshPlaylists();
            if (action) {
                event.preventDefault();
                if (!event.repeat) action();
                return;
            }
        }
        if (event.target?.closest?.('#casMenuBar, #workspaceTabs, .workspace-transfer-popover')) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const tagName = event.target?.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || event.target?.isContentEditable) return;

        if (event.code === 'Tab') return;
        if (event.shiftKey && (event.code === 'KeyA' || event.code === 'KeyB')) {
            event.preventDefault();
            this.app.setActiveDeck(event.code === 'KeyA' ? 'A' : 'B');
            return;
        }
        if (event.code === 'Space' && event.target?.closest?.('button, [role="button"], select, summary')) return;

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
                if (this.app.isPlaying && !this.app.isPaused) {
                    this.app.pauseMusic();
                } else {
                    this.app.playMusic();
                }
                break;
            case 'Escape':
                event.preventDefault();
                this.app.stopMusic();
                this.app.stopAllEffects();
                break;
            case 'KeyM':
                event.preventDefault();
                this.app.togglePanicMute();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.app.previousTrack();
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.app.nextTrack();
                break;
            case 'ArrowUp':
                event.preventDefault();
                if (event.shiftKey) {
                    this.app.setEffectsVolume(Math.min(1, this.app.effectsVolume + 0.01));
                    document.getElementById('effectsVolume').value = this.app.effectsVolume * 100;
                } else {
                    this.app.setMusicVolume(Math.min(1, this.app.musicVolume + 0.01));
                    document.getElementById('musicVolume').value = this.app.musicVolume * 100;
                }
                break;
            case 'ArrowDown':
                event.preventDefault();
                if (event.shiftKey) {
                    this.app.setEffectsVolume(Math.max(0, this.app.effectsVolume - 0.01));
                    document.getElementById('effectsVolume').value = this.app.effectsVolume * 100;
                } else {
                    this.app.setMusicVolume(Math.max(0, this.app.musicVolume - 0.01));
                    document.getElementById('musicVolume').value = this.app.musicVolume * 100;
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
                    this.app.playSoundEffect(padHotkeys[event.code]);
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
                targetVolume = this.app.musicVolume;
            }
        }

        if (!isMusic && effectsControl) {
            const effectsRect = effectsControl.getBoundingClientRect();
            if (event.clientY >= effectsRect.top && event.clientY <= effectsRect.bottom) {
                isMusic = false;
                targetVolume = this.app.effectsVolume;
            }
        }

        if (targetVolume === null) return;

        event.preventDefault();

        const delta = event.deltaY > 0 ? -0.01 : 0.01;
        const newVolume = Math.max(0, Math.min(1, targetVolume + delta));

        if (isMusic) {
            this.app.setMusicVolume(newVolume);
            const musicSlider = document.getElementById('musicVolume');
            if (musicSlider) musicSlider.value = newVolume * 100;
        } else {
            this.app.setEffectsVolume(newVolume);
            const effectsSlider = document.getElementById('effectsVolume');
            if (effectsSlider) effectsSlider.value = newVolume * 100;
        }
    }

    initSettingsUI() {
        const trimEnabled = document.getElementById('settingTrimSilenceEnabled');
        if (trimEnabled) {
            trimEnabled.addEventListener('change', (e) => {
                this.app.audioSettings.trimSilenceEnabled = e.target.checked;
                this.app.syncSettingsUI();
                this.app.saveStoredData();
                this.app.drawWaveform();
            });
        }

        const trimStart = document.getElementById('settingTrimSilenceStart');
        if (trimStart) {
            trimStart.addEventListener('change', (e) => {
                this.app.audioSettings.trimSilenceStart = e.target.checked;
                this.app.saveStoredData();
                this.app.drawWaveform();
            });
        }

        const trimEnd = document.getElementById('settingTrimSilenceEnd');
        if (trimEnd) {
            trimEnd.addEventListener('change', (e) => {
                this.app.audioSettings.trimSilenceEnd = e.target.checked;
                this.app.saveStoredData();
                this.app.drawWaveform();
            });
        }

        const trimThreshold = document.getElementById('settingTrimSilenceThreshold');
        const trimThresholdVal = document.getElementById('settingTrimSilenceThresholdVal');
        if (trimThreshold) {
            trimThreshold.addEventListener('input', (e) => {
                if (trimThresholdVal) trimThresholdVal.textContent = `${e.target.value} dB`;
            });
            trimThreshold.addEventListener('change', (e) => {
                this.app.audioSettings.trimSilenceThreshold = Number(e.target.value);
                this.app.refreshAudioAnalysis();
                this.app.saveStoredData();
            });
        }

        const trimPadding = document.getElementById('settingTrimSilencePadding');
        const trimPaddingVal = document.getElementById('settingTrimSilencePaddingVal');
        if (trimPadding) {
            trimPadding.addEventListener('input', (e) => {
                if (trimPaddingVal) trimPaddingVal.textContent = `${e.target.value} мс`;
            });
            trimPadding.addEventListener('change', (e) => {
                this.app.audioSettings.trimSilencePadding = Number(e.target.value);
                this.app.refreshAudioAnalysis();
                this.app.saveStoredData();
            });
        }

        const volStabEnabled = document.getElementById('settingVolumeStabilizationEnabled');
        if (volStabEnabled) {
            volStabEnabled.addEventListener('change', (e) => {
                this.app.audioSettings.volumeStabilizationEnabled = e.target.checked;
                this.app.applyStabilizerSettings();
                this.app.syncSettingsUI();
                this.app.saveStoredData();
            });
        }

        const volStabMode = document.getElementById('settingVolumeStabilizationMode');
        if (volStabMode) {
            volStabMode.addEventListener('change', (e) => {
                this.app.audioSettings.volumeStabilizationMode = e.target.value;
                this.app.applyStabilizerSettings();
                this.app.saveStoredData();
            });
        }

        const volNormEnabled = document.getElementById('settingVolumeNormalizationEnabled');
        if (volNormEnabled) {
            volNormEnabled.addEventListener('change', (e) => {
                this.app.audioSettings.volumeNormalizationEnabled = e.target.checked;
                this.app.applyStabilizerSettings();
                this.app.saveStoredData();
            });
        }

        const volTargetLevel = document.getElementById('settingVolumeTargetLevel');
        if (volTargetLevel) {
            volTargetLevel.addEventListener('change', (e) => {
                this.app.audioSettings.volumeTargetLevel = Number(e.target.value);
                this.app.applyStabilizerSettings();
                this.app.saveStoredData();
            });
        }

        const changeFolderBtn = document.getElementById('settingsChangeFolderBtn');
        if (changeFolderBtn) {
            changeFolderBtn.addEventListener('click', () => {
                document.getElementById('chooseMusicFolder')?.click();
            });
        }

        const clearCacheBtn = document.getElementById('settingsClearCacheBtn');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', () => {
                this.app.refreshAudioAnalysis();
                this.app.updateStatus('Кэш анализа и осциллограмм очищен', 'success');
            });
        }

        const resetBtn = document.getElementById('resetAudioSettingsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.app.audioSettings = {
                    trimSilenceEnabled: CAS_CONFIG.SETTINGS.TRIM_SILENCE.DEFAULT_ENABLED,
                    trimSilenceStart: CAS_CONFIG.SETTINGS.TRIM_SILENCE.DEFAULT_START,
                    trimSilenceEnd: CAS_CONFIG.SETTINGS.TRIM_SILENCE.DEFAULT_END,
                    trimSilenceThreshold: CAS_CONFIG.SETTINGS.TRIM_SILENCE.DEFAULT_THRESHOLD_DB,
                    trimSilencePadding: CAS_CONFIG.SETTINGS.TRIM_SILENCE.DEFAULT_PADDING_MS,
                    volumeStabilizationEnabled: CAS_CONFIG.SETTINGS.STABILIZER.DEFAULT_ENABLED,
                    volumeStabilizationMode: CAS_CONFIG.SETTINGS.STABILIZER.DEFAULT_MODE,
                    volumeNormalizationEnabled: CAS_CONFIG.SETTINGS.STABILIZER.DEFAULT_NORMALIZATION_ENABLED,
                    volumeTargetLevel: CAS_CONFIG.SETTINGS.STABILIZER.DEFAULT_TARGET_LUFS
                };
                this.app.refreshAudioAnalysis();
                this.app.syncSettingsUI();
                this.app.applyStabilizerSettings();
                this.app.saveStoredData();
                this.app.updateStatus('Настройки звука сброшены по умолчанию', 'success');
            });
        }

        this.app.syncSettingsUI();
        if (typeof window !== 'undefined' && window.lucide) {
            window.lucide.createIcons();
        }
    }

    syncSettingsUI() {
        if (typeof document === 'undefined') return;
        const folderEl = document.getElementById('settingsCurrentMusicFolder');
        if (folderEl) {
            folderEl.textContent = this.app.config?.musicFolder || 'Папка не выбрана';
        }

        const s = this.app.audioSettings;
        if (!s) return;

        const trimEnabled = document.getElementById('settingTrimSilenceEnabled');
        if (trimEnabled) trimEnabled.checked = Boolean(s.trimSilenceEnabled);

        const trimOptions = document.getElementById('trimSilenceOptions');
        if (trimOptions) {
            trimOptions.classList.toggle('is-disabled', !s.trimSilenceEnabled);
            trimOptions.style.opacity = '';
            trimOptions.style.pointerEvents = '';
        }

        const trimStart = document.getElementById('settingTrimSilenceStart');
        if (trimStart) trimStart.checked = Boolean(s.trimSilenceStart);

        const trimEnd = document.getElementById('settingTrimSilenceEnd');
        if (trimEnd) trimEnd.checked = Boolean(s.trimSilenceEnd);

        const trimThreshold = document.getElementById('settingTrimSilenceThreshold');
        if (trimThreshold) trimThreshold.value = s.trimSilenceThreshold;
        const trimThresholdVal = document.getElementById('settingTrimSilenceThresholdVal');
        if (trimThresholdVal) trimThresholdVal.textContent = `${s.trimSilenceThreshold} dB`;

        const trimPadding = document.getElementById('settingTrimSilencePadding');
        if (trimPadding) trimPadding.value = s.trimSilencePadding;
        const trimPaddingVal = document.getElementById('settingTrimSilencePaddingVal');
        if (trimPaddingVal) trimPaddingVal.textContent = `${s.trimSilencePadding} мс`;

        const volStabEnabled = document.getElementById('settingVolumeStabilizationEnabled');
        if (volStabEnabled) volStabEnabled.checked = Boolean(s.volumeStabilizationEnabled);

        const volStabOptions = document.getElementById('volumeStabilizationOptions');
        if (volStabOptions) {
            volStabOptions.classList.toggle('is-disabled', !s.volumeStabilizationEnabled);
            volStabOptions.style.opacity = '';
            volStabOptions.style.pointerEvents = '';
        }

        const volStabMode = document.getElementById('settingVolumeStabilizationMode');
        if (volStabMode) volStabMode.value = s.volumeStabilizationMode || 'theatre';

        const volNormEnabled = document.getElementById('settingVolumeNormalizationEnabled');
        if (volNormEnabled) volNormEnabled.checked = Boolean(s.volumeNormalizationEnabled);

        const volTargetLevel = document.getElementById('settingVolumeTargetLevel');
        if (volTargetLevel) volTargetLevel.value = String(s.volumeTargetLevel || -14);
    }
}

    return { CASControlsController };
});
