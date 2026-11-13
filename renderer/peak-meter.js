(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./config.js'));
    } else {
        Object.assign(root.CASRenderer ||= {}, factory(root.CASRenderer));
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(dependencies) {
// Sample-peak meter: 0 dBFS is full scale; the visible range is -60..0 dBFS.
class CASPeakMeter {
    constructor() { this.reset(); }

    reset() {
        this.levelDb = -60;
        this.peakDb = -60;
        this.holdUntil = 0;
        this.clipUntil = 0;
        this.lastTime = null;
    }

    update(samples, now) {
        let peak = 0;
        for (const sample of samples) {
            if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
        }
        const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
        const seconds = this.lastTime === null ? 0 : Math.max(0, (now - this.lastTime) / 1000);
        this.lastTime = now;
        this.levelDb = Math.min(0, Math.max(-60, db, this.levelDb - 24 * seconds));
        if (db >= this.peakDb) {
            this.peakDb = Math.min(0, db);
            this.holdUntil = now + 1000;
        } else if (now > this.holdUntil) {
            const releaseSeconds = Math.min(seconds, (now - this.holdUntil) / 1000);
            this.peakDb = Math.max(-60, this.levelDb, this.peakDb - 24 * releaseSeconds);
        }
        if (peak >= 1) this.clipUntil = now + 1000;
        return {
            level: (this.levelDb + 60) / 60,
            peak: (this.peakDb + 60) / 60,
            db: this.levelDb,
            clipping: this.clipUntil > now
        };
    }
}

    return { CASPeakMeter };
});
