(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_LOGGER } = dependencies;

// Phone commands and snapshots; networking remains in the main process.
class CASRemoteController {
    constructor(app) {
        this.app = app;
    }

    async showRemoteControlDialog() {
        if (typeof document === 'undefined') return;
        const dialog = document.getElementById('remoteConnectDialog');
        if (!dialog) return;

        await this.app.refreshRemoteControlStatus();

        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        }
    }

    async refreshRemoteControlStatus() {
        const api = typeof window !== 'undefined' ? window.electronAPI : null;
        if (!api?.getRemoteServerStatus) return;
        try {
            const res = await api.getRemoteServerStatus();
            if (res && res.success && res.status) {
                this.app.updateRemoteDialogUI(res.status);
            }
        } catch (e) {
            CAS_LOGGER?.error?.('Ошибка получения статуса мобильного пульта:', e);
        }
    }

    updateRemoteDialogUI(status) {
        if (typeof document === 'undefined') return;
        const toggle = document.getElementById('remoteServerToggle');
        const toggleStatus = document.getElementById('remoteServerToggleStatus');
        const activeSection = document.getElementById('remoteServerActiveSection');
        const disabledSection = document.getElementById('remoteServerDisabledSection');
        const qrBox = document.getElementById('remoteQrBox');
        const urlInput = document.getElementById('remoteUrlInput');
        const pinValue = document.getElementById('remotePinValue');
        const clientsText = document.getElementById('remoteClientsText');

        const isRunning = Boolean(status?.running);
        if (toggle) toggle.checked = isRunning;
        if (toggleStatus) {
            toggleStatus.textContent = isRunning ? 'ВКЛ' : 'ВЫКЛ';
            toggleStatus.style.color = isRunning ? '#34c759' : '#8e8e93';
        }

        if (isRunning) {
            if (activeSection) activeSection.hidden = false;
            if (disabledSection) disabledSection.hidden = true;
            if (qrBox && status?.svgQrCode) qrBox.innerHTML = status.svgQrCode;
            if (urlInput && status?.primaryUrl) urlInput.value = status.primaryUrl;
            if (pinValue && status?.pin) pinValue.textContent = status.pin;
            if (clientsText && typeof status?.clientCount === 'number') {
                clientsText.textContent = `Подключено устройств: ${status.clientCount}`;
            }
        } else {
            if (activeSection) activeSection.hidden = true;
            if (disabledSection) disabledSection.hidden = false;
        }
    }

    setupRemoteControlDialog() {
        if (typeof document === 'undefined') return;
        const dialog = document.getElementById('remoteConnectDialog');
        const toggle = document.getElementById('remoteServerToggle');
        const copyBtn = document.getElementById('copyRemoteUrlBtn');
        const closeBtn = document.getElementById('closeRemoteDialogBtn');
        const urlInput = document.getElementById('remoteUrlInput');

        if (toggle) {
            toggle.addEventListener('change', async (e) => {
                const desired = e.target.checked;
                const api = typeof window !== 'undefined' ? window.electronAPI : null;
                try {
                    const res = await api?.toggleRemoteServer?.(desired);
                    if (res && res.status) {
                        this.app.updateRemoteDialogUI(res.status);
                        this.app.broadcastRemoteState();
                    }
                } catch (err) {
                    CAS_LOGGER?.error?.('Ошибка переключения сервера мобильного пульта:', err);
                    toggle.checked = !desired;
                }
            });
        }

        if (copyBtn && urlInput) {
            copyBtn.addEventListener('click', async () => {
                const text = urlInput.value;
                if (!text || text === 'http://...') return;
                try {
                    await navigator.clipboard.writeText(text);
                    const originalHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="fas fa-check" style="color: #34c759"></i>';
                    setTimeout(() => { copyBtn.innerHTML = originalHtml; }, 2000);
                    this.app.updateStatus?.('Ссылка на пульт скопирована', 'success');
                } catch {
                    urlInput.select();
                    document.execCommand('copy');
                    this.app.updateStatus?.('Ссылка скопирована', 'success');
                }
            });
        }

        if (closeBtn && dialog) {
            closeBtn.addEventListener('click', () => dialog.close());
        }

        if (dialog) {
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) dialog.close();
            });
        }
    }

    initRemoteControl() {
        this.app.setupRemoteControlDialog();

        const api = typeof window !== 'undefined' ? window.electronAPI : null;
        if (api?.onRemoteCommand) {
            api.onRemoteCommand((cmd) => {
                if (!cmd || !cmd.action) return;
                switch (cmd.action) {
                    case 'play':
                        if (!this.app.isPlaying || this.app.isPaused) this.app.playMusic();
                        break;
                    case 'pause':
                        if (this.app.isPlaying && !this.app.isPaused) this.app.pauseMusic();
                        break;
                    case 'playPause':
                        if (this.app.isPlaying && !this.app.isPaused) {
                            this.app.pauseMusic();
                        } else {
                            this.app.playMusic();
                        }
                        break;
                    case 'stop':
                        this.app.stopMusic();
                        break;
                    case 'next':
                        this.app.nextTrack();
                        break;
                    case 'prev':
                        this.app.previousTrack();
                        break;
                    case 'panicMute':
                        this.app.togglePanicMute();
                        break;
                    case 'setVolume':
                        if (typeof cmd.volume === 'number') {
                            const vol = Math.max(0, Math.min(1, cmd.volume));
                            this.app.setMusicVolume(vol);
                            if (typeof document !== 'undefined') {
                                const slider = document.getElementById('musicVolume');
                                if (slider) slider.value = Math.round(vol * 100);
                            }
                        }
                        break;
                    case 'selectDeck':
                        if (cmd.deck === 'A' || cmd.deck === 'B') {
                            this.app.setActiveDeck(cmd.deck);
                        }
                        break;
                    case 'selectTrack': {
                        const targetDeck = cmd.deck || this.app.activeDeck || 'A';
                        const targetIndex = Number(cmd.index);
                        if (['A', 'B'].includes(targetDeck) && Number.isInteger(targetIndex)
                            && targetIndex >= 0 && targetIndex < (this.app.decks?.[targetDeck]?.tracks?.length || 0)) {
                            this.app.setActiveDeck(targetDeck);
                            if (cmd.autoplay) {
                                this.app.playTrackInDeck(targetDeck, targetIndex);
                            } else {
                                this.app.loadTrack(targetIndex, { deckId: targetDeck });
                                this.app.currentTrackIndex = targetIndex;
                                if (this.app.decks?.[targetDeck]) this.app.decks[targetDeck].currentTrackIndex = targetIndex;
                                this.app.highlightCurrentTrack();
                                this.app.updateDeckUI();
                            }
                        }
                        break;
                    }
                    case 'triggerPad': {
                        const padIdx = Number(cmd.index);
                        if (Number.isInteger(padIdx) && padIdx >= 0 && padIdx < 12) {
                            this.app.playSoundEffect(padIdx);
                        }
                        break;
                    }
                    case 'stopPads':
                        this.app.stopAllEffects();
                        break;
                }
                this.app.broadcastRemoteState();
            });
        }

        if (api?.onRemoteClientCount) {
            api.onRemoteClientCount((count) => {
                // Keep paused/idle playback and lazy-loaded pads current on connected phones.
                // Progress tracking alone only publishes while music is playing.
                if (count > 0 && !this.remoteStateInterval) {
                    this.app.broadcastRemoteState();
                    this.remoteStateInterval = setInterval(() => this.app.broadcastRemoteState(), 1000);
                } else if (!count && this.remoteStateInterval) {
                    clearInterval(this.remoteStateInterval);
                    this.remoteStateInterval = null;
                }
                if (typeof document !== 'undefined') {
                    const countEl = document.getElementById('remoteClientsText');
                    if (countEl) countEl.textContent = `Подключено устройств: ${count}`;
                }
            });
        }

        this.app.refreshRemoteControlStatus();
    }

    getRemoteStateSnapshot() {
        const curDeckId = this.app.playingDeck || this.app.activeDeck || 'A';
        const deck = this.app.decks ? this.app.decks[curDeckId] : null;
        const currentTrack = this.app.musicPlayerTrack
            || deck?.tracks?.[deck?.currentTrackIndex]
            || null;

        let trackInfo = null;
        if (currentTrack) {
            let cur = 0;
            let dur = 0;
            if (this.app.musicPlayer && this.app.musicPlayerTrack === currentTrack) {
                try {
                    cur = this.app.musicPlayer.seek() || 0;
                    dur = this.app.musicPlayer.duration() || 0;
                } catch {}
            } else if (typeof currentTrack.duration === 'number') {
                dur = currentTrack.duration;
            }
            const effectiveEnd = typeof this.app.getTrackEffectiveEnd === 'function' ? this.app.getTrackEffectiveEnd(currentTrack, dur) : dur;
            const targetEnd = (Number.isFinite(effectiveEnd) && effectiveEnd > 0 && effectiveEnd <= dur) ? effectiveEnd : dur;
            const rem = Math.max(0, targetEnd - cur);

            trackInfo = {
                deck: curDeckId,
                title: (typeof this.app.getTrackTitle === 'function' ? this.app.getTrackTitle(currentTrack) : null) || currentTrack.name || currentTrack.filename || 'Без названия',
                artist: currentTrack.artist || deck?.playlist?.name || 'CAS',
                playlistName: deck?.playlist?.name || '',
                currentTime: cur,
                duration: dur,
                remainingTime: rem
            };
        }

        const mapTracks = (deckId) => {
            if (!this.app.decks || !this.app.decks[deckId] || !Array.isArray(this.app.decks[deckId].tracks)) return [];
            return this.app.decks[deckId].tracks.map((t, idx) => ({
                index: idx,
                name: (typeof this.app.getTrackTitle === 'function' ? this.app.getTrackTitle(t) : null) || t.name || t.filename || `Трек ${idx + 1}`,
                durationStr: (typeof t.duration === 'number' && t.duration > 0 && typeof this.app.formatTime === 'function') ? this.app.formatTime(t.duration) : '--:--',
                isPlaying: Boolean(this.app.playingDeck === deckId && this.app.decks[deckId].currentTrackIndex === idx && this.app.isPlaying && !this.app.isPaused)
            }));
        };

        const pads = [];
        for (let i = 0; i < 12; i++) {
            const soundData = this.app.soundEffects?.get?.(i);
            const isAssigned = Boolean(soundData && soundData.path);
            let isPlaying = false;
            if (isAssigned && soundData?.sound) {
                try {
                    isPlaying = Boolean(soundData.sound.playing && soundData.sound.playing());
                } catch {}
            }
            pads.push({
                index: i,
                name: (typeof this.app.getPadLabel === 'function' ? this.app.getPadLabel(i) : null) || `Пэд ${i + 1}`,
                isAssigned,
                isPlaying
            });
        }

        return {
            activeDeck: this.app.activeDeck || 'A',
            playingDeck: this.app.playingDeck || null,
            isPlaying: Boolean(this.app.isPlaying && !this.app.isPaused),
            isPaused: Boolean(this.app.isPaused),
            isMuted: Boolean(this.app.isMuted),
            masterVolume: typeof this.app.musicVolume === 'number' ? this.app.musicVolume : 1.0,
            currentTrack: trackInfo,
            deckA: {
                name: this.app.decks?.A?.playlist?.name || 'Дека A',
                tracks: mapTracks('A')
            },
            deckB: {
                name: this.app.decks?.B?.playlist?.name || 'Дека B',
                tracks: mapTracks('B')
            },
            pads
        };
    }

    broadcastRemoteState() {
        const api = typeof window !== 'undefined' ? window.electronAPI : null;
        if (!api?.pushRemoteState) return;
        try {
            const state = this.app.getRemoteStateSnapshot();
            api.pushRemoteState(state);
        } catch (e) {
            CAS_LOGGER?.error?.('Ошибка отправки состояния на пульт:', e);
        }
    }
}

    return { CASRemoteController };
});
