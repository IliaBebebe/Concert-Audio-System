(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG, CAS_LOGGER } = dependencies;

// The active Howler player, transport state, progress and music volume.
class CASPlaybackController {
    constructor(app) {
        this.app = app;
        this.musicPlayer = null;
        this.musicPlayerDeck = null;
        this.musicPlayerTrack = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.isMuted = false;
        this.musicPlayerToken = 0;
        this.pendingMusicStart = false;
        this.musicRetryTimeout = null;
        this.playbackMode = 'sequential';
        this.musicVolume = CAS_CONFIG.AUDIO.DEFAULT_MUSIC_VOLUME;
        this.progressAnimationFrame = null;
        this.lastTimeUpdate = null;
        this.volumeUpdateTimeout = null;
        this.musicVolumeTimeout = null;
    }

    loadTrack(index, options = {}) {
        const deckId = options.deckId || this.app.playingDeck || this.app.activeDeck;
        const deck = this.app.decks[deckId];
        const tracks = deck?.tracks || this.app.playlistTracks;
        if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return;

        const {
            preserveCurrent = false,
            initialVolume = this.musicVolume,
            fadeInMs = 0,
            onPlaybackStart,
            onPlaybackError
        } = options;

        if (!preserveCurrent) {
            this.app.stopMusic({ silent: true });
        } else {
            this.app.stopProgressTracking(false);
            this.pendingMusicStart = false;
            this.isPlaying = false;
        }

        if (preserveCurrent) this.app.playingDeck = deckId;
        if (deck) deck.currentTrackIndex = index;
        const track = tracks[index];
        this.musicPlayerDeck = deckId;
        this.musicPlayerTrack = track;

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
            this.app.playingDeck = null;
            this.app.stopProgressTracking();
            try { player.unload(); } catch {}
            this.musicPlayerDeck = null;
            this.musicPlayerTrack = null;
            if (onPlaybackError?.()) return;
            this.app.crossfadeTimers.forEach((timer) => clearTimeout(timer));
            this.app.crossfadeTimers.clear();
            this.app.retiringMusicPlayers.forEach((p) => {
                try { p.stop(); p.unload(); } catch {}
            });
            this.app.retiringMusicPlayers.clear();
            this.app.retiringMusicDeadlines?.clear();
            this.app.isCrossfading = false;
            this.app.updateDeckUI();
            this.app.updateStatus(message, 'error');
        };

        player = new Howl({
            src: [this.app.toSafeAudioSource(track.path)],
            format: this.app.getAudioFormat(track.path),
            html5: true,
            volume: initialVolume,
            mute: this.isMuted,
            loop: this.playbackMode === 'loop',
            onplay: () => {
                if (!isCurrentPlayer()) return;
                this.consecutivePlayErrors = 0;
                if (this.musicRetryTimeout) {
                    clearTimeout(this.musicRetryTimeout);
                    this.musicRetryTimeout = null;
                }
                this.app.resumeAudioContext();
                setTimeout(() => {
                    if (isCurrentPlayer()) this.app.connectHowlToAnalyser(player, 'music');
                }, 0);
                this.pendingMusicStart = false;
                this.isPlaying = true;
                this.isPaused = false;
                this.app.playingDeck = this.musicPlayerDeck;
                // Native HTML5 looping rewinds before this callback, including its async play lock.
                const start = this.app.getTrackEffectiveStart(track);
                if (start > 0 && start < player.duration() && player.seek() < .05) player.seek(start);
                if (!fadeInApplied) onPlaybackStart?.();
                if (fadeInMs > 0 && !fadeInApplied) {
                    fadeInApplied = true;
                    try {
                        const targetVolume = this.musicVolume;
                        player.fade(0, targetVolume, fadeInMs);
                    } catch {
                        try { player.volume(this.musicVolume); } catch {}
                    }
                }
                fadeInApplied = true;
                this.app.updateStatus(`Воспроизведение: ${this.app.getTrackTitle(track)}`);
                this.app.startProgressTracking();
                this.app.updateVuMeters();
                this.app.highlightCurrentTrack();
                this.app.updateDeckUI();
            },
            onpause: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPaused = true;
                this.app.stopProgressTracking(false);
                this.app.updateStatus('Пауза');
                this.app.updateDeckUI();
            },
            onstop: () => {
                if (!isCurrentPlayer()) return;
                this.pendingMusicStart = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.app.updateStatus('Остановлено');
                this.app.stopProgressTracking();
                this.app.playingDeck = null;
                this.app.updateDeckUI();
            },
            onend: () => {
                this.app.handleTrackEnd(player, playerToken);
            },
            onload: () => {
                if (!isCurrentPlayer()) return;
                this.app.connectHowlToAnalyser(player, 'music');
                this.app.updateTrackNormalization(track);
                const startOffset = this.app.getTrackEffectiveStart(track);
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
                this.app.updateWaveformProgress(progress);
                this.app.updateTimeDisplays(player);
            },
            onloaderror: () => {
                discardFailedPlayer('Ошибка загрузки трека');
            },
            onplayerror: () => {
                if (!isCurrentPlayer()) return;
                if (onPlaybackError) {
                    discardFailedPlayer('Ошибка воспроизведения трека');
                    return;
                }
                this.pendingMusicStart = false;
                this.isPlaying = false;
                this.isPaused = false;
                this.app.playingDeck = this.musicPlayerDeck;
                this.app.stopProgressTracking(false);
                this.app.updateStatus('Ошибка воспроизведения', 'error');
                this.app.updateDeckUI();

                this.consecutivePlayErrors = (this.consecutivePlayErrors || 0) + 1;
                const currentDeckId = this.app.playingDeck || this.app.activeDeck;
                const currentDeck = this.app.decks[currentDeckId];
                const maxErrors = Math.max(1, currentDeck?.tracks?.length || 1);
                if (this.consecutivePlayErrors >= maxErrors) {
                    this.app.stopMusic({ silent: true });
                    this.consecutivePlayErrors = 0;
                    this.app.updateStatus('Не удалось воспроизвести треки в плейлисте', 'error');
                    return;
                }

                if (this.playbackMode === 'sequential' && !this.musicRetryTimeout) {
                    this.musicRetryTimeout = setTimeout(() => {
                        this.musicRetryTimeout = null;
                        if (isCurrentPlayer()) this.app.nextTrack();
                    }, 1000);
                }
            }
        });
        this.musicPlayer = player;

        this.app.updateCurrentTrackDisplay(track);
        this.app.updateMediaSessionMetadata(track);
        this.app.highlightCurrentTrack();
        this.app.loadWaveformForTrack(track);
        return player;
    }

    handleTrackEnd(player = this.musicPlayer, playerToken = this.musicPlayerToken) {
        if (this.musicPlayer !== player || this.musicPlayerToken !== playerToken) return;
        if (this.playbackMode === 'loop') {
            const duration = player.duration();
            const start = this.app.getTrackEffectiveStart(this.musicPlayerTrack);
            const end = this.app.getTrackEffectiveEnd(this.musicPlayerTrack, duration);
            if (start > 0 || end < duration) {
                if (!player.playing()) return;
                player.seek(start < duration ? start : 0);
                this.app.startProgressTracking();
            }
            return;
        }

        switch (this.playbackMode) {
            case 'sequential': {
                const deckId = this.app.playingDeck || this.app.activeDeck;
                const deck = this.app.decks[deckId];
                if (deck && deck.tracks && deck.currentTrackIndex + 1 >= deck.tracks.length) {
                    this.app.stopMusic({ cancelOnline: false });
                    this.app.updateStatus('Воспроизведение завершено');
                } else {
                    this.app.nextTrack();
                }
                break;
            }
            case 'single':
                this.app.stopMusic({ cancelOnline: false });
                break;
        }
    }

    playMusic(options = {}) {
        if (this.pendingMusicStart) return;
        if (!this.isPlaying && !this.isPaused) {
            const targetDeckId = this.app.activeDeck;
            const deck = this.app.decks[targetDeckId];
            const cuedDeckId = this.musicPlayerDeck ?? this.app.playingDeck;
            if (!this.musicPlayer || cuedDeckId !== targetDeckId ||
                (this.musicPlayerTrack && this.musicPlayerTrack !== deck?.tracks?.[deck.currentTrackIndex])) {
                if (!deck || !deck.tracks || deck.tracks.length === 0) {
                    this.app.updateStatus('Сначала выберите трек', 'warning');
                    return;
                }
                const trackIndex = deck.currentTrackIndex || 0;
                this.app.loadTrack(trackIndex, { deckId: targetDeckId });
            }
        } else if (!this.musicPlayer) {
            const targetDeckId = this.app.playingDeck || this.app.activeDeck;
            const deck = this.app.decks[targetDeckId];
            if (!deck || !deck.tracks || deck.tracks.length === 0) {
                this.app.updateStatus('Сначала выберите трек', 'warning');
                return;
            }
            const trackIndex = deck.currentTrackIndex || 0;
            this.app.loadTrack(trackIndex, { deckId: targetDeckId });
        }

        this.app.resumeAudioContext();
        const player = this.musicPlayer;
        if (!player) return;

        const isPlayerActuallyPlaying = Boolean(player.playing && player.playing());
        if (this.pendingMusicStart || (!this.isPaused && isPlayerActuallyPlaying)) {
            return;
        }

        if (this.isPaused && !this.isMuted) {
            try {
                const currentVol = typeof player.volume === 'function' ? player.volume() : null;
                if (typeof currentVol === 'number' && currentVol < this.musicVolume) {
                    player.fade(currentVol, this.musicVolume, 250);
                }
            } catch {}
        } else if (!this.isPaused && player) {
            const effectiveStart = this.app.getTrackEffectiveStart(this.musicPlayerTrack);
            if (effectiveStart > 0 && typeof player.seek === 'function') {
                try {
                    const currentSeek = player.seek();
                    if (typeof currentSeek === 'number' && currentSeek < 0.05) {
                        player.seek(effectiveStart);
                    }
                } catch {}
            }
        }

        this.pendingMusicStart = true;
        this.app.updateDeckUI();
        try {
            const soundId = player.play();
            if (soundId === null || soundId === undefined) {
                this.pendingMusicStart = false;
                this.app.updateDeckUI();
                this.app.updateStatus('Не удалось запустить трек', 'error');
            }
        } catch (error) {
            CAS_LOGGER.error('Ошибка вызова player.play():', error);
            if (this.musicPlayer === player) this.pendingMusicStart = false;
            this.app.updateDeckUI();
            this.app.updateStatus('Ошибка воспроизведения', 'error');
        }
    }

    pauseMusic() {
        this.onlinePlayIntent = (this.onlinePlayIntent || 0) + 1;
        if (!this.musicPlayer) return;
        if (this.pendingMusicStart && !this.isPlaying) {
            this.app.stopMusic({ silent: true });
            this.app.updateStatus('Запуск отменен');
            return;
        }
        if ((this.isPlaying && !this.isPaused) || this.pendingMusicStart) {
            this.musicPlayer.pause();
            this.app.retiringMusicPlayers.forEach((retiringPlayer) => {
                try {
                    retiringPlayer.stop();
                    retiringPlayer.unload();
                } catch {}
            });
            this.app.retiringMusicPlayers.clear();
            this.app.retiringMusicDeadlines?.clear();
            this.app.crossfadeTimers.forEach((timer) => clearTimeout(timer));
            this.app.crossfadeTimers.clear();
            this.app.isCrossfading = false;
            this.app.clearRemainingTimeWarning();
            this.app.updateDeckUI();
        }
    }

    stopMusic({ silent = false, cancelOnline = !silent } = {}) {
        if (cancelOnline) this.onlinePlayIntent = (this.onlinePlayIntent || 0) + 1;
        const player = this.musicPlayer;
        this.musicPlayer = null;
        this.musicPlayerDeck = null;
        this.musicPlayerTrack = null;
        this.app.crossfadeOutgoingDeck = null;
        this.musicPlayerToken++;
        this.pendingMusicStart = false;
        if (this.musicRetryTimeout) {
            clearTimeout(this.musicRetryTimeout);
            this.musicRetryTimeout = null;
        }
        this.app.crossfadeTimers.forEach((timer) => clearTimeout(timer));
        this.app.crossfadeTimers.clear();
        this.app.retiringMusicPlayers.forEach((retiringPlayer) => {
            try {
                retiringPlayer.stop();
                retiringPlayer.unload();
            } catch {}
        });
        this.app.retiringMusicPlayers.clear();
        this.app.retiringMusicDeadlines?.clear();
        this.app.isCrossfading = false;
        this.isPlaying = false;
        this.isPaused = false;
        this.app.playingDeck = null;
        this.app.stopProgressTracking();
        this.app.highlightCurrentTrack();
        this.app.updateDeckUI();

        if (player) {
            try {
                player.unload(); // unload вместо stop для освобождения памяти
            } catch (e) {
                console.warn('Ошибка при выгрузке:', e);
            }
        }
        if (!silent) this.app.updateStatus('Остановлено');
    }

    previousTrack() {
        this.app._navigateTrack(-1);
    }

    nextTrack() {
        this.app._navigateTrack(1);
    }

    _navigateTrack(direction) {
        const deckId = this.app.playingDeck || this.app.activeDeck;
        const deck = this.app.decks[deckId];
        if (!deck || deck.tracks.length === 0) return;
        const newIndex = (deck.currentTrackIndex + direction + deck.tracks.length) % deck.tracks.length;
        this.app.playTrackInDeck(deckId, newIndex);
    }

    startProgressTracking() {
        this.app.stopProgressTracking(false);
        const player = this.musicPlayer;
        const playerToken = this.musicPlayerToken;
        if (!player || !this.isPlaying || this.isPaused) return;

        if (this.app.isVisualsHidden()) {
            this.app.startBackgroundCrossfadeTracking();
            return;
        }

        let frameId = null;
        let lastPaint = -Infinity;
        const progressBar = document.getElementById('progressBar');
        const updateProgress = (timestamp) => {
            if (this.musicPlayer !== player || this.musicPlayerToken !== playerToken || !this.isPlaying || this.isPaused) {
                if (this.progressAnimationFrame === frameId) this.progressAnimationFrame = null;
                return;
            }

            try {
                const seek = player.seek();
                const duration = player.duration();

                if (duration > 0 && !isNaN(seek) && !isNaN(duration)) {
                    const effectiveEnd = this.app.getTrackEffectiveEnd(this.musicPlayerTrack, duration);
                    if (this.app.audioSettings?.trimSilenceEnabled && this.app.audioSettings?.trimSilenceEnd && effectiveEnd < duration - 0.25) {
                        if (seek >= effectiveEnd) {
                            this.app.handleTrackEnd(player, playerToken);
                            return;
                        }
                    }
                    this.app.maybeStartAutomaticCrossfade(player, playerToken, seek, duration);
                    if (timestamp - lastPaint >= CAS_CONFIG.UI.PROGRESS_PAINT_INTERVAL_MS) {
                        lastPaint = timestamp;
                        const progress = Math.min(100, Math.max(0, (seek / duration) * 100));
                        if (progressBar) progressBar.value = progress;
                        this.app.updateWaveformProgress(progress);
                        const now = Date.now();
                        if (!this.lastTimeUpdate || now - this.lastTimeUpdate >= CAS_CONFIG.AUDIO.PROGRESS_INTERVAL_MS) {
                            this.app.updateTimeDisplays(player);
                            this.lastTimeUpdate = now;
                        }
                    }
                }
            } catch {}

            frameId = requestAnimationFrame(updateProgress);
            this.progressAnimationFrame = frameId;
        };

        frameId = requestAnimationFrame(updateProgress);
        this.progressAnimationFrame = frameId;
    }

    clearRemainingTimeWarning() {
        if (typeof document === 'undefined') return;
        const remainingDisplay = document.getElementById('remainingTimeDisplay');
        if (remainingDisplay) {
            remainingDisplay.classList.remove('warning', 'danger', 'is-warning', 'is-critical', 'ending-warning', 'ending-critical');
        }
    }

    updateTimeDisplays(player = this.musicPlayer) {
        if (typeof document === 'undefined') return;
        if (player) {
            try {
                const seek = player.seek();
                const duration = player.duration();

                if (!isNaN(seek) && !isNaN(duration) && duration > 0) {
                    const currentTime = this.app.formatTime(seek);
                    const totalTime = this.app.formatTime(duration);
                    const effectiveEnd = this.app.getTrackEffectiveEnd(this.musicPlayerTrack, duration);
                    const targetEnd = (Number.isFinite(effectiveEnd) && effectiveEnd > 0 && effectiveEnd <= duration)
                        ? effectiveEnd
                        : duration;
                    const remaining = Math.max(0, targetEnd - seek);
                    const remainingTime = `-${this.app.formatTime(remaining)}`;

                    if (!this._cachedTimeDisplays) {
                        this._cachedTimeDisplays = {
                            current: document.getElementById('currentTimeDisplay'),
                            total: document.getElementById('totalTimeDisplay'),
                            remaining: document.getElementById('remainingTimeDisplay')
                        };
                    }
                    const displays = this._cachedTimeDisplays;
                    const seekControl = document.getElementById('progressBar');
                    seekControl?.setAttribute('aria-valuetext', `${currentTime} из ${totalTime}`);
                    if (this.lastRulerDuration !== duration) {
                        document.querySelectorAll('.seek-ruler [data-fraction]').forEach(label => {
                            label.textContent = this.app.formatTime(duration * Number(label.dataset.fraction));
                        });
                        this.lastRulerDuration = duration;
                    }

                    if (displays.current) displays.current.textContent = currentTime;
                    if (displays.total) displays.total.textContent = totalTime;
                    if (displays.remaining) {
                        displays.remaining.textContent = remainingTime;
                        displays.remaining.classList.remove('warning', 'danger', 'is-warning', 'is-critical', 'ending-warning', 'ending-critical');

                        const isPlaying = this.isPlaying && !this.isPaused && remaining > 0;
                        if (isPlaying && remaining <= 5) {
                            displays.remaining.classList.add('danger', 'is-critical', 'ending-critical');
                        } else if (isPlaying && remaining <= 15) {
                            displays.remaining.classList.add('warning', 'is-warning', 'ending-warning');
                        }
                    }

                    const now = Date.now();
                    if (!this.app._lastRemoteTimeBroadcast || (now - this.app._lastRemoteTimeBroadcast >= 500)) {
                        this.app._lastRemoteTimeBroadcast = now;
                        this.app.broadcastRemoteState();
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
        this.app.stopBackgroundCrossfadeTracking();
        if (!reset) return;

        const progressBar = document.getElementById('progressBar');
        const currentTimeDisplay = document.getElementById('currentTimeDisplay');
        const totalTimeDisplay = document.getElementById('totalTimeDisplay');
        const remainingTimeDisplay = document.getElementById('remainingTimeDisplay');

        if (progressBar) progressBar.value = 0;
        this.app.updateWaveformProgress(0);
        if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
        if (totalTimeDisplay) totalTimeDisplay.textContent = '0:00';
        if (remainingTimeDisplay) {
            remainingTimeDisplay.textContent = '-0:00';
            this.app.clearRemainingTimeWarning();
        }

        this.lastTimeUpdate = null;
    }

    seekMusic(progress) {
        if (this.musicPlayer) {
            try {
                const duration = this.musicPlayer.duration();
                if (duration && duration > 0) {
                    const clampedProgress = Math.min(100, Math.max(0, Number(progress) || 0));
                    const seekTime = Math.max(0, Math.min(duration, (clampedProgress / 100) * duration));
                    this.musicPlayer.seek(seekTime);
                    const progressBar = document.getElementById('progressBar');
                    if (progressBar) progressBar.value = clampedProgress;
                    this.app.updateWaveformProgress(clampedProgress);
                    this.app.updateTimeDisplays();
                }
            } catch (error) {
                this.app.updateStatus('Ошибка перемотки', 'error');
            }
        }
    }

    setMusicVolume(volume) {
        volume = Math.max(0, Math.min(1, Number(volume) || 0));
        this.musicVolume = volume;

        const volumeValueEl = typeof document !== 'undefined' ? document.getElementById('musicVolumeValue') : null;
        if (volumeValueEl) {
            volumeValueEl.textContent = `${Math.round(volume * 100)}%`;
        }
        this.app.broadcastRemoteState();

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
            // Cap retiring crossfade players to new master volume
            this.app.retiringMusicPlayers.forEach((player) => {
                try {
                    const currentVol = player.volume();
                    if (Number.isFinite(currentVol) && currentVol > volume) {
                        player.volume(volume);
                    }
                    const deadline = this.app.retiringMusicDeadlines?.get(player);
                    if (Number.isFinite(currentVol) && Number.isFinite(deadline)) {
                        // Howler.volume() cancels a running fade; resume its remaining ramp.
                        player.fade(Math.min(currentVol, volume), 0, Math.max(0, deadline - Date.now()));
                    }
                } catch {}
            });
            this.app.saveStoredData();
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
                        this.app.playMusic();
                    });
                    navigator.mediaSession.setActionHandler('pause', () => {
                        this.app.pauseMusic();
                    });
                    navigator.mediaSession.setActionHandler('stop', () => {
                        this.app.stopMusic();
                        this.app.stopAllEffects();
                    });
                    navigator.mediaSession.setActionHandler('previoustrack', () => {
                        this.app.previousTrack();
                    });
                    navigator.mediaSession.setActionHandler('nexttrack', () => {
                        this.app.nextTrack();
                    });
                } catch (e) {}
            } catch (error) {}
        }
    }

    updateMediaSessionMetadata(track) {
        if ('mediaSession' in navigator && 'MediaMetadata' in window) {
            try {
                const title = typeof track === 'string' ? track : this.app.getTrackTitle(track);
                const artist = typeof track === 'string' ? 'Concert Audio System' : this.app.getTrackArtist(track);
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: title || 'Theatre Sound Mixer',
                    artist: artist || 'Concert Audio System',
                    album: 'Sound Mixing'
                });
            } catch (error) {}
        }
    }
}

    return { CASPlaybackController };
});
