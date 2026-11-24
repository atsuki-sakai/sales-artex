import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesk, expertInput, initialView, playbackMode} from './session.mjs';
import {ReplyLatency} from './latency.mjs';
import {segments} from './planner.mjs';

test('再生を抑えた間のAI字幕は別区間に残し、専門分析の対話履歴から除く', () => {
  const turns = segments([
    {role:'assistant',start:100,end:130,text:'商品A'},
    {role:'assistant',start:130,end:155,text:'承知',playbackSuppressed:true},
    {role:'assistant',start:155,end:180,text:'しました',playbackSuppressed:true},
    {role:'user',start:140,end:190,text:'少し待って'},
    {role:'assistant',start:190,end:220,text:'商品B'},
    {role:'user',start:2300,end:2450,text:'違いを知りたい'},
  ]);
  const ai = turns.filter(t=>t.role === 'assistant');
  assert.deepEqual(ai.map(t=>[t.text,!!t.playbackSuppressed]),[['商品A',false],['承知しました',true],['商品B',false]]);
  const advice = expertInput({}, turns, turns.at(-1), {kind:'clarify'});
  assert.equal(advice.transcript,'営業：商品A\n顧客：少し待って\n営業：商品B\n顧客：違いを知りたい');
});

test('終了時は次の営業提案を消し、顧客が実際に伝えた希望と字幕を残す', t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({configured:false}));
  globalThis.window = new EventTarget();
  let view = {...initialView};
  const desk = createDesk(update => {view = {...view,...update};}, {current:null});
  t.after(() => { desk.dispose(); delete globalThis.window; });
  desk.startDemo('登録済みの商材','デモの日程相談','',false);
  desk.sendDemo('デモをお願いします');
  assert.match(view.action,/候補日/);
  desk.stop();
  assert.equal(view.mode,'idle');
  assert.equal(view.action,'会話は終了しました。');
  assert.deepEqual(view.advisors,[['直近の顧客発言','デモをお願いします']]);
  assert.ok(view.turns.some(turn => turn.text === 'デモをお願いします'));
});

test('プレーヤーで消音・停止した間の待ち時間を破棄し、再生後の新しい応答を測る', () => {
  const silent = new Float32Array(128);
  const voice = Float32Array.from(silent, (_, i) => 0.15 * Math.sin(i / 5));
  for (const manual of [{muted:true}, {paused:true}, {volume:0}]) {
    const meter = new ReplyLatency();
    const session = {ready:true, control:{listening:false}, interruption:{suppressed:false}, playbackTrack:{enabled:true}};
    const playing = {muted:false, paused:false, volume:1};
    const values = [];
    let now = 0;
    function sample(count, mic, remote, player = playing) {
      for (let i = 0; i < count; i++, now += 20) {
        const delay = meter.observe(mic, remote, now, playbackMode(session,player));
        if (delay !== null) values.push(delay);
      }
    }
    sample(20, voice, silent);
    sample(5, silent, silent);
    session.interruption.suppressed = true;
    session.playbackTrack.enabled = false;
    sample(20, silent, voice, {...playing,...manual});
    session.interruption.suppressed = false;
    session.playbackTrack.enabled = true;
    sample(20, silent, voice);
    assert.deepEqual(values, []);
    sample(12, silent, silent);
    sample(20, voice, silent);
    sample(9, silent, silent);
    sample(16, silent, voice);
    assert.deepEqual(values, [200]);
  }
});
