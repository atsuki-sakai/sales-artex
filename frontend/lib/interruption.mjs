// Timings are on the local playback clock. The data channel and the RTP audio
// stream are independent, so an instruction acknowledgement cannot reopen audio.
export class Interruption {
  #setPlayback;
  #onInterrupt;
  #state = 'open';
  #voicedMs = 0;
  #activeSince = null;
  #lastActive = -Infinity;
  #overlapAt = -Infinity;
  #voicedAt = -Infinity;
  #micAt = -Infinity;
  #remoteAt = -Infinity;
  #remoteQuietSince = null;
  #possibleReply = false;
  #sampleAt = -Infinity;
  #cutAt = -Infinity;
  #retryAt = -Infinity;
  #inputCaption = null;
  #outputCaption = null;
  #captionReply = false;
  #latestInputEnd = -Infinity;
  #latestOutputEnd = -Infinity;

  constructor({setPlayback, onInterrupt}) {
    this.#setPlayback = setPlayback;
    this.#onInterrupt = onInterrupt;
  }

  get suppressed() { return this.#state !== 'open'; }

  #confirm(now) {
    if (this.#state === 'interrupted') return;
    if (this.#state === 'open') this.#setPlayback(false);
    this.#state = 'interrupted';
    this.#cutAt = now;
    this.#remoteQuietSince = null;
    this.#possibleReply = false;
    this.#onInterrupt();
  }

  #release() {
    this.#state = 'open';
    this.#voicedMs = 0;
    this.#activeSince = null;
    this.#overlapAt = -Infinity;
    this.#inputCaption = null;
    this.#outputCaption = null;
    this.#captionReply = false;
    this.#remoteQuietSince = null;
    this.#possibleReply = false;
    this.#setPlayback(true);
  }

  // Voicing from the microphone's existing pitch analysis distinguishes short
  // clicks from speech. Duck first, then check for a voice after speaker echo decays.
  observe({micActive, voiced, remoteActive}, now) {
    this.#captionReply = false;
    const elapsed = now - this.#sampleAt;
    if (elapsed > 150 || now - this.#micAt > 180) this.#voicedMs = 0;
    if (elapsed > 150 || now - this.#lastActive > 180) this.#overlapAt = -Infinity;
    if (elapsed > 150 || now - this.#lastActive > 40) this.#activeSince = null;
    if (micActive) {
      this.#activeSince ??= now;
      this.#lastActive = now;
    }
    // After an echo probe, keep its cooldown while leakage continues. A
    // fresh stretch of microphone silence makes a new onset worth checking.
    if (now < this.#retryAt && elapsed <= 150 && now - Math.max(this.#lastActive, this.#cutAt) >= 180) {
      this.#retryAt = -Infinity;
    }
    this.#sampleAt = now;
    if (remoteActive && micActive && now - this.#remoteAt <= 120) {
      if (this.#state === 'open' && now - this.#overlapAt > 650) {
        // A brief overlap at the end of the caller's turn is a handoff. Count
        // speech from the first overlap, even when the mic has been active for seconds.
        this.#voicedMs = 0;
        this.#activeSince = now;
      }
      this.#overlapAt = now;
    }
    if (remoteActive) this.#remoteAt = now;
    if (voiced) this.#voicedAt = now;
    if (micActive && now - this.#voicedAt <= 160) this.#micAt = now;

    if (this.#state === 'open') {
      if (!voiced || now < this.#retryAt) return;
      // Keep the caller's actual voiced frames across syllable gaps. The remote
      // may also pause inside a sentence; require a witnessed overlap to cut it.
      if (elapsed <= 150) this.#voicedMs += Math.min(elapsed, 40);
      // Fricatives such as the start of 「ちょっと」 can precede the first
      // pitched vowel. Count this onset only after voicing corroborates it.
      const onsetAge = this.#activeSince === null ? 0 : now - this.#activeSince;
      const voicedOnset = this.#voicedMs >= 40 && onsetAge >= 100 && onsetAge <= 240;
      if ((this.#voicedMs >= 100 || voicedOnset) && now - this.#overlapAt <= 650) {
        this.#setPlayback(false);
        this.#state = 'checking';
        this.#cutAt = now;
      }
    } else if (this.#state === 'checking' && voiced && elapsed <= 150 &&
      now - this.#cutAt >= 140 && now - this.#cutAt < 260) {
      this.#confirm(now);
    }
    if (this.#state === 'interrupted') this.#observeReply(remoteActive, elapsed, now);
    this.tick(now);
  }

  #observeReply(remoteActive, elapsed, now) {
    if (elapsed > 150) {
      this.#remoteQuietSince = null;
      this.#possibleReply = false;
    }
    if (!remoteActive) {
      this.#remoteQuietSince ??= now;
      this.#possibleReply = false;
      return;
    }
    // A fresh audio onset after a quiet interval may be a reply. If the
    // caller is still talking over it, keep treating it as the old output.
    if (this.#remoteQuietSince !== null) {
      this.#possibleReply = now - this.#remoteQuietSince >= 360;
      this.#remoteQuietSince = null;
    }
    if (this.#micAt === now) this.#possibleReply = false;
    if (this.#possibleReply && now - this.#micAt >= 100) this.#release();
  }

  transcript(user, start, end, now) {
    const previousOutput = this.#outputCaption;
    if (user) {
      if (end === this.#latestInputEnd) this.#captionReply = false;
      if (end <= this.#latestInputEnd) return;
      this.#captionReply = false;
      this.#latestInputEnd = end;
      this.#inputCaption = {start, end, at:now};
    } else {
      if (end <= this.#latestOutputEnd) return;
      this.#latestOutputEnd = end;
      this.#outputCaption = {start, end, at:now};
    }
    // If Web Audio is unavailable, use only a recent observed overlap on the
    // service timeline. Delayed captions from an earlier turn must not stop playback.
    if (now - this.#sampleAt <= 180) return;
    if (this.#state === 'interrupted') {
      if (user) this.#micAt = now;
      else if (this.#inputCaption && start < this.#inputCaption.end) this.#captionReply = false;
      else if (previousOutput && this.#inputCaption && end > start &&
        previousOutput.end <= this.#inputCaption.end &&
        start - previousOutput.end >= 400 && now - previousOutput.at >= 240) {
        // The service timeline and local arrivals both show a break in AI
        // output. A later input delta can still veto this candidate in tick().
        this.#captionReply = true;
        this.tick(now);
      }
    } else if (this.#inputCaption && this.#outputCaption &&
      now - Math.min(this.#inputCaption.at, this.#outputCaption.at) <= 650 &&
      this.#inputCaption.start < this.#outputCaption.end && this.#inputCaption.end > this.#outputCaption.start) {
      this.#micAt = this.#inputCaption.at;
      this.#confirm(now);
    }
  }

  tick(now) {
    if (this.#state === 'checking' && now - this.#cutAt >= 260) {
      this.#retryAt = now + 700;
      this.#cutAt = now;
      this.#release();
      return;
    }
    if (this.#state !== 'interrupted' || now - this.#micAt < 240) return;
    const remoteQuiet = now - this.#sampleAt <= 180 && this.#remoteQuietSince !== null &&
      this.#sampleAt - this.#remoteQuietSince >= 240;
    // Some sound devices suspend analysis; some replies have no clean pause.
    // Limit how long a reply can be hidden after the caller's last speech.
    const quietMs = now - Math.max(this.#cutAt, this.#micAt);
    if (remoteQuiet || (this.#captionReply && quietMs >= 360) || quietMs >= 1500) this.#release();
  }
}
