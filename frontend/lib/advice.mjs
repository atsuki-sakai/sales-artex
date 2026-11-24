// Only these server-validated choices can become model-facing advice.
const actions = new Map([
  ['clarify_need', '明示された目的を前提にし、意味を決められない場合だけ尋ねる。'],
  ['compare_options', '顧客が示した条件を使い、登録情報で裏づけられる違いを伝える。'],
  ['confirm_constraints', '回答が実際に変わる未確認条件があれば、その点のみ尋ねる。'],
  ['confirm_next_step', '合意済みの希望はそのまま受け取り、未実施の業務とは区別する。'],
  ['respect_decline', '辞退された範囲についての提案を終える。'],
]);

export class ReplyAdvice {
  #sendMemo;
  #requestExpert;
  #onExpertState;
  #userEnd = null;
  #outputStart = -Infinity;
  #stage = null;
  #controller = null;
  #closed = false;
  #lastExpertMemo = '';

  constructor({sendMemo, requestExpert, onExpertState}) {
    this.#sendMemo = sendMemo;
    this.#requestExpert = requestExpert;
    this.#onExpertState = onExpertState;
  }

  input(endMs) {
    if (this.#closed || !Number.isFinite(endMs)) return;
    this.#userEnd = Math.max(this.#userEnd ?? -Infinity, endMs);
    this.#stage = null;
    this.#abort();
  }

  output(startMs) {
    if (this.#closed || !Number.isFinite(startMs)) return;
    this.#outputStart = Math.max(this.#outputStart, startMs);
    this.#dispatch();
  }

  stage(expertInput) {
    if (this.#closed || this.#userEnd === null || !expertInput) return;
    const inputKey = JSON.stringify(expertInput);
    if (this.#stage?.inputKey === inputKey) return;
    this.#abort();
    this.#stage = {expertInput, inputKey, started:false};
    this.#dispatch();
  }

  #dispatch() {
    if (!this.#stage || this.#userEnd === null || this.#outputStart < this.#userEnd) return;
    const snapshot = this.#stage;
    if (snapshot.started) return;
    snapshot.started = true;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#analyse(snapshot, controller);
  }

  async #analyse(snapshot, controller) {
    this.#onExpertState('専門分析中');
    try {
      const action = await this.#requestExpert(snapshot.expertInput, controller.signal);
      if (this.#stage !== snapshot || this.#closed || controller.signal.aborted) return;
      const memo = actions.get(action);
      if (!memo) {
        this.#onExpertState('専門分析：追加の助言なし');
        return;
      }
      const note = 'この相談への参考：' + memo;
      if (note !== this.#lastExpertMemo) {
        if (this.#sendMemo(note) === false) {
          this.#onExpertState('専門分析：結果の送信を確認できませんでした');
          return;
        }
        this.#lastExpertMemo = note;
      }
      this.#onExpertState('専門分析：' + memo);
    } catch {
      if (this.#stage === snapshot && !this.#closed && !controller.signal.aborted) this.#onExpertState('専門分析に失敗しました');
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  #abort() {
    if (!this.#controller) return;
    this.#controller.abort();
    this.#controller = null;
    if (!this.#closed) this.#onExpertState('発話の更新により専門分析を中断');
  }

  interrupt() {
    this.#userEnd = null;
    this.#outputStart = -Infinity;
    this.#stage = null;
    this.#abort();
  }

  close() {
    this.#closed = true;
    this.#stage = null;
    this.#abort();
  }
}
