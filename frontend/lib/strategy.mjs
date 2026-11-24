// Match the most specific operational clue before an industry name.
const contexts = [
  [/転記|二重入力|表計算/, '転記や入力の作業'],
  [/見積|積算/, '見積もり作成'],
  [/予約|宿泊|旅館|ホテル/, '予約管理'],
  [/経理|会計|請求|月末/, '月末の事務作業'],
  [/問[い]?合[わ]?せ|コールセンター/, '問い合わせ対応'],
  [/建設|工事|施工/, '現場と事務所の情報共有'],
  [/小売|店舗|在庫/, '店舗での在庫管理'],
  [/物流|配送/, '配送手配'],
  [/製造|工場/, '生産状況の共有'],
];

function topicForTarget(target = '') {
  return contexts.find(([regex]) => regex.test(target))?.[1] ?? '';
}

function goalType(goal = '') {
  if (/次回|デモ|面談|アポ|日程|打ち合わせ/.test(goal)) return 'meeting';
  if (/契約|成約|申込/.test(goal)) return 'contract';
  if (/見積(?:り|もり|書)?(?:の?依頼|を?提案|を?希望|を?出|を?提示)|^見積(?:り|もり|書)?$/.test(goal)) return 'quote';
  if (/資料|カタログ/.test(goal)) return 'document';
  if (/課題|ニーズ|聞き取り|ヒアリング/.test(goal)) return 'discovery';
  return 'general';
}

export function opening(brief = {}) {
  const title = (brief.product ?? '').trim().split(/[。\r\n]/, 1)[0].trim();
  const subject = title && title.length <= 36 ? '「' + title + '」' : 'サービス';
  const topic = topicForTarget(brief.target);
  const context = topic ? topic + 'に関係するかもしれない' + subject + 'のご案内です。' : subject + 'のご案内です。';
  const purpose = {
    meeting: 'デモがお役に立ちそうか、',
    discovery: '普段の業務について、',
    quote: 'お見積もりが必要かどうか、',
    document: '参考になる資料がありそうか、',
    contract: 'ご希望の利用条件について、',
    general: '',
  }[goalType(brief.goal)];
  return 'こんにちは。AIの営業担当です。' + context + purpose + '今、少しお話ししてもよろしいですか。';
}

const goalProgress = {
  meeting: '面談やデモの日程は未合意',
  quote: '見積依頼は未確認',
  contract: '正式な契約成立は未確認',
  document: '資料希望は未確認',
  discovery: '課題を聞き取り中',
  general: '次の行動は未合意',
};

const requests = [
  { type: 'meeting', pattern: /(?:面談|デモ|打ち合わせ|説明会|日程調整)(?:を|が|の)?(?:希望|お願い|したい|見たい|聞きたい|設定して|調整して|予約したい)/,
    progress: '面談・デモへの希望あり。日時は要確認', action: '面談の候補日を一つ尋ねる。', example: 'ご都合のよい候補日はありますか。' },
  { type: 'document', pattern: /(?:資料|カタログ)(?:を|が)?(?:送って|送付して|ください|お願い|欲しい|ほしい)/,
    progress: '資料希望あり。送付は未実施', action: '資料の希望を受け取り、送付の実施状況を伝える。', example: '資料をご希望ですね。この通話から資料を送る機能はありません。' },
  { type: 'quote', pattern: /見積(?:り|もり|書)?を?(?:お願い|ください|希望)/,
    progress: '見積依頼あり。発行は未実施', action: '見積もりの希望を受け取り、発行の実施状況を伝える。', example: 'お見積もりをご希望ですね。この通話から見積書を発行する機能はありません。' },
  { type: 'contract', pattern: /契約したい|契約します|申[し]?込(?:みたい|みます)/,
    progress: '申込希望あり。契約成立は未確認', action: '申込希望を受け取ったことと、手続きの実施状況を伝える。', example: 'お申し込みのご希望を伺いました。この通話では申込手続きは完了していません。' },
];

const subjects = {
  meeting: /デモ|面談|打ち合わせ|日程調整/,
  document: /資料|カタログ/,
  quote: /見積/,
  contract: /契約|申[し]?込/,
};
const dateToken = /(?:来週|再来週|今週)?(?:の)?[月火水木金土日]曜(?:日)?|(?:[0-9]{1,2}月)?[0-9]{1,2}日|[0-9]{1,2}時(?:半|[0-9]{1,2}分)?|明日|明後日|来週|再来週/;
const candidateDate = /(?:なら|でしたら|が(?:いい|良い|よい|空いて)|で(?:大丈夫|結構|お願い|構いません)|を希望|はいかが|はどう|にお願い)|^(?:です)?$/;
const slotProgress = '面談の候補日時を受領。正式な予約は未確認';

function requestHistory(customer) {
  let request;
  let slot = false;
  let changed = false;
  let withdrawn = false;
  for (const turn of customer) {
    changed = false;
    for (const clause of turn.text.normalize('NFKC').split(/[。！？!?、,]|ですが|けれども|けど/)) {
      if (!clause.trim()) continue;
      const date = clause.match(dateToken);
      const cancel = /(?:やめ(?:ます|たい|て)|撤回|取り消|キャンセル|不要|お断り|希望(?:していない|しない|しません)|見送|いりません|結構です)/;
      if (request && cancel.test(clause) && !date &&
          (subjects[request.type].test(clause) || !Object.values(subjects).some(subject => subject.test(clause)))) {
        request = undefined;
        slot = false;
        withdrawn = true;
        continue;
      }
      for (const candidate of requests) {
        const match = clause.match(candidate.pattern);
        if (!match) continue;
        const suffix = clause.slice(match.index + match[0].length);
        if (/場合|としたら|なら/.test(suffix)) continue;
        if (/ない|なく|ません|やめ|キャンセル|撤回/.test(suffix)) {
          if (request?.type === candidate.type) {
            request = undefined;
            slot = false;
            withdrawn = true;
          }
          continue;
        }
        if (request?.type !== candidate.type) slot = false;
        request = candidate;
        changed = true;
        withdrawn = false;
      }
      if (date && request?.type === 'meeting') {
        const suffix = clause.slice(date.index + date[0].length).trim();
        if (/難し|無理|都合が悪|空いていない|キャンセル/.test(suffix)) {
          slot = false;
          changed = true;
        } else if (candidateDate.test(suffix) && !/納期|締切|開始|導入|社内|出張|価格/.test(clause)) {
          slot = true;
          changed = true;
        }
      }
    }
  }
  return {request, slot, changed, withdrawn};
}

function guidance(method, progress, action, example) {
  return {method, progress, action, example};
}

export function strategy(brief, turns, plan) {
  const type = goalType(brief.goal);
  const customer = turns.filter(t => t.role === 'user');
  const last = customer.at(-1)?.text ?? '';
  if (plan.kind === 'finish') return guidance('辞退の尊重', 'お断りを受領。営業を終了', plan.action, plan.example);
  if (plan.kind === 'defer') return guidance('検討の保留', '相手の判断待ち', plan.action, plan.example);
  const history = requestHistory(customer);
  const {request, slot} = history;
  const progress = slot ? slotProgress : (request?.progress ?? goalProgress[type]);
  if (history.changed && slot) {
    return guidance('候補日時の復唱', progress, '希望日時を受け取ったことと、予約の実施状況を伝える。', '候補日を伺いました。ここでは空き枠を照会できず、予約は未確定です。');
  }
  if (history.changed && request) return guidance('次の手順の合意', progress, request.action, request.example);
  if (history.withdrawn && !request) return guidance('希望の訂正を反映', progress, '取り下げた手続きへの案内を止める。', '承知しました。その手続きのご案内はここまでにします。');
  if (plan.kind === 'handoff' && !request) return guidance('希望の復唱', '手続き希望あり。引き継ぎは未実施', plan.action, plan.example);
  if (plan.phase === '未回答の論点を確認' || plan.phase === '説明できる範囲を明示') {
    return guidance('回答の見直し', progress, plan.action, plan.example);
  }
  if (/他社|比較|違い|比べ/.test(last) || plan.kind === 'clarify') {
    return guidance('比較基準の確認', progress, '比較する条件を一つ選んでもらう。', '比較するうえで、一番大切にしたい条件は何でしょうか。');
  }
  if (plan.kind === 'workload') {
    return guidance('影響の聞き取り', request ? progress : '負担への言及あり。影響を確認中', '手間のかかる作業が他の業務に与える影響を尋ねる。', 'その作業に時間がかかると、どの業務に一番影響しますか。');
  }
  if (plan.kind === 'cost') {
    return guidance('費用条件の説明', progress, plan.action, plan.example);
  }
  if (plan.kind === 'timing' || plan.kind === 'operations') {
    return guidance('利用条件の確認', progress, plan.action, plan.example);
  }
  if (request) return guidance('受け取った希望', progress, 'すでに受けた希望を尊重し、新しい依頼があるまで追加の手続きを勧めない。', '承知しました。ご希望は伺いました。');
  if (/(?:良さそう|興味があり(?:ます|そう)|詳しく知りたい|役に立ちそう)(?:です|だ)?[。！!\s]*$/.test(last)) {
    if (type === 'meeting') return guidance('次の手順の提案', progress, '具体的なデモを希望するか尋ねる。', '実際の画面をデモでご覧になりますか。');
    if (type === 'document') return guidance('次の手順の提案', progress, '比較に使う資料を希望するか尋ねる。', 'ご検討用の資料をご希望ですか。');
    if (type === 'quote') return guidance('次の手順の提案', progress, '個別の見積もりを希望するか尋ねる。', 'ご利用条件に合わせたお見積もりをご希望ですか。');
  }
  const topic = topicForTarget(brief.target);
  if (customer.length <= 1 && topic) {
    return guidance('課題仮説の確認', progress, '事前情報から想定した課題が実際にあるか、一つだけ尋ねる。',
      topic + 'について、現状で何かお困りのことはありますか。');
  }
  return guidance('相談内容の聞き取り', progress, plan.action, plan.example);
}
