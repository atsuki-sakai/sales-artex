import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationControl} from './conversation-control.mjs';

function setup() {
  const actions = [];
  let failures = 0;
  const control = new ConversationControl({onChange:v=>actions.push(v),onFailure:()=>{failures++;}});
  const input = (id, text, t) => control.input({event_id:id,delta:text,end_ms:t},t);
  const decision = (id, choice, t, overrides={}) => control.decision({
    source_event_type:'session.input_transcript.delta',source_event_id:id,delegation_id:null,
    event:{type:'decision.completed',decision:{answers:[{name:'conversation_control',type:'choice',choice}]}},
    ...overrides,
  },t);
  return {actions,control,input,decision,failures:()=>failures};
}

test('顧客の待機希望は時間経過で解除せず、新しい質問で会話に戻る', () => {
  const s = setup();
  s.input('a','こちらの資料を探す間、話さずにいてください',100);
  s.decision('a','listen',350);
  s.control.tick(10000);
  assert.equal(s.control.listening,true);
  s.input('b','そちらには何が記載されていますか',10100);
  s.decision('b','respond',10450);
  assert.deepEqual(s.actions,['listen','respond']);
  assert.equal(s.control.listening,false);
});

test('最新発言の判定だけを使い、引用・部分辞退・言い直しで通話を切らない', () => {
  const s = setup();
  s.input('a','会話を終えたい',100);
  s.decision('a','end_call',250);
  s.control.tick(700);
  s.input('b','と言われたらどうしたらいいですか',800);
  s.decision('b','respond',1000);
  s.decision('a','end_call',1200);
  s.input('c','資料の送付だけお断りします',2000);
  s.decision('c','none',2400);
  s.control.tick(5000);
  assert.deepEqual(s.actions,[]);
});

test('終話候補の後に新しい声があれば、字幕が遅れても切断しない', () => {
  const s = setup();
  s.control.voice(10);
  s.input('a','一旦ここで失礼します',100);
  s.decision('a','end_call',300);
  s.control.voice(720);
  s.control.tick(4000);
  assert.deepEqual(s.actions,[]);
});

test('完結した終話意思で一度だけ閉じる。末尾の句点が先に届いても元の判定を照合する', () => {
  const s = setup();
  s.input('a','この通話は終わりにしてください',100);
  s.input('p','。',140);
  s.decision('a','end_call',450);
  s.control.tick(1339);
  assert.deepEqual(s.actions,[]);
  s.control.tick(1340);
  s.decision('p','end_call',1500);
  s.control.tick(3000);
  assert.deepEqual(s.actions,['end_call']);
});

test('手動で再開した後の古い保留や、別経路の判定は適用しない', () => {
  const s = setup();
  s.input('a','一息つかせてください',100);
  s.input('p','。',160);
  s.decision('a','listen',300);
  s.control.tick(700);
  s.control.resume();
  s.decision('p','listen',810);
  s.input('b','参考になる機能は？',1000);
  s.decision('b','end_call',1200,{source_event_type:'session.output_transcript.delta'});
  s.decision('b','end_call',1250,{delegation_id:'other'});
  s.decision('b','listen',1300,{event:{type:'decision.failed'}});
  s.control.tick(4000);
  assert.deepEqual(s.actions,['listen','respond']);
  assert.equal(s.failures(),1);
});

test('途中で「待って」と聞こえても、同じ発言の続きが通常の訂正なら消音を残さない', () => {
  const s = setup();
  s.input('start','ちょっと待って',100);
  s.decision('start','listen',250);
  s.control.voice(460);
  s.control.tick(640);
  s.input('correction','うちの作業は見積入力のほうです',710);
  s.decision('correction','none',980);
  s.control.tick(4500);
  assert.deepEqual(s.actions,[]);
  assert.equal(s.control.listening,false);
});

test('短い返答への再開判定は遅着した句読点やマイクの瞬間音で捨てない', () => {
  for (const punctuationFirst of [false,true]) {
    const s = setup();
    s.input('wait','説明させてください',100);
    s.decision('wait','listen',240);
    s.control.tick(650);
    assert.equal(s.control.listening,true);
    s.input('handover','以上です',1000);
    s.input('punctuation','。',1020);
    s.control.voice(1330);
    if (punctuationFirst) s.decision('punctuation','none',1380);
    s.decision('handover','respond',1420);
    if (!punctuationFirst) s.decision('punctuation','none',1480);
    assert.deepEqual(s.actions,['listen','respond']);
  }
});
