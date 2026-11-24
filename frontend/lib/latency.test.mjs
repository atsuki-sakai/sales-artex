import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyLatency } from './latency.mjs';

const silent = new Float32Array(256);
const voice = Float32Array.from(silent, (_, i) => Math.sin(i * 0.08) * 0.15);

function fixture() {
  const meter = new ReplyLatency();
  let time = 0;
  const results = [];
  return {
    playback: 'audible',
    run(frames, mic, remote, step = 20) {
      for (let i = 0; i < frames; i++) {
        const value = meter.observe(mic, remote, time, this.playback);
        if (value !== null) results.push(value);
        time += step;
      }
    },
    get values() { return results; },
  };
}

test('records last user energy to first sustained assistant sound once', () => {
  const f = fixture();
  f.run(25, voice, silent);
  f.run(34, silent, silent);
  f.run(55, silent, voice);
  assert.deepEqual(f.values, [700]);
  f.run(15, silent, silent);
  f.run(22, voice, silent);
  f.run(4, silent, silent);
  f.run(20, silent, voice);
  assert.deepEqual(f.values, [700, 100]);
});

test('ignores greeting, one-frame impulses, overlap and an isolated short reply', () => {
  const f = fixture();
  f.run(26, silent, voice);
  f.run(20, silent, silent);
  f.run(1, voice, silent);
  f.run(20, silent, silent);
  f.run(17, silent, voice);
  f.run(25, voice, silent);
  f.run(6, silent, silent);
  f.run(17, voice, voice);
  f.run(25, voice, silent);
  f.run(7, silent, silent);
  f.run(5, silent, voice);
  f.run(20, silent, silent);
  assert.deepEqual(f.values, []);
});

test('does not count missing samples, throttled tabs and stale replies', () => {
  for (const update of [
    f => f.run(1, silent, undefined),
    f => f.run(1, silent, silent, 600),
    f => f.run(1510, silent, silent),
  ]) {
    const f = fixture();
    f.run(25, voice, silent);
    f.run(6, silent, silent);
    update(f);
    f.run(16, silent, voice);
    assert.deepEqual(f.values, []);
  }
});

test('continues listening when customer resumes before the reply', () => {
  const f = fixture();
  f.run(25, voice, silent);
  f.run(20, silent, silent);
  f.run(25, voice, silent);
  f.run(16, silent, silent);
  f.run(22, silent, voice);
  assert.deepEqual(f.values, [340]);
});

test('割り込み後の返答が消音中に始まっても再生を許可した先頭までを測る', () => {
  const f = fixture();
  f.run(20, silent, voice);
  f.playback = 'interrupted';
  f.run(20, voice, voice);
  f.run(8, silent, silent);
  f.run(14, silent, voice);
  assert.deepEqual(f.values, []);
  f.playback = 'audible';
  f.run(16, silent, voice);
  assert.deepEqual(f.values, [460]);
});

test('前の説明の末尾が再び聞こえても、新しい音声が続いた時点で一度だけ測る', () => {
  const f = fixture();
  f.run(20, silent, voice);
  f.playback = 'interrupted';
  f.run(20, voice, voice);
  f.run(6, silent, voice);
  f.playback = 'audible';
  f.run(14, silent, voice);
  f.run(10, silent, silent);
  f.run(4, silent, voice);
  f.run(10, silent, silent);
  assert.deepEqual(f.values, []);
  f.run(20, silent, voice);
  assert.deepEqual(f.values, [900]);
});

test('プレーヤー停止や聞き取り待機をまたいで以前の発言の待ち時間を表示しない', () => {
  const f = fixture();
  f.run(20, voice, silent);
  f.run(10, silent, silent);
  f.run(5, silent, voice);
  f.playback = 'inactive';
  f.run(20, voice, silent);
  f.playback = 'audible';
  f.run(18, silent, voice);
  assert.deepEqual(f.values, []);
});
