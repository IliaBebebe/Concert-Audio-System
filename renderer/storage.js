(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG, CAS_LOGGER } = dependencies;

// The existing localStorage schema and compatible restoration of saved sessions.
class CASStorageController {
    constructor(app) {
        this.app = app;
        this._saveStoredDataTimeout = null;
    }

    saveStoredData() {
        if (this.restoringStoredData) return;
        if (this._saveStoredDataTimeout) {
            clearTimeout(this._saveStoredDataTimeout);
        }
        this._saveStoredDataTimeout = setTimeout(() => {
            this._saveStoredDataTimeout = null;
            this.app._writeStoredData();
        }, CAS_CONFIG.STORAGE.THROTTLE_MS);
    }

    saveStoredDataImmediate() {
        if (this._saveStoredDataTimeout) {
            clearTimeout(this._saveStoredDataTimeout);
            this._saveStoredDataTimeout = null;
        }
        this.app._writeStoredData();
    }

    _writeStoredData() {
        if (this.restoringStoredData) return;
        const data = {
            soundEffects: Array.from(this.app.soundEffects.entries())
                .filter(([, soundData]) => typeof soundData?.path === 'string' && soundData.path)
                .map(([index, soundData]) => ({
                    index,
                    name: soundData.name,
                    path: soundData.path
                })),
            padLabels: Array.from(this.app.padLabels.entries()).map(([index, name]) => ({ index, name })),
            musicVolume: this.app.musicVolume,
            effectsVolume: this.app.effectsVolume,
            playbackMode: this.app.playbackMode,
            crossfadeEnabled: this.app.crossfadeEnabled,
            deckCrossfadeEnabled: this.app.deckCrossfadeEnabled,
            crossfadeDuration: this.app.crossfadeDuration,
            viewMode: this.app.viewMode,
            activeDeck: this.app.activeDeck,
            musicFolder: this.app.config?.musicFolder,
            audioSettings: this.app.audioSettings,
            decks: Object.fromEntries(['A', 'B'].map(deckId => {
                const deck = this.app.decks[deckId];
                return [deckId, {
                    playlist: deck.playlist,
                    customQueue: Boolean(deck.customQueue),
                    trackOrder: deck.tracks.map(track => track.path),
                    onlineTrackIds: deck.tracks.filter(track => track.onlineId).map(track => track.onlineId),
                    currentTrackPath: deck.tracks[deck.currentTrackIndex]?.path,
                    filterQuery: deck.filterQuery
                }];
            }))
        };
        try {
            localStorage.setItem('theatreSoundMixer', JSON.stringify(data));
        } catch (e) {
            CAS_LOGGER.warn('Ошибка сохранения в localStorage:', e);
        }
    }

    async loadStoredData() {
        this.restoringStoredData = true;
        try {
            const stored = localStorage.getItem('theatreSoundMixer');
            if (!stored) return;
            const data = JSON.parse(stored);
            if (!data || typeof data !== 'object') return;

            const normalizeVolume = (value, fallback) => {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
            };
            this.app.musicVolume = normalizeVolume(data.musicVolume, CAS_CONFIG.AUDIO.DEFAULT_MUSIC_VOLUME);
            this.app.effectsVolume = normalizeVolume(data.effectsVolume, CAS_CONFIG.AUDIO.DEFAULT_EFFECTS_VOLUME);
            this.app.playbackMode = ['sequential', 'loop', 'single'].includes(data.playbackMode)
                ? data.playbackMode
                : 'sequential';
            this.app.crossfadeEnabled = Boolean(data.crossfadeEnabled);
            this.app.deckCrossfadeEnabled = Boolean(data.deckCrossfadeEnabled);
            this.app.crossfadeDuration = this.app.normalizeCrossfadeDuration(data.crossfadeDuration ?? CAS_CONFIG.CROSSFADE.DEFAULT_DURATION);

            if (data.audioSettings && typeof data.audioSettings === 'object') {
                const s = data.audioSettings;
                if (typeof s.trimSilenceEnabled === 'boolean') this.app.audioSettings.trimSilenceEnabled = s.trimSilenceEnabled;
                if (typeof s.trimSilenceStart === 'boolean') this.app.audioSettings.trimSilenceStart = s.trimSilenceStart;
                if (typeof s.trimSilenceEnd === 'boolean') this.app.audioSettings.trimSilenceEnd = s.trimSilenceEnd;
                if (Number.isFinite(Number(s.trimSilenceThreshold))) {
                    this.app.audioSettings.trimSilenceThreshold = Math.max(-60, Math.min(-30, Number(s.trimSilenceThreshold)));
                }
                if (Number.isFinite(Number(s.trimSilencePadding))) {
                    this.app.audioSettings.trimSilencePadding = Math.max(20, Math.min(250, Number(s.trimSilencePadding)));
                }
                if (typeof s.volumeStabilizationEnabled === 'boolean') this.app.audioSettings.volumeStabilizationEnabled = s.volumeStabilizationEnabled;
                if (['theatre', 'balanced', 'aggressive'].includes(s.volumeStabilizationMode)) {
                    this.app.audioSettings.volumeStabilizationMode = s.volumeStabilizationMode;
                }
                if (typeof s.volumeNormalizationEnabled === 'boolean') this.app.audioSettings.volumeNormalizationEnabled = s.volumeNormalizationEnabled;
                if ([-14, -18, -10].includes(Number(s.volumeTargetLevel))) {
                    this.app.audioSettings.volumeTargetLevel = Number(s.volumeTargetLevel);
                }
                this.app.syncSettingsUI();
                this.app.applyStabilizerSettings();
            }

            if (['split', 'A', 'B'].includes(data.viewMode)) {
                this.app.setViewMode(data.viewMode);
            }
            if (data.activeDeck === 'A' || data.activeDeck === 'B') {
                this.app.setActiveDeck(data.activeDeck);
            }

            if (typeof document !== 'undefined') {
                const musicSlider = document.getElementById('musicVolume');
                const effectsSlider = document.getElementById('effectsVolume');
                const musicValue = document.getElementById('musicVolumeValue');
                const effectsValue = document.getElementById('effectsVolumeValue');
                if (musicSlider) musicSlider.value = this.app.musicVolume * 100;
                if (effectsSlider) effectsSlider.value = this.app.effectsVolume * 100;
                if (musicValue) musicValue.textContent = `${Math.round(this.app.musicVolume * 100)}%`;
                if (effectsValue) effectsValue.textContent = `${Math.round(this.app.effectsVolume * 100)}%`;

                const playbackModeInput = document.querySelector(`input[name="playbackMode"][value="${this.app.playbackMode}"]`);
                if (playbackModeInput) playbackModeInput.checked = true;
                this.app.updateCrossfadeControls();
            }

            if (Array.isArray(data.padLabels)) {
                data.padLabels.forEach((label) => {
                    if (Number.isInteger(label?.index) && label.index >= 0 && label.index < 12 && typeof label.name === 'string' && label.name.trim()) {
                        this.app.padLabels.set(label.index, label.name.trim());
                        this.app.updatePadLabel(label.index);
                    }
                });
            }

            if (Array.isArray(data.soundEffects)) {
                for (const effect of data.soundEffects) {
                    if (!Number.isInteger(effect?.index) || typeof effect.path !== 'string' || !effect.path) continue;
                    await this.app.assignSound(effect.index, effect.path, {
                        name: typeof effect.name === 'string' ? effect.name : this.app.padLabels.get(effect.index),
                        persist: false
                    });
                }
            }
            if (data.musicFolder === this.app.config?.musicFolder && data.decks && typeof data.decks === 'object') {
                await Promise.all(['A', 'B'].map(async deckId => {
                    const saved = data.decks[deckId];
                    if (!saved?.playlist || (typeof saved.playlist.path !== 'string' && !Array.isArray(saved.onlineTrackIds))) return;
                    const requestId = ++this.app.playlistRequestId[deckId];
                    try {
                        let result;
                        if (saved.customQueue && Array.isArray(saved.trackOrder) && window.electronAPI.getAudioTracks) {
                            result = await window.electronAPI.getAudioTracks(saved.trackOrder);
                        } else if (saved.customQueue && Array.isArray(saved.trackOrder)) {
                            // Transferred tracks may come from several folders. Read them through
                            // the existing filesystem boundary, then restore only the saved queue.
                            const folders = new Set(saved.trackOrder.filter(file => typeof file === 'string')
                                .map(file => file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1))
                                .filter(Boolean));
                            const sources = await Promise.all([...folders].map(folder =>
                                window.electronAPI.getPlaylistTracks(folder).catch(() => ({ success: false }))));
                            result = { success: true, data: sources.flatMap(source => source.success ? source.data || [] : []) };
                        } else {
                            result = typeof saved.playlist.path === 'string'
                                ? await window.electronAPI.getPlaylistTracks(saved.playlist.path)
                                : { success: true, data: [] };
                        }
                        if (Array.isArray(saved.onlineTrackIds) && window.electronAPI.getOnlineLibrary) {
                            const library = await window.electronAPI.getOnlineLibrary();
                            if (library.success) {
                                const ids = new Set(saved.onlineTrackIds);
                                result.data = [...(result.data || []), ...library.data.filter(track => ids.has(track.onlineId))];
                                result.success = true;
                            }
                        }
                        if (requestId !== this.app.playlistRequestId[deckId] || !result.success || !Array.isArray(result.data)) return;
                        const deck = this.app.decks[deckId];
                        deck.playlist = saved.playlist;
                        deck.customQueue = Boolean(saved.customQueue);
                        const ranks = new Map((Array.isArray(saved.trackOrder) ? saved.trackOrder : []).map((path, index) => [path, index]));
                        const tracksByPath = new Map(result.data.map(track => [track.path, track]));
                        deck.tracks = deck.customQueue && Array.isArray(saved.trackOrder)
                            ? saved.trackOrder.map(file => tracksByPath.get(file)).filter(Boolean)
                            : result.data.sort((a, b) => (ranks.get(a.path) ?? Infinity) - (ranks.get(b.path) ?? Infinity));
                        deck.currentTrackIndex = Math.max(0, deck.tracks.findIndex(track => track.path === saved.currentTrackPath));
                        deck.filterQuery = typeof saved.filterQuery === 'string' ? saved.filterQuery : '';
                        if (typeof document !== 'undefined') {
                            const search = document.getElementById(`trackSearchInput${deckId}`);
                            if (search) search.value = deck.filterQuery;
                        }
                    } catch (error) {
                        CAS_LOGGER.warn(`Не удалось восстановить деку ${deckId}:`, error.message);
                    }
                }));
                const deck = this.app.decks[this.app.activeDeck];
                if (deck.tracks.length && !this.app.musicPlayer) {
                    this.app.loadTrack(deck.currentTrackIndex, { deckId: this.app.activeDeck });
                }
            }
        } catch (error) {
            CAS_LOGGER.warn('Не удалось восстановить настройки:', error.message);
        } finally {
            this.restoringStoredData = false;
        }
    }
}

    return { CASStorageController };
});
