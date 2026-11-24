// Relative to digital full scale. Mic gain and noise suppression affect this threshold.
const activePower = 10 ** (-45 / 10);
const pauseMs = 200;
const historyMs = 120_000;

// YIN's cumulative mean normalized difference. Only accept a clear first trough.
function pitchHz(samples, sampleRate) {
  const stride = Math.max(1, Math.floor(sampleRate / 12_000));
  const rate = sampleRate / stride;
  const n = Math.min(Math.floor(samples.length / stride), Math.round(rate * 0.055));
  const signal = new Float32Array(n);
  const offset = samples.length - n * stride;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < stride; j++) sum += samples[offset + i * stride + j];
    signal[i] = sum / stride;
  }
  const lastLag = Math.min(Math.ceil(rate / 65) + 1, Math.floor(n / 2));
  const length = n - lastLag;
  const difference = new Float64Array(lastLag + 1);
  let cumulative = 0;
  for (let lag = 1; lag <= lastLag; lag++) {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const delta = signal[i] - signal[i + lag];
      sum += delta * delta;
    }
    cumulative += sum;
    difference[lag] = cumulative > 0 ? sum * lag / cumulative : 1;
    if (lag < 3) continue;
    const left = difference[lag - 2];
    const middle = difference[lag - 1];
    const right = difference[lag];
    if (middle >= 0.15 || left <= middle || right < middle) continue;
    const minimum = lag - 1 + 0.5 * (left - right) / (left - 2 * middle + right);
    const frequency = rate / minimum;
    return frequency >= 65 && frequency <= 550 ? frequency : null;
  }
  return null;
}

function weightedMedian(values, totalWeight) {
  values.sort((a, b) => a.frequency - b.frequency);
  let weight = 0;
  for (const value of values) {
    weight += value.duration;
    if (weight >= totalWeight / 2) return Math.round(value.frequency);
  }
  return null;
}

export class TurnMeter {
  #frames = [];

  // The timestamp is the END of this PCM frame on the same clock as summarize().
  add(samples, sampleRate, timestampMs) {
    if (!samples?.length || !(sampleRate > 0) || !Number.isFinite(sampleRate) ||
        !Number.isFinite(timestampMs)) return;
    const previousEnd = this.#frames.at(-1)?.end ?? -Infinity;
    if (timestampMs <= previousEnd) return;
    const start = Math.max(previousEnd, timestampMs - samples.length * 1000 / sampleRate);
    let sum = 0;
    let sumSquares = 0;
    for (const value of samples) {
      sum += value;
      sumSquares += value * value;
    }
    const power = Math.max(0, sumSquares / samples.length - (sum / samples.length) ** 2);
    if (!Number.isFinite(power)) return;
    const frequency = power >= activePower ? pitchHz(samples, sampleRate) : null;
    this.#frames.push({start, end: timestampMs, power, frequency});
    while (this.#frames[0]?.end < timestampMs - historyMs) this.#frames.shift();
    return {active:power >= activePower, voiced:frequency !== null, levelDbfs:10 * Math.log10(power)};
  }

  summarize(startMs, endMs) {
    const durationMs = Number.isFinite(endMs - startMs) ? Math.max(0, endMs - startMs) : 0;
    let observed = 0;
    let active = 0;
    let voiced = 0;
    let energy = 0;
    let pauses = 0;
    let quiet = 0;
    let lastEnd = startMs;
    let interrupted = false;
    const pitches = [];
    if (durationMs > 0) {
      for (const frame of this.#frames) {
        const start = Math.max(frame.start, startMs);
        const end = Math.min(frame.end, endMs);
        const duration = end - start;
        if (duration <= 0) continue;
        if (start - lastEnd > 8) interrupted = true;
        observed += duration;
        energy += duration * frame.power;
        if (frame.power >= activePower) {
          if (active > 0 && quiet >= pauseMs - 1e-6) pauses++;
          active += duration;
          quiet = 0;
        } else {
          quiet += duration;
        }
        if (frame.frequency !== null) {
          voiced += duration;
          pitches.push({frequency: frame.frequency, duration});
        }
        lastEnd = end;
      }
    }
    const coverage = durationMs > 0 ? observed / durationMs : 0;
    const continuous = coverage >= 0.9 && !interrupted && endMs - lastEnd <= 8;
    return {
      durationMs: Math.round(durationMs),
      observedMs: Math.round(observed),
      coverage,
      levelDbfs: energy > 0 ? Math.round(10 * Math.log10(energy / observed) * 10) / 10 : null,
      medianPitchHz: weightedMedian(pitches, voiced),
      voicedMs: observed > 0 ? Math.round(voiced) : null,
      activeMs: observed > 0 ? Math.round(active) : null,
      pauseCount: continuous ? pauses : null,
      // An energy-defined group rate over this turn, independent of syllable/language.
      activeRunsPerMinute: continuous && durationMs >= 3000
        ? Math.round((active > 0 ? pauses + 1 : 0) * 60_000 / durationMs) : null,
    };
  }
}
