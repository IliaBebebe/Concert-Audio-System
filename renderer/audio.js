(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(Object.assign({},
            require('./config.js'),
            require('./peak-meter.js')
        ));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_CONFIG, CAS_SILENT_SAMPLES, CAS_LOGGER, CASPeakMeter } = dependencies;

// Web Audio routing, peak meters and optional signal processing.
class CASAudioController {
    constructor(app) {
        this.app = app;
        this.vuMeterInterval = null;
        this.audioContext = null;
        this.musicAnalyser = null;
        this.effectsAnalyser = null;
        this.musicNormalizerGain = null;
        this.musicCompressor = null;
        this.musicNodesConnected = false;
        this.musicAnalyserData = null;
        this.effectsAnalyserData = null;
        this.connectedAudioNodes = new WeakSet();
        this.audioSources = new WeakMap();
        this.audioSourceTypes = new WeakMap();
        this.audioSettings = {
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
        this.silenceBoundsCache = new Map();
    }

    initVuMeters() {
        this.levelMeters = {};
        this.meterDisplays = {};
        for (const type of ['music', 'effects']) {
            const meter = document.getElementById(`${type}VuMeter`);
            this.levelMeters[type] = new CASPeakMeter();
            this.meterDisplays[type] = {
                meter,
                peak: meter?.querySelector('.vu-peak'),
                readout: document.getElementById(`${type}LevelValue`)
            };
        }
        this.app.updateVuMeters();
    }

    setupAudioAnalysers() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        if (!this.audioContext) {
            this.audioContext = new AudioContextClass();
        }

        const createAnalyser = () => {
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.connect(this.audioContext.destination);
            return analyser;
        };

        this.musicAnalyser = this.musicAnalyser || createAnalyser();
        this.effectsAnalyser = this.effectsAnalyser || createAnalyser();

        if (!this.musicNormalizerGain && typeof this.audioContext.createGain === 'function') {
            this.musicNormalizerGain = this.audioContext.createGain();
            try {
                this.musicNormalizerGain.gain.setValueAtTime(1.0, this.audioContext.currentTime);
            } catch {}
        }

        if (!this.musicCompressor && typeof this.audioContext.createDynamicsCompressor === 'function') {
            this.musicCompressor = this.audioContext.createDynamicsCompressor();
            this.app.applyStabilizerSettings();
        }

        if (!this.musicNodesConnected && this.musicNormalizerGain && this.musicCompressor && this.musicAnalyser) {
            try {
                this.musicNormalizerGain.connect(this.musicCompressor);
                this.musicCompressor.connect(this.musicAnalyser);
                this.musicNodesConnected = true;
            } catch (err) {
                CAS_LOGGER.debug('Ошибка связывания Web Audio узлов стабилизатора:', err);
            }
        }

        this.meterChannels ||= {};
        for (const type of ['music', 'effects']) {
            if (this.meterChannels[type]) continue;
            // Read L/R separately: a mono downmix would hide opposite-phase stereo peaks.
            const splitter = this.audioContext.createChannelSplitter(2);
            this[`${type}Analyser`].connect(splitter);
            this.meterChannels[type] = [0, 1].map(channel => {
                const analyser = this.audioContext.createAnalyser();
                analyser.fftSize = 2048;
                splitter.connect(analyser, channel);
                return analyser;
            });
            this[`${type}AnalyserData`] = new Float32Array(4096);
        }
    }

    applyStabilizerSettings() {
        if (!this.audioContext || !this.musicCompressor) return;
        const now = this.audioContext.currentTime;
        const isEnabled = Boolean(this.audioSettings?.volumeStabilizationEnabled);

        if (!isEnabled) {
            try {
                this.musicCompressor.threshold.setTargetAtTime(0, now, 0.05);
                this.musicCompressor.ratio.setTargetAtTime(1, now, 0.05);
                this.musicCompressor.knee.setTargetAtTime(0, now, 0.05);
                this.musicCompressor.attack.setTargetAtTime(0.003, now, 0.05);
                this.musicCompressor.release.setTargetAtTime(0.25, now, 0.05);
            } catch {}
            if (this.musicNormalizerGain) {
                try { this.musicNormalizerGain.gain.setTargetAtTime(1.0, now, 0.05); } catch {}
            }
            return;
        }

        const mode = this.audioSettings?.volumeStabilizationMode || 'theatre';
        const params = CAS_CONFIG.SETTINGS.STABILIZER.MODES[mode] || CAS_CONFIG.SETTINGS.STABILIZER.MODES.theatre;

        try {
            this.musicCompressor.threshold.setTargetAtTime(params.threshold, now, 0.05);
            this.musicCompressor.knee.setTargetAtTime(params.knee, now, 0.05);
            this.musicCompressor.ratio.setTargetAtTime(params.ratio, now, 0.05);
            this.musicCompressor.attack.setTargetAtTime(params.attack, now, 0.05);
            this.musicCompressor.release.setTargetAtTime(params.release, now, 0.05);
        } catch {}

        this.app.updateTrackNormalization(this.app.musicPlayerTrack);
    }

    updateTrackNormalization(track) {
        if (!this.audioContext || !this.musicNormalizerGain) return;
        const now = this.audioContext.currentTime;
        if (!this.audioSettings?.volumeStabilizationEnabled || !this.audioSettings?.volumeNormalizationEnabled) {
            try { this.musicNormalizerGain.gain.setTargetAtTime(1.0, now, 0.05); } catch {}
            return;
        }

        const peak = track?.peakLevel ?? this.silenceBoundsCache?.get(track?.path)?.peakLevel;
        if (typeof peak === 'number' && peak > 0.01 && peak <= 1.0) {
            const targetDb = Number(this.audioSettings.volumeTargetLevel) || -14;
            const targetAmp = Math.pow(10, targetDb / 20);
            const factor = Math.max(0.5, Math.min(1.8, targetAmp / peak));
            try { this.musicNormalizerGain.gain.setTargetAtTime(factor, now, 0.05); } catch {}
        } else {
            try { this.musicNormalizerGain.gain.setTargetAtTime(1.0, now, 0.05); } catch {}
        }
    }

    resumeAudioContext() {
        if (this.audioContext?.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }
    }

    connectHowlToAnalyser(howl, type) {
        if (!howl) return;
        this.app.setupAudioAnalysers();

        const analyser = type === 'effects' ? this.effectsAnalyser : (this.musicNormalizerGain || this.musicAnalyser);
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
        if (this.vuMeterInterval || this.app.isVisualsHidden()) return;

        this.vuMeterInterval = setInterval(() => {
            this.app.updateVuMeters();
        }, 33);
    }

    pauseVuMeters() {
        if (this.vuMeterInterval) {
            clearInterval(this.vuMeterInterval);
            this.vuMeterInterval = null;
        }

        for (const type of ['music', 'effects']) {
            this.levelMeters?.[type]?.reset();
            this.app.renderLevelMeter(type, { level: 0, peak: 0, db: -60, clipping: false });
        }
    }

    renderLevelMeter(type, reading) {
        const display = this.meterDisplays?.[type];
        if (!display?.meter) return;
        const level = `${(reading.level * 100).toFixed(1)}%`;
        const peak = `${(reading.peak * 100).toFixed(1)}%`;
        const db = reading.db <= -60 ? '−∞' : reading.db.toFixed(1);
        if (display.lastLevel !== level) {
            display.meter.style.setProperty('--meter-level', level);
            display.lastLevel = level;
        }
        if (display.lastPeak !== peak) {
            display.meter.style.setProperty('--meter-peak', peak);
            if (display.peak) display.peak.hidden = reading.peak <= 0;
            display.lastPeak = peak;
        }
        if (display.lastClipping !== reading.clipping) {
            display.meter.dataset.clipping = String(reading.clipping);
            display.lastClipping = reading.clipping;
        }
        if (display.readout && display.lastDb !== db) {
            display.readout.textContent = db;
            display.lastDb = db;
        }
    }

    updateVuMeters() {
        if (this.app.isVisualsHidden()) return;

        const hasRetiringMusic = Array.from(this.app.retiringMusicPlayers).some((player) => {
            try { return player?.playing(); } catch { return false; }
        });
        const active = {
            music: (this.app.isPlaying && !this.app.isPaused) || hasRetiringMusic,
            effects: Array.from(this.app.soundEffects.values()).some((soundData) => soundData?.sound?.playing())
        };
        if (active.music) {
            this.app.connectHowlToAnalyser(this.app.musicPlayer, 'music');
            this.app.retiringMusicPlayers.forEach(player => this.app.connectHowlToAnalyser(player, 'music'));
        }
        if (active.effects) {
            this.app.soundEffects.forEach(soundData => this.app.connectHowlToAnalyser(soundData?.sound, 'effects'));
        }
        let needsUpdates = active.music || active.effects;
        const now = performance.now();
        for (const type of ['music', 'effects']) {
            const buffer = this[`${type}AnalyserData`];
            const channels = this.meterChannels?.[type];
            if (!this.levelMeters?.[type]) continue;
            let samples = CAS_SILENT_SAMPLES;
            if (active[type] && buffer && channels && this.audioContext?.state === 'running') {
                channels.forEach((analyser, channel) => analyser.getFloatTimeDomainData(buffer.subarray(channel * 2048, (channel + 1) * 2048)));
                samples = buffer;
            }
            const reading = this.levelMeters[type].update(samples, now);
            this.app.renderLevelMeter(type, reading);
            needsUpdates ||= reading.level > 0 || reading.peak > 0 || reading.clipping;
        }
        if (needsUpdates) this.app.startVuMeters();
        else this.app.pauseVuMeters();
    }

    getTrackEffectiveStart(track) {
        const manualOffset = this.app.getTrackStartOffset(track);
        if (manualOffset > 0) return manualOffset;

        if (!this.audioSettings?.trimSilenceEnabled || !this.audioSettings?.trimSilenceStart) {
            return 0;
        }

        const bounds = track?.silenceBounds || this.silenceBoundsCache.get(track?.path);
        return (bounds && typeof bounds.startSec === 'number' && bounds.startSec > 0) ? bounds.startSec : 0;
    }

    getTrackEffectiveEnd(track, totalDuration) {
        const fallback = Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : 0;
        if (!this.audioSettings?.trimSilenceEnabled || !this.audioSettings?.trimSilenceEnd) {
            return fallback;
        }

        const bounds = track?.silenceBounds || this.silenceBoundsCache.get(track?.path);
        if (bounds && typeof bounds.endSec === 'number' && bounds.endSec > 0 && bounds.endSec < fallback) {
            return bounds.endSec;
        }
        return fallback;
    }

    detectSilenceBounds(audioBuffer, options = {}) {
        if (!audioBuffer || typeof audioBuffer.length !== 'number' || audioBuffer.length === 0) {
            return { startSec: 0, endSec: 0, rawStartSec: 0, rawEndSec: 0, peakLevel: 1.0, duration: 0 };
        }

        const duration = audioBuffer.duration || (audioBuffer.length / (audioBuffer.sampleRate || 44100));
        const sampleRate = audioBuffer.sampleRate || 44100;
        const totalSamples = audioBuffer.length;
        const channelCount = Math.min(2, audioBuffer.numberOfChannels || 1);

        const config = CAS_CONFIG.SETTINGS.TRIM_SILENCE;
        if (duration < config.MIN_TRACK_DURATION_SEC) {
            return { startSec: 0, endSec: duration, rawStartSec: 0, rawEndSec: duration, peakLevel: 1.0, duration };
        }

        const thresholdDb = Number(options.thresholdDb ?? this.audioSettings?.trimSilenceThreshold ?? config.DEFAULT_THRESHOLD_DB);
        const thresholdAmp = Math.pow(10, thresholdDb / 20);
        const paddingMs = Number(options.paddingMs ?? this.audioSettings?.trimSilencePadding ?? config.DEFAULT_PADDING_MS);
        const paddingSec = Math.max(0.02, paddingMs / 1000);
        const endPaddingSec = Math.max(0.20, paddingSec * 2.5); // post-roll safety to preserve reverb tails

        const channels = [];
        for (let c = 0; c < channelCount; c++) {
            channels.push(audioBuffer.getChannelData(c));
        }

        const blockSize = 256;
        let firstSoundSample = 0;
        let foundStart = false;

        // Scan forward in blocks for the first sound
        for (let i = 0; i < totalSamples; i += blockSize) {
            const blockEnd = Math.min(totalSamples, i + blockSize);
            let blockMax = 0;
            for (let c = 0; c < channelCount; c++) {
                const samples = channels[c];
                for (let s = i; s < blockEnd; s += 8) {
                    const abs = Math.abs(samples[s] || 0);
                    if (abs > blockMax) blockMax = abs;
                }
            }
            if (blockMax >= thresholdAmp) {
                firstSoundSample = i;
                foundStart = true;
                break;
            }
        }

        let lastSoundSample = totalSamples;
        let foundEnd = false;

        // Scan backward in blocks for the last sound
        for (let i = totalSamples - blockSize; i >= 0; i -= blockSize) {
            const blockEnd = Math.min(totalSamples, i + blockSize);
            let blockMax = 0;
            for (let c = 0; c < channelCount; c++) {
                const samples = channels[c];
                for (let s = i; s < blockEnd; s += 8) {
                    const abs = Math.abs(samples[s] || 0);
                    if (abs > blockMax) blockMax = abs;
                }
            }
            if (blockMax >= thresholdAmp) {
                lastSoundSample = blockEnd;
                foundEnd = true;
                break;
            }
        }

        // Measure overall peak level for normalizer (sparse sampling)
        let peakLevel = 0.01;
        const stride = Math.max(1, Math.floor(totalSamples / 1000));
        for (let c = 0; c < channelCount; c++) {
            const samples = channels[c];
            for (let s = 0; s < totalSamples; s += stride) {
                const abs = Math.abs(samples[s] || 0);
                if (abs > peakLevel) peakLevel = abs;
            }
        }

        if (!foundStart && !foundEnd) {
            return { startSec: 0, endSec: duration, rawStartSec: 0, rawEndSec: duration, peakLevel, duration };
        }

        const rawStartSec = firstSoundSample / sampleRate;
        const rawEndSec = lastSoundSample / sampleRate;

        // Apply pre-roll padding and protection gates
        let effectiveStartSec = Math.max(0, rawStartSec - paddingSec);
        if (effectiveStartSec < config.MIN_DETECTABLE_SILENCE_SEC) {
            effectiveStartSec = 0;
        }

        // Apply post-roll padding and protection gates
        let effectiveEndSec = Math.min(duration, rawEndSec + endPaddingSec);
        if ((duration - effectiveEndSec) < config.MIN_END_SILENCE_SEC) {
            effectiveEndSec = duration;
        }

        // Ensure safe boundaries
        if (effectiveEndSec <= effectiveStartSec + 0.5) {
            effectiveStartSec = 0;
            effectiveEndSec = duration;
        }

        return {
            startSec: effectiveStartSec,
            endSec: effectiveEndSec,
            rawStartSec,
            rawEndSec,
            peakLevel: Math.min(1.0, Math.max(0.01, peakLevel)),
            duration
        };
    }

    async refreshAudioAnalysis() {
        const track = this.app.currentWaveformTrack || this.app.musicPlayerTrack
            || this.app.currentDeck?.tracks[this.app.currentDeck.currentTrackIndex];
        this.app.waveformRequestId++;
        this.silenceBoundsCache.clear();
        this.app.waveformCache.clear();
        const tracks = new Set([...Object.values(this.app.decks).flatMap(deck => deck.tracks), track, this.app.musicPlayerTrack]);
        for (const item of tracks) {
            if (!item) continue;
            delete item.silenceBounds;
            delete item.peakLevel;
        }
        if (track) await this.app.loadWaveformForTrack(track);
        else this.app.drawWaveform();
    }
}

    return { CASAudioController };
});
