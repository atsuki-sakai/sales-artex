// Live may deliver simultaneous speech and slightly out-of-order transcript deltas.
export function segments(fragments) {
  const groups = [];
  const lastBySpeaker = new Map();
  const chronological = fragments
    .filter(f => ['user', 'assistant'].includes(f.role) && f.text &&
      Number.isFinite(f.start) && Number.isFinite(f.end) && f.end >= f.start)
    .sort((a, b) => a.start - b.start);
  for (const f of chronological) {
    let group = lastBySpeaker.get(f.role);
    const gap = group ? f.start - group.end : Infinity;
    const playbackSuppressed = f.role === 'assistant' && f.playbackSuppressed === true;
    if (!group || !!group.playbackSuppressed !== playbackSuppressed || gap >= 1300 ||
        (gap >= 0 && /[。！？!?][」』）]?\s*$/.test(group.text))) {
      group = { role: f.role, start: f.start, end: f.end, text: '' };
      if (playbackSuppressed) group.playbackSuppressed = true;
      groups.push(group);
      lastBySpeaker.set(f.role, group);
    }
    group.text += f.text;
    group.end = Math.max(group.end, f.end);
  }
  return groups;
}

const themes = [
  ['費用', 'cost', /料金|価格|費用|予算|コスト|月額|年額|値段|いくら|高い|安い/],
  ['導入時期', 'timing', /導入時期|納期|来月|いつから|いつまで|スケジュール/],
  ['業務負担', 'workload', /手作業|工数|手間|時間がかか|二重入力|負担/],
  ['運用・機能', 'operations', /連携|機能|操作|使い方|デモ|使えますか/],
];

const options = {
  finish: ['終了', 'お断りを尊重し、お礼を述べて勧誘を終える。', '承知しました。お時間をいただき、ありがとうございました。'],
  defer: ['保留', '急いで提案せず、相手が希望した場合だけ保留理由を確認する。', '承知しました。いったんここで区切りましょう。'],
  handoff: ['次の手順の確認', '希望の手続きと、実際にできる範囲を伝える。', 'ご希望を伺いました。この通話には担当者へ取り次ぐ機能はありません。'],
  cost: ['費用条件の確認', '登録済みの料金を答える。記載がない場合はその点を伝えて区切る。', '料金についてですね。商材の登録情報で提示できる金額があるかが回答の根拠になります。'],
  timing: ['時期の確認', '希望日と期限の理由を一つずつ確かめる。', 'いつ頃から使い始めることを想定されていますか。'],
  operations: ['利用場面の確認', '実際に利用する場面と必要な機能を一つ確かめる。', 'どの作業でお使いになる想定でしょうか。'],
  workload: ['課題の具体化', '現在の業務で最も負担の大きい作業を確かめる。', '特に時間がかかっている作業を一つ教えていただけますか。'],
  clarify: ['優先条件の確認', '判断に必要な条件を一つ、相手の言葉で確認する。', '比較するときに一番大切にされる条件は何ですか。'],
  discover: ['ヒアリング', '相手の相談内容を聞き、次に掘り下げる論点を絞る。', '今、どんなことを解決したいとお考えですか。'],
};

// Apply corrections from left to right. Keep explicit refusal across turns.
const themeNegation = /^(?:の[話件]|について|に対して|に関して|のこと)?(?:は|には|が|を|に|も)?(?:特に|あまり|全く|もう)?(?:ではなく|じゃなく|ではない|じゃない|ではありません|関心[がは]?(?:ない|ありません)|興味[がは]?(?:ない|ありません)|気に(?:し(?:てい)?(?:ない|ません)|してない)|問題(?:ない|ありません)|必要(?:ない|ありません)|不要|結構です|いりません|要りません)/;
const withdrawal = /(?:という|っていう|する|した|したい|したわけ)?(?:わけ(?:では|じゃ)(?:ない|ありません)|とは(?:言って|いって)(?:い)?(?:ない|ません)|(?:では|じゃ)(?:なく|ない|ありません))|を撤回|は撤回/;
const finish = /お断り(?:します|です|したい)?|(?:営業|勧誘|連絡|電話)(?:は|を|も)?(?:もう)?(?:やめて|しないで|不要|お断り)|(?:もう)?(?:不要です|結構です|いりません|要りません)|(?:興味|関心)[がは]?(?:ありません|ない)|契約(?:は)?(?:しません|しない|するつもり[はが]?(?:ない|ありません))/;
const defer = /検討します|今は難し|保留|持ち帰|考えさせ|申し込まない|申し込みません|見送り|見送ります/;
const handoff = /申[し]?込(?:みたい|みます)|契約したい|契約します|見積(?:もり|り|書)?を?(?:お願い|ください|希望)|担当者に.{0,3}(?:つないで|繋いで)/;
const reopen = /(?:もう一度|改めて|やっぱり|やはり|もう少し|引き続き).{0,12}(?:聞きたい|聞かせて|話したい|話を聞|相談したい|説明して|教えて)|(?:説明|話|相談|商談)(?:を)?(?:続けて|再開して)|詳しく(?:聞きたい|教えて)|(?:お?断り|保留|見送り)(?:を|は)撤回/;
const scope = /^(?:(?:その|今回の)?(?:見積(?:もり|書)?|デモ|資料|日程調整|オプション|機能))(?:は|が|については)/;

function classify(text, prior) {
  let stance = prior;
  const mentions = new Set();
  const clauses = text.normalize('NFKC').replace(/[^\S\n]/g, '').split(/[。、,！!？?\n]|けれど(?:も)?|けど|ですが|しかし|ただし/);
  for (const clause of clauses) {
    let rest = clause;
    for (const [name, , pattern] of themes) {
      const topic = rest.match(pattern);
      if (!topic) continue;
      const after = rest.slice(topic.index + topic[0].length);
      const negation = after.match(themeNegation);
      if (negation) {
        mentions.delete(name);
        rest = rest.replace(topic[0] + negation[0], '');
      } else {
        mentions.add(name);
      }
    }
    // 「契約したいわけではありません」のような引用・取り消しは確約に数えない。
    for (const [intent, pattern] of [['finish', finish], ['defer', defer], ['handoff', handoff], ['open', reopen]]) {
      const hit = rest.match(pattern);
      if (!hit) continue;
      const suffix = rest.slice(hit.index + hit[0].length);
      if (withdrawal.test(suffix)) {
        if (stance === intent) stance = 'open';
        continue;
      }
      if (intent === 'finish' && scope.test(rest)) continue;
      stance = intent;
      break;
    }
  }
  return { stance, mentions: [...mentions] };
}

const states = {
  finish: 'お断りの表現',
  defer: '保留・見送りの表現',
  handoff: '手続き希望の表現（要復唱）',
  open: '意思表示は未確認',
};

export function assess(turns, acoustic) {
  let stance = 'open';
  let mentioned = [];
  let sameTopicTurns = 0;
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const result = classify(turn.text, stance);
    sameTopicTurns = result.mentions.length && result.mentions.join('・') === mentioned.join('・') ? sameTopicTurns + 1 : 1;
    mentioned = result.mentions;
    // A prior handoff request remains provisional. A rejection or deferral
    // remains active until the customer explicitly reopens the conversation.
    stance = result.stance;
  }
  const state = states[stance];
  const theme = themes.find(([name]) => name === mentioned[0]);
  const topicKind = mentioned.length > 1 ? 'clarify' : (theme?.[1] ?? 'discover');
  const kind = stance === 'open' ? topicKind : stance;
  let [phase, action, example] = options[kind];
  if (stance === 'open' && sameTopicTurns >= 2 && mentioned.length) {
    phase = '未回答の論点を確認';
    action = '同じ論点について先の返答で不足した情報を確認し、既知の条件から具体的に答える。';
    example = '先ほどの説明では、ご質問に十分お答えできませんでした。';
    if (sameTopicTurns >= 3) {
      phase = '説明できる範囲を明示';
      action = '答えられる部分と資料に記載のない点を区別して伝える。';
      example = 'その点はこの場の情報だけではお答えできません。';
    }
  }
  let pace = '一度に質問は一つ';
  if (kind === 'finish' || kind === 'defer') pace = '新たな質問を重ねない';
  else if (acoustic?.coverage >= 0.75 && acoustic.pauseCount >= 2) pace = '話の途中では譲り、言い終えたら短く返す';
  const topics = mentioned.join('・') || '話題を特定していません';
  return { kind, phase, topics, state, pace, action, example };
}
