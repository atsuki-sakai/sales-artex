import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyAdvice } from './advice.mjs';

function fixture() {
  const memos=[], calls=[], states=[];
  const advice = new ReplyAdvice({
    sendMemo:note=>{memos.push(note);},
    requestExpert:(payload,signal)=>new Promise((resolve,reject)=>calls.push({payload,signal,resolve,reject})),
    onExpertState:state=>states.push(state),
  });
  return {advice,memos,calls,states};
}
const item = {transcript:'同じ質問'};

test('音声で割り込むと入力字幕の到着前に古い助言を取り消し、以前の応答で再開しない', async () => {
  const {advice,memos,calls}=fixture();
  advice.input(200);
  advice.output(600);
  advice.stage(item);
  advice.interrupt();
  calls[0].resolve('compare_options');
  await Promise.resolve();
  advice.stage(item);
  advice.input(500);
  advice.stage(item);
  assert.equal(calls[0].signal.aborted,true);
  assert.equal(calls.length,1);
  assert.deepEqual(memos,[]);
  advice.output(700);
  assert.equal(calls.length,2);
});

test('音声側が返答を始める前はメモも専門推論も送らず、重複した観測で増やさない', async () => {
  const {advice,memos,calls,states}=fixture();
  advice.input(800);
  advice.stage(item);
  advice.output(790);
  assert.deepEqual([memos.length,calls.length],[0,0]);
  advice.output(810);
  advice.stage({...item});
  advice.output(810);
  assert.deepEqual([memos.length,calls.length],[0,1]);
  calls[0].resolve('confirm_constraints');
  await Promise.resolve();
  assert.equal(memos.length,1);
  assert.match(memos[0],/回答が実際に変わる未確認条件/);
  assert.match(states.at(-1), /専門分析：/);
});

test('先着したAI出力の時刻を使い、新しい発話があれば古い分析を取り消す', async () => {
  const {advice,memos,calls}=fixture();
  advice.output(950);
  advice.input(800);
  advice.stage(item);
  assert.equal(calls.length,1);
  advice.input(1200);
  assert.equal(calls[0].signal.aborted,true);
  calls[0].resolve('compare_options');
  await Promise.resolve();
  assert.equal(memos.length,0);
  advice.stage(item);
  advice.output(1100);
  assert.equal(calls.length,1);
  advice.output(1220);
  assert.deepEqual([calls.length,memos.length],[2,0]);
  advice.close();
  assert.equal(calls[1].signal.aborted,true);
  calls[1].resolve('respect_decline');
  await Promise.resolve();
  assert.equal(memos.length,0);
});

test('実行前にステージを更新し、最新のスナップショットだけ送る', async () => {
  const {advice,calls,memos,states}=fixture();
  advice.input(200);
  advice.stage(item);
  advice.stage({transcript:'訂正した条件'});
  advice.output(500);
  assert.deepEqual(memos,[]);
  assert.equal(calls[0].payload.transcript,'訂正した条件');
  calls[0].resolve('untrusted arbitrary text');
  await Promise.resolve();
  assert.deepEqual(memos,[]);
  assert.match(states.at(-1), /追加の助言なし/);
});

test('APIの失敗が音声経路の呼び出しに影響せず、ローカルのみのステージは課金しない', async () => {
  const {advice,calls,states}=fixture();
  advice.input(100);
  advice.stage(null);
  advice.output(110);
  assert.equal(calls.length,0);
  advice.input(300);
  advice.stage(item);
  advice.output(330);
  calls[0].reject(new Error('network'));
  await Promise.resolve();
  assert.match(states.at(-1), /失敗/);
});
