import test from "node:test";
import assert from "node:assert/strict";
import { TurnMeter } from "./acoustics.mjs";

function tone(hz, rate = 48_000, n = 2048) {
  return Float32Array.from({length: n}, (_, i) => 0.2 * Math.sin(2 * Math.PI * hz * i / rate));
}

test("measures sine frequency and RMS on typical microphone clocks", () => {
  for (const [rate, n] of [[44_100, 2048], [48_000, 2048], [96_000, 4096]]) {
    for (const hz of [70, 110, 220, 440, 530]) {
      const meter = new TurnMeter();
      const duration = n * 1000 / rate;
      meter.add(tone(hz, rate, n), rate, duration);
      const result = meter.summarize(0, duration);
      assert.ok(Math.abs(result.medianPitchHz - hz) <= 2);
      assert.ok(Math.abs(result.levelDbfs - -17) < 0.3);
      assert.equal(result.voicedMs, Math.round(duration));
    }
  }
});

test("unknown, silent, and aperiodic frames have distinct measurements", () => {
  const meter = new TurnMeter();
  assert.equal(meter.summarize(0, 40).voicedMs, null);
  meter.add(new Float32Array(1920).fill(0.5), 48_000, 40);
  const quiet = meter.summarize(0, 40);
  assert.equal(quiet.coverage, 1);
  assert.equal(quiet.medianPitchHz, null);
  assert.equal(quiet.levelDbfs, null);
  assert.equal(quiet.voicedMs, 0);
  assert.equal(quiet.activeMs, 0);
  let seed = 100;
  const noise = Float32Array.from({length: 1920}, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  });
  meter.add(noise, 48_000, 80);
  const fricative = meter.summarize(40, 80);
  assert.equal(fricative.medianPitchHz, null);
  assert.equal(fricative.activeMs, 40);
  assert.equal(fricative.voicedMs, 0);
});

test("counts internal quiet spans and excludes leading and trailing silence", () => {
  const meter = new TurnMeter();
  const loud = tone(175, 48_000, 1920);
  const quiet = new Float32Array(1920);
  for (let i = 0; i < 100; i++) {
    const sound = (i >= 10 && i < 30) || (i >= 35 && i < 80);
    meter.add(sound ? loud : quiet, 48_000, (i + 1) * 40);
  }
  const result = meter.summarize(0, 4000);
  assert.equal(result.pauseCount, 1);
  assert.equal(result.activeMs, 2600);
  assert.equal(result.activeRunsPerMinute, 30);
  assert.equal(meter.summarize(1100, 1660).pauseCount, 1);
  assert.equal(meter.summarize(1200, 1660).pauseCount, 0);
});

test("overlap does not double-count and sparse sampling does not invent pauses", () => {
  const meter = new TurnMeter();
  const signal = tone(180, 48_000, 1920);
  for (const end of [40, 60, 80, 100, 300, 300, 290]) meter.add(signal, 48_000, end);
  const result = meter.summarize(50, 280);
  assert.equal(result.observedMs, 70);
  assert.equal(result.voicedMs, 70);
  assert.ok(Math.abs(result.coverage - 70 / 230) < 1e-6);
  assert.equal(result.pauseCount, null);
  assert.equal(result.activeRunsPerMinute, null);
});

test("old observations expire and invalid input leaves an unobserved window", () => {
  const meter = new TurnMeter();
  meter.add(tone(200), 48_000, 100);
  meter.add(tone(200), 48_000, 121_000);
  meter.add(new Float32Array([NaN]), 48_000, 130_000);
  assert.equal(meter.summarize(0, 100).observedMs, 0);
  assert.equal(meter.summarize(121_000, 130_000).coverage, 0);
});
