(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const { CAS_LOGGER } = dependencies;

// Serial waveform decoding, cached peaks and canvas rendering.
class CASWaveformController {
    constructor(app) {
        this.app = app;
        this.waveformCache = new Map();
        this.waveformRequestId = 0;
        this.waveformPeaks = [];
        this.currentWaveformTrack = null;
        this.waveformResizeObserver = null;
    }

    setupWaveformCanvas() {
        const canvas = document.getElementById('trackWaveform');
        const panel = document.getElementById('waveformPanel');
        if (!canvas || !panel) return;

        this.app.clearWaveform('Осциллограмма появится после выбора трека');
        this.waveformResizeObserver = new ResizeObserver(() => this.app.drawWaveform());
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
        this.currentWaveformTrack = null;
        this.waveformPeaks = [];
        this.app.updateWaveformProgress(0);
        const canvas = document.getElementById('trackWaveform');
        if (canvas) {
            const context = canvas.getContext('2d');
            if (context) context.clearRect(0, 0, canvas.width, canvas.height);
        }
        this.app.setWaveformState(message, false);
    }

    async loadWaveformForTrack(track) {
        const requestId = ++this.waveformRequestId;
        this.app.updateWaveformProgress(0);
        if (!track?.path) {
            this.app.clearWaveform('Осциллограмма появится после выбора трека');
            return;
        }

        this.currentWaveformTrack = track;
        const cachedPeaks = this.waveformCache.get(track.path);
        if (cachedPeaks) {
            this.waveformPeaks = cachedPeaks;
            this.app.drawWaveform();
            this.app.setWaveformState('', false);
            return;
        }

        this.app.clearWaveform('Строю waveform...');
        this.currentWaveformTrack = track;
        this.app.setWaveformState('Строю waveform...', true);

        // Serialize reads and decodes. Only the latest queued selection is read;
        // an already running decode finishes before another large buffer is allocated.
        const previousTask = this.waveformLoadTask || Promise.resolve();
        const task = previousTask.catch(() => {}).then(async () => {
            if (requestId !== this.waveformRequestId) return;
            try {
                const result = await window.electronAPI.getAudioFileBuffer(track.path);
                if (requestId !== this.waveformRequestId) return;
                if (!result?.success || !result.data) {
                    this.app.clearWaveform(result?.error || 'Waveform недоступна');
                    return;
                }
                const audioData = this.app.toArrayBuffer(result.data);
                const audioContext = this.app.getWaveformAudioContext();
                // IPC gave us an owned buffer; decodeAudioData can consume it directly.
                const decodedBuffer = await audioContext.decodeAudioData(audioData);
                if (requestId !== this.waveformRequestId) return;

                // Silence bounds detection & peak analysis for normalizer
                try {
                    const silenceAnalysis = this.app.detectSilenceBounds(decodedBuffer);
                    track.silenceBounds = silenceAnalysis;
                    track.peakLevel = silenceAnalysis.peakLevel;
                    this.app.silenceBoundsCache.set(track.path, silenceAnalysis);

                    if (this.app.musicPlayerTrack === track && this.app.musicPlayer && !this.app.isPlaying && !this.app.isPaused) {
                        const effectiveStart = this.app.getTrackEffectiveStart(track);
                        if (effectiveStart > 0) {
                            const duration = this.app.musicPlayer.duration();
                            if (Number.isFinite(duration) && effectiveStart < duration) {
                                try { this.app.musicPlayer.seek(effectiveStart); } catch {}
                                const progress = (effectiveStart / duration) * 100;
                                const progressBar = document.getElementById('progressBar');
                                if (progressBar) progressBar.value = progress;
                                this.app.updateWaveformProgress(progress);
                                this.app.updateTimeDisplays(this.app.musicPlayer);
                            }
                        }
                    }
                    if (this.app.musicPlayerTrack === track) {
                        this.app.updateTrackNormalization(track);
                    }
                } catch (e) {
                    CAS_LOGGER.debug('Ошибка анализа тишины и нормализации:', e);
                }

                const peaks = this.app.createWaveformPeaks(decodedBuffer, 320);
                this.waveformCache.set(track.path, peaks);
                while (this.waveformCache.size > 32) {
                    this.waveformCache.delete(this.waveformCache.keys().next().value);
                }
                this.waveformPeaks = peaks;
                this.app.drawWaveform();
                this.app.setWaveformState('', false);
            } catch {
                if (requestId === this.waveformRequestId) {
                    this.app.clearWaveform('Waveform недоступна для этого файла');
                }
            }
        });
        this.waveformLoadTask = task;
        await task;
        if (this.waveformLoadTask === task) this.waveformLoadTask = null;
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
        this.app.setupAudioAnalysers();
        if (this.app.audioContext) return this.app.audioContext;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('AudioContext unavailable');
        }
        this.app.audioContext = new AudioContextClass();
        return this.app.audioContext;
    }

    createWaveformPeaks(audioBuffer, sampleCount) {
        const peaks = [];
        const channelCount = Math.min(2, audioBuffer.numberOfChannels || 1);
        const totalSamples = audioBuffer.length;
        const sampleStep = totalSamples / sampleCount;
        let maxPeak = 0;

        const channels = [];
        for (let c = 0; c < channelCount; c++) {
            channels.push(audioBuffer.getChannelData(c));
        }

        for (let bucket = 0; bucket < sampleCount; bucket++) {
            const start = Math.floor(bucket * sampleStep);
            const end = Math.min(totalSamples, Math.max(start + 1, Math.floor((bucket + 1) * sampleStep)));
            const step = Math.max(1, Math.floor((end - start) / 90));
            let peak = 0;

            for (let channel = 0; channel < channelCount; channel++) {
                const samples = channels[channel];
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
        if (typeof document === 'undefined') return;
        const canvas = document.getElementById('trackWaveform');
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const scale = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
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

        const visiblePeaks = this.app.getWaveformPeaksForWidth(targetWidth, scale);
        if (visiblePeaks.length === 0) return;

        const currentTrack = this.currentWaveformTrack
            || this.app.musicPlayerTrack
            || this.app.decks[this.app.playingDeck || this.app.activeDeck]?.tracks?.[this.app.decks[this.app.playingDeck || this.app.activeDeck]?.currentTrackIndex]
            || null;

        const bounds = currentTrack?.silenceBounds || (currentTrack?.path ? this.app.silenceBoundsCache?.get(currentTrack.path) : null);
        const duration = (this.app.musicPlayer && this.app.musicPlayerTrack === currentTrack ? this.app.musicPlayer.duration() : 0)
            || bounds?.duration
            || currentTrack?.duration
            || 0;

        let startFrac = 0;
        let endFrac = 1;
        let hasTrim = false;

        if (currentTrack && duration > 0) {
            const effectiveStart = this.app.getTrackEffectiveStart(currentTrack);
            const effectiveEnd = this.app.getTrackEffectiveEnd(currentTrack, duration);
            if (effectiveStart > 0) {
                startFrac = Math.min(1, Math.max(0, effectiveStart / duration));
            }
            if (effectiveEnd > 0 && effectiveEnd < duration) {
                endFrac = Math.min(1, Math.max(startFrac, effectiveEnd / duration));
            }
            hasTrim = (startFrac > 0.002) || (endFrac < 0.998);
        }

        // Subtly shade inactive trim zones in the background
        if (hasTrim) {
            context.fillStyle = 'rgba(0, 0, 0, 0.24)';
            if (startFrac > 0) {
                const xStartBoundary = Math.round(startFrac * targetWidth);
                context.fillRect(0, 0, xStartBoundary, targetHeight);
            }
            if (endFrac < 1) {
                const xEndBoundary = Math.round(endFrac * targetWidth);
                context.fillRect(xEndBoundary, 0, targetWidth - xEndBoundary, targetHeight);
            }
        }

        const centerY = targetHeight / 2;
        const pitch = targetWidth / visiblePeaks.length;
        const barGap = pitch >= 4 * scale ? Math.min(1.5 * scale, pitch * 0.28) : Math.max(0, pitch * 0.18);
        const barWidth = Math.max(0.5, pitch - barGap);

        // Active section gradient: vibrant blue -> cyan -> subtle green accent
        const activeGradient = context.createLinearGradient(0, 0, 0, targetHeight);
        activeGradient.addColorStop(0, 'rgba(131, 184, 255, 0.92)');
        activeGradient.addColorStop(0.5, 'rgba(106, 168, 255, 0.65)');
        activeGradient.addColorStop(1, 'rgba(45, 204, 112, 0.68)');

        // Inactive trimmed silence sections gradient: muted slate gray
        const inactiveGradient = context.createLinearGradient(0, 0, 0, targetHeight);
        inactiveGradient.addColorStop(0, 'rgba(145, 150, 160, 0.42)');
        inactiveGradient.addColorStop(0.5, 'rgba(120, 125, 135, 0.26)');
        inactiveGradient.addColorStop(1, 'rgba(105, 110, 120, 0.36)');

        let lastFill = null;
        visiblePeaks.forEach((peak, index) => {
            const barFrac = (index + 0.5) / visiblePeaks.length;
            const isInactive = hasTrim && (barFrac < startFrac || barFrac > endFrac);
            const fill = isInactive ? inactiveGradient : activeGradient;

            if (fill !== lastFill) {
                context.fillStyle = fill;
                lastFill = fill;
            }

            const barHeight = Math.max(2 * scale, peak * targetHeight * 0.82);
            const x = index * pitch + barGap / 2;
            const y = centerY - barHeight / 2;
            context.fillRect(x, y, barWidth, barHeight);
        });

        // Boundary lines for trim cut points
        if (hasTrim) {
            context.lineWidth = Math.max(1, Math.round(scale));
            if (startFrac > 0.003) {
                const xStart = Math.round(startFrac * targetWidth);
                context.strokeStyle = 'rgba(131, 184, 255, 0.45)';
                context.beginPath();
                context.moveTo(xStart + 0.5, 0);
                context.lineTo(xStart + 0.5, targetHeight);
                context.stroke();
            }
            if (endFrac < 0.997) {
                const xEnd = Math.round(endFrac * targetWidth);
                context.strokeStyle = 'rgba(131, 184, 255, 0.45)';
                context.beginPath();
                context.moveTo(xEnd + 0.5, 0);
                context.lineTo(xEnd + 0.5, targetHeight);
                context.stroke();
            }
        }
    }

    updateWaveformProgress(progress) {
        const panel = document.getElementById('waveformPanel');
        const seek = document.getElementById('transportSeek');
        const clampedProgress = Math.min(100, Math.max(0, Number(progress) || 0));
        const ratio = (clampedProgress / 100).toFixed(4);
        if (panel) {
            panel.style.setProperty('--waveform-progress', `${clampedProgress}%`);
            panel.style.setProperty('--seek-ratio', ratio);
        }
        if (seek) seek.style.setProperty('--seek-ratio', ratio);
    }

    seekFromWaveform(event) {
        const canvas = document.getElementById('trackWaveform');
        if (!canvas) return;

        if (!this.app.musicPlayer) {
            const targetDeckId = this.app.playingDeck || this.app.activeDeck;
            const deck = this.app.decks[targetDeckId];
            if (deck?.tracks?.length) {
                this.app.loadTrack(deck.currentTrackIndex || 0, { deckId: targetDeckId });
            }
        }
        if (!this.app.musicPlayer) return;

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rawProgress = ((event.clientX - rect.left) / rect.width) * 100;
        const progress = Math.max(0, Math.min(100, rawProgress));
        this.app.seekMusic(progress);
    }
}

    return { CASWaveformController };
});
