const test = require('node:test');
const assert = require('node:assert/strict');
const { CASPeakMeter } = require('../renderer');

test('sample peaks map to dBFS without artificial gain, including quiet signals', () => {
  for (const db of [-54, -36, -18, -6, 0]) {
    const meter = new CASPeakMeter();
    const reading = meter.update(new Float32Array([0, 10 ** (db / 20), 0]), 0);
    assert.ok(Math.abs(reading.db - db) < 0.001);
    assert.ok(Math.abs(reading.level - (db + 60) / 60) < 0.001);
  }
  assert.equal(new CASPeakMeter().update(new Float32Array(32), 0).level, 0);
});

test('attack is immediate; release is time-based and peak holds for one second', () => {
  const meter = new CASPeakMeter();
  const loud = meter.update([0.5], 0);
  const release = meter.update([0], 250);
  assert.ok(Math.abs(release.db - (loud.db - 6)) < 0.001);
  assert.equal(release.peak, loud.peak);
  assert.ok(meter.update([0], 1100).peak < loud.peak);
  assert.equal(meter.update([0], 4000).level, 0);
});

test('clip indication requires full-scale signal, holds briefly and resets', () => {
  const meter = new CASPeakMeter();
  assert.equal(meter.update([0.7], 0).clipping, false);
  assert.equal(meter.update([-1], 100).clipping, true);
  assert.equal(meter.update([0], 1000).clipping, true);
  assert.equal(meter.update([0], 1101).clipping, false);
  meter.update([1.2], 1200);
  meter.reset();
  assert.deepEqual(meter.update([0], 1300), { level: 0, peak: 0, db: -60, clipping: false });
});
