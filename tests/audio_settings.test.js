const test = require('node:test');
const assert = require('node:assert/strict');
const { CAS_CONFIG, CASDeckManager, TheatreSoundMixer } = require('../renderer.js');

function createMockAudioBuffer({ duration = 10, sampleRate = 44100, silenceStartSec = 1.0, silenceEndSec = 1.5, peak = 0.5 }) {
    const totalSamples = Math.floor(duration * sampleRate);
    const channelData = new Float32Array(totalSamples);
    const soundStartSample = Math.floor(silenceStartSec * sampleRate);
    const soundEndSample = Math.floor((duration - silenceEndSec) * sampleRate);

    for (let i = soundStartSample; i < soundEndSample; i++) {
        // Non-silent audio signal
        channelData[i] = peak * Math.sin((i / sampleRate) * 440 * 2 * Math.PI);
    }

    return {
        duration,
        sampleRate,
        length: totalSamples,
        numberOfChannels: 1,
        getChannelData: () => channelData
    };
}

test('detectSilenceBounds: short tracks under 2 seconds are never trimmed to protect audio', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true,
        trimSilenceEnd: true,
        trimSilenceThreshold: -48,
        trimSilencePadding: 80
    };

    const shortBuffer = createMockAudioBuffer({ duration: 1.5, silenceStartSec: 0.3, silenceEndSec: 0.3 });
    const bounds = mixer.detectSilenceBounds(shortBuffer);

    assert.equal(bounds.startSec, 0, 'Short tracks must keep startSec at 0');
    assert.equal(bounds.endSec, 1.5, 'Short tracks must keep endSec at full duration');
});

test('detectSilenceBounds: accurately trims silence while preserving attack transients with safety pre-roll', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true,
        trimSilenceEnd: true,
        trimSilenceThreshold: -48,
        trimSilencePadding: 80 // 80 ms pre-roll
    };

    // 10s track, 1.2s silence at start, 2.0s silence at end
    const buffer = createMockAudioBuffer({ duration: 10, silenceStartSec: 1.2, silenceEndSec: 2.0 });
    const bounds = mixer.detectSilenceBounds(buffer);

    // rawStartSec ~ 1.2s. Pre-roll padding = 0.08s -> startSec ~ 1.12s
    assert.ok(bounds.rawStartSec >= 1.18 && bounds.rawStartSec <= 1.22, `rawStartSec is around 1.2s (got ${bounds.rawStartSec})`);
    assert.ok(bounds.startSec <= bounds.rawStartSec, 'Effective start must precede the sound onset to preserve attack transient');
    assert.ok(bounds.startSec >= 1.10 && bounds.startSec <= 1.14, `startSec includes 80ms safety padding (got ${bounds.startSec})`);

    // rawEndSec ~ 8.0s. Post-roll padding >= 0.20s -> endSec >= 8.20s
    assert.ok(bounds.rawEndSec >= 7.98 && bounds.rawEndSec <= 8.02, `rawEndSec is around 8.0s (got ${bounds.rawEndSec})`);
    assert.ok(bounds.endSec >= bounds.rawEndSec, 'Effective end must extend beyond sound drop to preserve reverb decay');
    assert.ok(bounds.endSec < 10.0, 'Trailing silence should be trimmed before 10.0s');
});

test('detectSilenceBounds: tiny lead-in silence (< 120ms) is untouched to eliminate risk of cutting initial notes', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true,
        trimSilenceEnd: true,
        trimSilenceThreshold: -48,
        trimSilencePadding: 80
    };

    // Track with only 0.09s lead-in silence
    const buffer = createMockAudioBuffer({ duration: 5, silenceStartSec: 0.09, silenceEndSec: 1.5 });
    const bounds = mixer.detectSilenceBounds(buffer);

    assert.equal(bounds.startSec, 0, 'Start under protection gate (< 120ms) must not be trimmed');
});

test('detectSilenceBounds: tiny trailing silence (< 350ms) is untouched to prevent gating reverb tails', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true,
        trimSilenceEnd: true,
        trimSilenceThreshold: -48,
        trimSilencePadding: 80
    };

    // Track with only 0.25s silence at end
    const buffer = createMockAudioBuffer({ duration: 6, silenceStartSec: 1.0, silenceEndSec: 0.25 });
    const bounds = mixer.detectSilenceBounds(buffer);

    assert.equal(bounds.endSec, 6, 'End silence under protection gate (< 350ms) must remain at full track duration');
});

test('getTrackEffectiveStart: user manual startOffset always overrides automatic silence trim', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true
    };
    mixer.silenceBoundsCache = new Map();

    const trackWithManualOffset = {
        path: '/music/track1.mp3',
        startOffset: 25.5,
        silenceBounds: { startSec: 1.2, endSec: 180 }
    };

    assert.equal(mixer.getTrackEffectiveStart(trackWithManualOffset), 25.5, 'Manual startOffset takes absolute precedence');

    const trackWithAutoTrimOnly = {
        path: '/music/track2.mp3',
        silenceBounds: { startSec: 1.5, endSec: 120 }
    };
    assert.equal(mixer.getTrackEffectiveStart(trackWithAutoTrimOnly), 1.5, 'Uses auto-trim start when no manual offset is set');

    mixer.audioSettings.trimSilenceStart = false;
    assert.equal(mixer.getTrackEffectiveStart(trackWithAutoTrimOnly), 0, 'Returns 0 when trimSilenceStart option is disabled');
});

test('getTrackEffectiveEnd: returns effective bounds when enabled and full duration when disabled', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceEnd: true
    };
    mixer.silenceBoundsCache = new Map();

    const track = {
        path: '/music/track.mp3',
        silenceBounds: { startSec: 1.0, endSec: 172.5 }
    };

    assert.equal(mixer.getTrackEffectiveEnd(track, 180), 172.5, 'Returns effective end when enabled');

    mixer.audioSettings.trimSilenceEnd = false;
    assert.equal(mixer.getTrackEffectiveEnd(track, 180), 180, 'Returns full duration when trimSilenceEnd is disabled');

    mixer.audioSettings.trimSilenceEnabled = false;
    assert.equal(mixer.getTrackEffectiveEnd(track, 180), 180, 'Returns full duration when trimSilenceEnabled is disabled');
});

test('applyStabilizerSettings: transparent linear bypass when disabled vs compressor parameters when enabled', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    const mockAudioContext = { currentTime: 1.0 };
    const mockCompressor = {
        threshold: { val: null, setTargetAtTime(v) { this.val = v; } },
        ratio: { val: null, setTargetAtTime(v) { this.val = v; } },
        knee: { val: null, setTargetAtTime(v) { this.val = v; } },
        attack: { val: null, setTargetAtTime(v) { this.val = v; } },
        release: { val: null, setTargetAtTime(v) { this.val = v; } }
    };
    const mockNormalizer = {
        gain: { val: null, setTargetAtTime(v) { this.val = v; } }
    };

    mixer.audioContext = mockAudioContext;
    mixer.musicCompressor = mockCompressor;
    mixer.musicNormalizerGain = mockNormalizer;
    mixer.audioSettings = {
        volumeStabilizationEnabled: false,
        volumeStabilizationMode: 'theatre',
        volumeNormalizationEnabled: false,
        volumeTargetLevel: -14
    };

    // Disabled -> linear bypass
    mixer.applyStabilizerSettings();
    assert.equal(mockCompressor.threshold.val, 0, 'Bypass threshold must be 0 dB');
    assert.equal(mockCompressor.ratio.val, 1, 'Bypass ratio must be 1:1');
    assert.equal(mockNormalizer.gain.val, 1.0, 'Bypass normalizer gain must be 1.0');

    // Enabled in theatre mode
    mixer.audioSettings.volumeStabilizationEnabled = true;
    mixer.audioSettings.volumeStabilizationMode = 'theatre';
    mixer.applyStabilizerSettings();
    assert.equal(mockCompressor.threshold.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.theatre.threshold);
    assert.equal(mockCompressor.ratio.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.theatre.ratio);
    assert.equal(mockCompressor.attack.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.theatre.attack);
    assert.equal(mockCompressor.release.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.theatre.release);

    // Enabled in aggressive mode
    mixer.audioSettings.volumeStabilizationMode = 'aggressive';
    mixer.applyStabilizerSettings();
    assert.equal(mockCompressor.threshold.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.aggressive.threshold);
    assert.equal(mockCompressor.ratio.val, CAS_CONFIG.SETTINGS.STABILIZER.MODES.aggressive.ratio);
});

test('updateTrackNormalization: clamps gain safely between 0.5x and 1.8x to prevent clipping', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    const mockNormalizer = {
        gain: { val: null, setTargetAtTime(v) { this.val = v; } }
    };
    mixer.audioContext = { currentTime: 0 };
    mixer.musicNormalizerGain = mockNormalizer;
    mixer.audioSettings = {
        volumeStabilizationEnabled: true,
        volumeNormalizationEnabled: true,
        volumeTargetLevel: -14 // ~0.1995 amp
    };

    // Very quiet track (peak = 0.05)
    mixer.updateTrackNormalization({ peakLevel: 0.05 });
    // targetAmp / peak = ~0.20 / 0.05 = 4.0, clamped to 1.8 max
    assert.equal(mockNormalizer.gain.val, 1.8, 'Gain is clamped to max 1.8 to prevent loud noise boosts');

    // Very loud track (peak = 1.0)
    mixer.updateTrackNormalization({ peakLevel: 1.0 });
    // targetAmp / peak = 0.1995 / 1.0 = ~0.20, clamped to min 0.5
    assert.equal(mockNormalizer.gain.val, 0.5, 'Gain is clamped to min 0.5 to prevent extreme attenuation');

    // Normalization disabled -> gain 1.0
    mixer.audioSettings.volumeNormalizationEnabled = false;
    mixer.updateTrackNormalization({ peakLevel: 0.05 });
    assert.equal(mockNormalizer.gain.val, 1.0, 'Gain resets to 1.0 when normalization is disabled');
});

test('audioSettings persistence: round-trip serialization saves and restores user options', () => {
    const mixer = Object.create(TheatreSoundMixer.prototype);
    mixer.audioSettings = {
        trimSilenceEnabled: false,
        trimSilenceStart: true,
        trimSilenceEnd: false,
        trimSilenceThreshold: -42,
        trimSilencePadding: 120,
        volumeStabilizationEnabled: true,
        volumeStabilizationMode: 'balanced',
        volumeNormalizationEnabled: true,
        volumeTargetLevel: -18
    };
    mixer.syncSettingsUI = () => {};
    mixer.applyStabilizerSettings = () => {};

    // Mock storage write
    let savedPayload = null;
    const mockStorage = {
        setItem(key, val) { savedPayload = JSON.parse(val); },
        getItem() { return JSON.stringify(savedPayload); }
    };
    global.localStorage = mockStorage;

    mixer.soundEffects = new Map();
    mixer.padLabels = new Map();
    mixer.deckManager = new CASDeckManager();
    mixer.decks = mixer.deckManager.decks;
    mixer.activeDeck = 'A';
    mixer.musicVolume = 0.7;
    mixer.effectsVolume = 0.7;
    mixer.playbackMode = 'sequential';
    mixer.crossfadeEnabled = false;
    mixer.deckCrossfadeEnabled = false;
    mixer.crossfadeDuration = 3;
    mixer.viewMode = 'split';

    mixer._writeStoredData();
    assert.ok(savedPayload && savedPayload.audioSettings, 'Serialized payload contains audioSettings');
    assert.equal(savedPayload.audioSettings.trimSilenceThreshold, -42);
    assert.equal(savedPayload.audioSettings.volumeStabilizationMode, 'balanced');

    // Restore into a fresh mixer instance
    const freshMixer = Object.create(TheatreSoundMixer.prototype);
    freshMixer.audioSettings = {
        trimSilenceEnabled: true,
        trimSilenceStart: true,
        trimSilenceEnd: true,
        trimSilenceThreshold: -48,
        trimSilencePadding: 80,
        volumeStabilizationEnabled: false,
        volumeStabilizationMode: 'theatre',
        volumeNormalizationEnabled: false,
        volumeTargetLevel: -14
    };
    freshMixer.syncSettingsUI = () => {};
    freshMixer.applyStabilizerSettings = () => {};
    freshMixer.updateCrossfadeControls = () => {};
    freshMixer.deckManager = new CASDeckManager();
    freshMixer.decks = freshMixer.deckManager.decks;
    freshMixer.padLabels = new Map();
    freshMixer.soundEffects = new Map();
    freshMixer.normalizeCrossfadeDuration = (d) => d;

    // Load
    freshMixer.loadStoredData();
    assert.equal(freshMixer.audioSettings.trimSilenceThreshold, -42, 'Restored threshold matches saved');
    assert.equal(freshMixer.audioSettings.volumeStabilizationMode, 'balanced', 'Restored mode matches saved');
    assert.equal(freshMixer.audioSettings.volumeTargetLevel, -18, 'Restored target level matches saved');
    assert.equal(freshMixer.audioSettings.trimSilenceEnabled, false, 'Restored trimSilenceEnabled matches saved');
});

