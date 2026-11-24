// Decisions classifies the meaning. Only the application changes playback or closes the call.
export class ConversationControl {
  #onChange;
  #onFailure;
  #latestEnd = -Infinity;
  #sources = new Map();
  #inputAt = -Infinity;
  #voiceAt = -Infinity;
  #unsafeEnd = -Infinity;
  #pending = null;
  #state = 'respond';

  constructor({onChange, onFailure}) {
    this.#onChange = onChange;
    this.#onFailure = onFailure;
  }

  get listening() { return this.#state === 'listen'; }

  input(e, now) {
    if (!e.event_id || e.end_ms < this.#latestEnd || this.#state === 'end_call') return;
    this.#latestEnd = e.end_ms;
    // A trailing punctuation delta can describe the same intent. Later words
    // can reverse it, so a decision about earlier words can no longer commit.
    const hasWords = /[\p{L}\p{N}]/u.test(e.delta);
    if (hasWords) {
      this.#sources.clear();
      this.#pending = null;
    }
    this.#sources.set(e.event_id, {end:e.end_ms, hasWords});
    this.#inputAt = now;
  }

  voice(now) {
    // Audio alone can veto an irreversible hang-up. A breath or a short
    // syllable must not discard a still-in-flight decision to resume speech.
    if (now - this.#voiceAt > 300 && now - this.#inputAt > 250) {
      this.#unsafeEnd = this.#latestEnd;
      if (this.#pending === 'end_call') this.#pending = null;
    }
    this.#voiceAt = now;
  }

  decision(e, now) {
    if (this.#state === 'end_call' || e.source_event_type !== 'session.input_transcript.delta' ||
        e.delegation_id != null || !this.#sources.has(e.source_event_id)) return;
    if (e.event?.type === 'decision.failed') {
      this.#onFailure();
      return;
    }
    if (e.event?.type !== 'decision.completed') return;
    const answer = e.event.decision?.answers?.find(a => a.name === 'conversation_control');
    if (answer?.type !== 'choice' || !['none','listen','respond','end_call'].includes(answer.choice)) {
      this.#onFailure();
      return;
    }
    // Earlier decisions may arrive after a decision for the punctuation.
    const {end, hasWords} = this.#sources.get(e.source_event_id);
    if (!hasWords && answer.choice === 'none') {
      this.#sources.delete(e.source_event_id);
      return;
    }
    for (const [id, source] of this.#sources) if (source.end <= end) this.#sources.delete(id);
    if (answer.choice === 'end_call' && end <= this.#unsafeEnd) return;
    this.#pending = answer.choice === 'none' ? null : answer.choice;
    this.tick(now);
  }

  tick(now) {
    if (!this.#pending) return;
    // A word in the middle of a correction can look like a request to wait.
    // A persistent mute needs a quiet boundary. The acoustic interruption
    // gate has already yielded the floor while the caller is still talking.
    const quiet = now - Math.max(this.#inputAt, this.#voiceAt);
    if (this.#pending === 'listen' && quiet < 500) return;
    if (this.#pending === 'end_call' && quiet < 1200) return;
    const action = this.#pending;
    this.#pending = null;
    if (action === this.#state) return;
    this.#state = action;
    this.#onChange(action);
  }

  resume() {
    if (!this.listening) return;
    // Manual intent supersedes in-flight results about the earlier input.
    this.#sources.clear();
    this.#pending = null;
    this.#state = 'respond';
    this.#onChange('respond');
  }
}
