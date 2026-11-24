import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from './planner.mjs';
import { opening, strategy } from './strategy.mjs';

const brief = {product:'見積作成支援。料金は個別確認。', goal:'デモの日程を相談', target:'設備工事業。表計算への転記が課題かもしれない。'};
const evaluate = (texts, settings = brief) => {
  const turns = texts.map(text => ({role:'user', text}));
  return strategy(settings, turns, assess(turns));
};

test('先行挨拶はAIであること、商材、事前情報の仮説、会話開始の意向を含む', () => {
  const first = opening(brief);
  assert.match(first, /AIの営業担当/);
  assert.match(first, /見積作成支援/);
  assert.match(first, /デモ/);
  assert.match(opening({...brief, goal:"資料の案内"}), /資料/);
  assert.match(first, /転記.{0,15}かもしれない/);
  assert.match(first, /少しお話ししても/);
  assert.ok(!opening({product:'予約ツール',target:'架空の佐藤さん'}).includes('佐藤'));
  assert.match(opening({}), /サービスのご案内/);
});

test('聞き取り、比較、次の一手を明示発言と目標で選ぶ', () => {
  assert.match(evaluate(['はい']).example, /転記/);
  assert.equal(evaluate(['手作業が負担です']).method, '影響の聞き取り');
  assert.equal(evaluate(['他社との機能の違いは？']).method, '比較基準の確認');
  assert.match(evaluate(['日報の件です', '興味があります']).example, /デモ/);
  assert.match(evaluate(['日報の件です', '興味があります'], {...brief, goal:'ご希望に沿って資料を案内'}).example, /資料/);
  assert.equal(evaluate(['料金は？', '月額はいくら？']).method, '回答の見直し');
  assert.match(evaluate(['デモをお願いします']).progress, /希望あり。日時は要確認/);
  assert.match(evaluate(['資料を送ってほしい']).progress, /送付は未実施/);
  assert.match(evaluate(['見積書をください']).progress, /発行は未実施/);
});

test('拒否・保留・撤回を優先し、契約の希望と成立を分ける', () => {
  assert.equal(evaluate(['やはりお断りします', 'ありがとうございます']).method, '辞退の尊重');
  assert.equal(evaluate(['今回は保留です']).method, '検討の保留');
  assert.match(evaluate(['契約したい']).progress, /契約成立は未確認/);
  assert.doesNotMatch(evaluate(['契約したいわけではありません']).progress, /申込希望あり/);
  assert.doesNotMatch(evaluate(['デモをお願いする場合は？']).progress, /希望あり/);
});

test('ローカルの営業手法は画面用の候補だけを返す', () => {
  const settings = {product:'PRIV_PRODUCT', goal:'PRIV_GOAL', target:'PRIV_TARGET'};
  const note = evaluate(['PRIV_SPEECH'], settings);
  assert.deepEqual(Object.keys(note).sort(), ['action','example','method','progress']);
});

test('顧客の明示希望を次のターンに保持し、候補日と正式な予約を区別する', () => {
  assert.match(evaluate(['デモをお願いします','来週火曜日がよいです']).progress, /候補日時を受領。正式な予約は未確認/);
  assert.match(evaluate(['デモをお願いします','来週の火曜でお願いします','ありがとうございます']).progress, /候補日時を受領/);
  assert.match(evaluate(['デモをお願いします','来週火曜でお願いします', '火曜日は難しいです']).progress, /希望あり。日時は要確認/);
  assert.match(evaluate(['デモをお願いします','来週火曜日は社内の締切です']).progress, /希望あり。日時は要確認/);
  assert.match(evaluate(['デモをお願いします','デモはキャンセルします','資料をください']).progress, /資料希望/);
  assert.doesNotMatch(evaluate(['見積書をください','見積は取り消します','ありがとうございます']).progress, /見積依頼あり/);
  assert.doesNotMatch(evaluate(['来週火曜でお願いします']).progress, /候補日時を受領/);
  assert.equal(evaluate(['デモをお願いします','価格を教えてください']).method, '費用条件の説明');
});

test('強い関心には初回の明示発言でも目標に合う手順を打診する', () => {
  for (const [goal,expected] of [['デモ面談', /デモ/], ['資料の送付', /資料/], ['見積もり', /お見積もり/]]) {
    assert.match(evaluate(['詳しく知りたいです'], {...brief, goal}).example, expected);
  }
  assert.notEqual(evaluate(['詳しく知りたいわけではありません']).method, '次の手順の提案');
});
