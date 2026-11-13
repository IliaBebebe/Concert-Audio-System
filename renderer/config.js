(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory({});
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
const CAS_CONFIG = Object.freeze({
    CROSSFADE: {
        DEFAULT_DURATION: 3,
        MIN_DURATION: 1,
        MAX_DURATION: 10,
        MIN_FADE_MS: 250,
        CLEANUP_BUFFER_MS: 200,
        TIMER_BUFFER_MS: 150
    },
    AUDIO: {
        DEFAULT_MUSIC_VOLUME: 0.7,
        DEFAULT_EFFECTS_VOLUME: 0.7,
        PROGRESS_INTERVAL_MS: 250,
        DURATION_TIMEOUT_MS: 15000,
        MAX_CONCURRENT_DURATION_LOADS: 4
    },
    UI: {
        PROGRESS_PAINT_INTERVAL_MS: 50,
        MODAL_CLOSE_MS: 150,
        FLOATING_Z_INDEX: 1100,
        STATUS_TIMEOUT_MS: 4000
    },
    STORAGE: {
        THROTTLE_MS: 400
    },
    SETTINGS: {
        TRIM_SILENCE: {
            DEFAULT_ENABLED: false,
            DEFAULT_START: true,
            DEFAULT_END: true,
            DEFAULT_THRESHOLD_DB: -48,
            MIN_THRESHOLD_DB: -60,
            MAX_THRESHOLD_DB: -30,
            DEFAULT_PADDING_MS: 80,
            MIN_PADDING_MS: 20,
            MAX_PADDING_MS: 250,
            MIN_DETECTABLE_SILENCE_SEC: 0.12,
            MIN_END_SILENCE_SEC: 0.35,
            MIN_TRACK_DURATION_SEC: 2.0
        },
        STABILIZER: {
            DEFAULT_ENABLED: false,
            DEFAULT_MODE: 'theatre',
            DEFAULT_NORMALIZATION_ENABLED: false,
            DEFAULT_TARGET_LUFS: -14,
            MODES: {
                theatre: { threshold: -24, knee: 30, ratio: 3, attack: 0.005, release: 0.300 },
                balanced: { threshold: -18, knee: 20, ratio: 4, attack: 0.003, release: 0.250 },
                aggressive: { threshold: -12, knee: 10, ratio: 8, attack: 0.001, release: 0.150 }
            }
        }
    }
});

const CAS_SILENT_SAMPLES = Object.freeze([]);

const CAS_LOGGER = {
    debug(...args) {
        if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
            console.debug('[CAS]', ...args);
        }
    },
    info(...args) { console.info('[CAS]', ...args); },
    warn(...args) { console.warn('[CAS]', ...args); },
    error(...args) { console.error('[CAS]', ...args); }
};


    return { CAS_CONFIG, CAS_SILENT_SAMPLES, CAS_LOGGER };
});
