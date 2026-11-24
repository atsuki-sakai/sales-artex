// A threshold crossing is a local audio observation. It cannot identify a speaker's intent.
const micThreshold = 10 ** (-42 / 10);
const remoteThreshold = 10 ** (-45 / 10);
const minMicMs = 240;
const minRemoteMs = 220;
const minGapMs = 80;
const maxGapMs = 30_000;

function active(samples, threshold) {
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const v = samples[i];
    sum += v;
    squares += v * v;
    n++;
  }
  return squares / n - (sum / n) ** 2 >= threshold;
}

export function remoteAudioActive(samples) {
  return Boolean(samples?.length && active(samples, remoteThreshold));
}

export class ReplyLatency {
  #lastTick = null;
  #micStart = null;
  #micEnd = null;
  #candidate = null;
  #receivedStart = null;
  #lastReceived = -Infinity;
  #lastRemote = -Infinity;
  #remoteStart = null;
  #delay = null;

  #reset() {
    this.#micStart = null;
    this.#micEnd = null;
    this.#candidate = null;
    this.#receivedStart = null;
    this.#lastReceived = -Infinity;
    this.#lastRemote = -Infinity;
    this.#remoteStart = null;
    this.#delay = null;
  }

  // Both PCM windows are sampled on the same tick. Emits each valid interval once.
  observe(mic, remote, now, playback = 'audible') {
    if (playback === 'inactive' || !mic?.length || !remote?.length || !Number.isFinite(now)) {
      this.#reset();
      this.#lastTick = null;
      return null;
    }
    if (this.#lastTick !== null && (now <= this.#lastTick || now - this.#lastTick > 130)) {
      this.#reset();
    }
    this.#lastTick = now;
    const user = active(mic, micThreshold);
    const received = remoteAudioActive(remote);
    if (received) {
      if (now - this.#lastReceived > 90) this.#receivedStart = now;
      this.#lastReceived = now;
    }

    if (received && playback === 'audible') {
      if (this.#remoteStart === null || now - this.#lastRemote > 90) {
        this.#remoteStart = now;
        // Opening playback in the middle of the old, interrupted utterance
        // cannot identify a reply. A new burst may already have begun muted.
        this.#delay = null;
        if (this.#candidate !== null && this.#receivedStart > this.#candidate) {
          const gap = now - this.#candidate;
          if (gap >= minGapMs && gap <= maxGapMs) this.#delay = gap;
          else this.#candidate = null;
        }
      }
      this.#lastRemote = now;
      this.#micStart = null;
      this.#micEnd = null;
      // Overlap may be interruption or speaker echo. Discard this ambiguous sample.
      if (user) {
        this.#delay = null;
        this.#candidate = null;
      }
      if (this.#delay !== null && now - this.#remoteStart >= minRemoteMs) {
        const gap = Math.round(this.#delay);
        this.#delay = null;
        this.#candidate = null;
        return gap;
      }
      return null;
    }

    if (playback === 'audible' && now - this.#lastRemote < 180) {
      if (user) {
        this.#delay = null;
        this.#candidate = null;
      }
      return null;
    }
    this.#remoteStart = null;
    this.#delay = null;
    if (user) {
      if (this.#micStart === null || now - this.#micEnd > 160) {
        this.#micStart = now;
        this.#candidate = null;
      }
      this.#micEnd = now;
      if (now - this.#micStart >= minMicMs) this.#candidate = now;
    }
    return null;
  }
}

// Unconnected analyser outputs do not mix the remote track into local playback.
export function createRemoteSampler(context, stream) {
  const analyser = context.createAnalyser();
  analyser.fftSize = context.sampleRate > 60_000 ? 4096 : 2048;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(samples);
      return samples;
    },
    close() {
      source.disconnect();
      analyser.disconnect();
    },
  };
}
