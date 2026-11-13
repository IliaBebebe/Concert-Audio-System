(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG } = dependencies;

// Crossfade scheduling and the lifetime of outgoing music players.
class CASCrossfadeController {
    constructor(app) {
        this.app = app;
        this.retiringMusicPlayers = new Set();
        this.retiringMusicDeadlines = new Map();
        this.crossfadeTimers = new Set();
        this.isCrossfading = false;
        this.crossfadeEnabled = false;
        this.deckCrossfadeEnabled = false;
        this.crossfadeDuration = CAS_CONFIG.CROSSFADE.DEFAULT_DURATION;
        this.backgroundCrossfadeInterval = null;
    }

    startBackgroundCrossfadeTracking() {
        this.app.stopBackgroundCrossfadeTracking();
        this.backgroundCrossfadeInterval = setInterval(() => {
            this.app.checkCrossfadeTick();
        }, 250);
    }

    stopBackgroundCrossfadeTracking() {
        if (this.backgroundCrossfadeInterval) {
            clearInterval(this.backgroundCrossfadeInterval);
            this.backgroundCrossfadeInterval = null;
        }
    }

    checkCrossfadeTick() {
        const player = this.app.musicPlayer;
        const playerToken = this.app.musicPlayerToken;
        if (!player || !this.app.isPlaying || this.app.isPaused) return;
        try {
            const seek = player.seek();
            const duration = player.duration();
            if (duration > 0 && !isNaN(seek) && !isNaN(duration)) {
                const effectiveEnd = this.app.getTrackEffectiveEnd(this.app.musicPlayerTrack, duration);
                if (this.app.audioSettings?.trimSilenceEnabled && this.app.audioSettings?.trimSilenceEnd && effectiveEnd < duration - 0.25) {
                    if (seek >= effectiveEnd) {
                        this.app.handleTrackEnd(player, playerToken);
                        return;
                    }
                }
                this.app.maybeStartAutomaticCrossfade(player, playerToken, seek, duration);
            }
        } catch {}
    }

    normalizeCrossfadeDuration(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return CAS_CONFIG.CROSSFADE.DEFAULT_DURATION;
        return Math.max(CAS_CONFIG.CROSSFADE.MIN_DURATION, Math.min(CAS_CONFIG.CROSSFADE.MAX_DURATION, Math.round(numericValue)));
    }

    updateCrossfadeControls() {
        const enabledInput = document.getElementById('crossfadeEnabled');
        const deckCrossfadeInput = document.getElementById('deckCrossfadeEnabled');
        const durationInput = document.getElementById('crossfadeDuration');
        const durationValue = document.getElementById('crossfadeDurationValue');

        if (enabledInput) enabledInput.checked = this.crossfadeEnabled;
        if (deckCrossfadeInput) deckCrossfadeInput.checked = this.deckCrossfadeEnabled;

        const anyCrossfade = this.crossfadeEnabled || this.deckCrossfadeEnabled;
        if (durationInput) {
            durationInput.value = String(this.crossfadeDuration);
            durationInput.disabled = !anyCrossfade;
        }
        if (durationValue) {
            durationValue.textContent = `${this.crossfadeDuration} с`;
            durationValue.classList.toggle('is-disabled', !anyCrossfade);
        }
    }

    shouldCrossfadeTo(targetDeckIdOrIndex, maybeIndex) {
        let targetDeckId = this.app.playingDeck || this.app.activeDeck;
        let targetIndex = targetDeckIdOrIndex;
        if (typeof targetDeckIdOrIndex === 'string') {
            targetDeckId = targetDeckIdOrIndex;
            targetIndex = maybeIndex;
        }

        if (this.crossfadeDuration <= 0) return false;
        if (!this.app.musicPlayer || !this.app.isPlaying || this.app.isPaused || this.app.pendingMusicStart) return false;
        if (typeof this.app.musicPlayer.playing === 'function' && !this.app.musicPlayer.playing()) return false;
        if (this.isCrossfading) return false;

        const currentDeckId = this.app.playingDeck || this.app.activeDeck;
        const isSwitchingDecks = currentDeckId !== targetDeckId;

        // Отдельная проверка: между разными деками vs внутри одного плейлиста
        if (isSwitchingDecks) {
            if (!this.deckCrossfadeEnabled) return false;
        } else {
            if (!this.crossfadeEnabled) return false;
        }

        const targetDeck = this.app.decks[targetDeckId];
        if (!targetDeck || !targetDeck.tracks || targetDeck.tracks.length === 0) return false;
        if (targetIndex < 0 || targetIndex >= targetDeck.tracks.length) return false;

        const currentTrackIndex = this.app.decks[currentDeckId]?.currentTrackIndex ?? 0;

        // Не делать кроссфейд в тот же самый трек в том же деке
        if (currentDeckId === targetDeckId && currentTrackIndex === targetIndex) return false;

        return true;
    }

    getCrossfadeDurationMs(player = this.app.musicPlayer) {
        const requestedMs = this.app.normalizeCrossfadeDuration(this.crossfadeDuration) * 1000;
        try {
            const rawDuration = player?.duration();
            const duration = this.app.getTrackEffectiveEnd(this.app.musicPlayerTrack, rawDuration);
            const seek = player?.seek();
            if (Number.isFinite(duration) && Number.isFinite(seek) && duration > seek) {
                return Math.max(250, Math.min(requestedMs, Math.round((duration - seek) * 1000)));
            }
        } catch {}
        return requestedMs;
    }

    startCrossfadeTo(targetDeckId, targetIndex, { automatic = false, onlineHandoff = false } = {}) {
        const configuredFade = this.app.shouldCrossfadeTo(targetDeckId, targetIndex);
        if ((!configuredFade && !onlineHandoff) || this.isCrossfading) {
            this.app.playTrackInDeck(targetDeckId, targetIndex, { forceDirect: true });
            return;
        }

        const outgoingPlayer = this.app.musicPlayer;
        const outgoingDeckId = this.app.playingDeck || this.app.activeDeck;
        const outgoingDeck = this.app.decks[outgoingDeckId];
        const outgoingTrack = outgoingDeck?.tracks?.[outgoingDeck.currentTrackIndex];
        const outgoingIndex = outgoingDeck.currentTrackIndex;
        const outgoingToken = this.app.musicPlayerToken;

        const incomingDeck = this.app.decks[targetDeckId];
        const incomingTrack = incomingDeck?.tracks?.[targetIndex];
        if (!incomingTrack) {
            this.app.playTrackInDeck(targetDeckId, targetIndex, { forceDirect: true });
            return;
        }

        const fadeMs = onlineHandoff && !configuredFade ? 0 : this.app.getCrossfadeDurationMs(outgoingPlayer);
        this.isCrossfading = true;
        this.crossfadeOutgoingDeck = outgoingDeckId;

        this.app.activeDeck = targetDeckId;
        this.app.playingDeck = targetDeckId;
        this.app.currentPlaylist = incomingDeck.playlist;
        this.app.playlistTracks = incomingDeck.tracks;
        this.app.currentTrackIndex = targetIndex;
        incomingDeck.currentTrackIndex = targetIndex;

        // Keep the outgoing audio alive while the next file loads.
        this.retiringMusicPlayers.add(outgoingPlayer);

        const incomingPlayer = this.app.loadTrack(targetIndex, {
            preserveCurrent: true,
            initialVolume: fadeMs > 0 ? 0 : this.app.musicVolume,
            fadeInMs: fadeMs,
            deckId: targetDeckId,
            onPlaybackStart: () => {
                this.app.fadeOutAndUnloadMusicPlayer(outgoingPlayer, fadeMs);
            },
            onPlaybackError: () => {
                this.crossfadeTimers.forEach(clearTimeout);
                this.crossfadeTimers.clear();
                this.retiringMusicPlayers.delete(outgoingPlayer);
                this.retiringMusicDeadlines?.delete(outgoingPlayer);
                this.isCrossfading = false;
                this.crossfadeOutgoingDeck = null;
                if (!outgoingPlayer.playing()) {
                    this.app.stopMusic({ silent: true });
                    this.app.updateStatus('Не удалось загрузить следующий трек', 'error');
                    return true;
                }
                this.app.musicPlayer = outgoingPlayer;
                this.app.musicPlayerToken = outgoingToken;
                this.app.musicPlayerDeck = outgoingDeckId;
                this.app.musicPlayerTrack = outgoingTrack;
                this.app.playingDeck = outgoingDeckId;
                outgoingDeck.currentTrackIndex = outgoingIndex;
                this.app.isPlaying = true;
                this.app.isPaused = false;
                this.automaticCrossfadeBlockedPlayer = outgoingPlayer;
                this.app.updateCurrentTrackDisplay(outgoingTrack);
                this.app.updateMediaSessionMetadata(outgoingTrack);
                this.app.loadWaveformForTrack(outgoingTrack);
                this.app.startProgressTracking();
                this.app.highlightCurrentTrack();
                this.app.updateStatus('Следующий трек недоступен. Текущий продолжает играть', 'error');
                return true;
            }
        });

        if (!incomingPlayer) {
            this.isCrossfading = false;
            return;
        }

        this.app.playMusic({ force: true });

        const fromTitle = outgoingTrack ? this.app.getTrackTitle(outgoingTrack) : 'Трек';
        const toTitle = this.app.getTrackTitle(incomingTrack);
        const deckSwitchText = outgoingDeckId !== targetDeckId ? ` [${outgoingDeckId} → ${targetDeckId}]` : '';
        this.app.updateStatus(`${automatic ? 'Авто-' : ''}Переход${deckSwitchText}: ${fromTitle} → ${toTitle}`);
        this.app.highlightCurrentTrack();
        this.app.updateDeckUI();
    }

    startCrossfadeToIndex(index, options = {}) {
        const deckId = this.app.playingDeck || this.app.activeDeck;
        this.app.startCrossfadeTo(deckId, index, options);
    }

    fadeOutAndUnloadMusicPlayer(player, durationMs) {
        if (!player) return;
        this.retiringMusicPlayers.add(player);
        this.retiringMusicDeadlines ??= new Map();
        this.retiringMusicDeadlines.set(player, Date.now() + durationMs);

        try {
            const currentVolume = Number(player.volume());
            const startVol = Number.isFinite(currentVolume) ? currentVolume : this.app.musicVolume;
            player.fade(startVol, 0, durationMs);
        } catch {
            try { player.volume(0); } catch {}
        }

        const timer = setTimeout(() => {
            this.crossfadeTimers.delete(timer);
            this.retiringMusicPlayers.delete(player);
            this.retiringMusicDeadlines.delete(player);
            try {
                player.stop();
                player.unload();
            } catch {}
            if (this.retiringMusicPlayers.size === 0) {
                this.isCrossfading = false;
                this.crossfadeOutgoingDeck = null;
                this.app.updateDeckUI();
            }
        }, durationMs + 200);
        this.crossfadeTimers.add(timer);
    }

    maybeStartAutomaticCrossfade(player, playerToken, seek, duration) {
        if (!this.crossfadeEnabled
            || this.automaticCrossfadeBlockedPlayer === player
            || this.app.playbackMode !== 'sequential'
            || this.isCrossfading
            || this.app.musicPlayer !== player
            || this.app.musicPlayerToken !== playerToken
            || !Number.isFinite(seek)
            || !Number.isFinite(duration)
            || duration <= 0) {
            return;
        }

        const deckId = this.app.playingDeck || this.app.activeDeck;
        const deck = this.app.decks[deckId];
        if (!deck || !deck.tracks || deck.tracks.length < 2) return;

        const effectiveEnd = this.app.getTrackEffectiveEnd(this.app.musicPlayerTrack, duration);
        const fadeSeconds = this.app.normalizeCrossfadeDuration(this.crossfadeDuration);
        if (effectiveEnd <= fadeSeconds * 1.5) {
            return;
        }

        const remaining = effectiveEnd - seek;
        if (remaining > 0 && remaining <= fadeSeconds && seek > 0.5) {
            const nextIndex = deck.currentTrackIndex + 1;
            if (nextIndex >= deck.tracks.length) {
                return;
            }
            this.app.startCrossfadeTo(deckId, nextIndex, { automatic: true });
        }
    }
}

    return { CASCrossfadeController };
});
