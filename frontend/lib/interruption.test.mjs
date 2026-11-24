import test from 'node:test';
import assert from 'node:assert/strict';
import {Interruption} from './interruption.mjs';

function fixture() {
  const playback = [];
  let interruptions = 0;
  const gate = new Interruption({
    setPlayback:enabled => playback.push(enabled),
    onInterrupt:() => { interruptions++; },
  });
  function sound(from, to, micActive, remoteActive, voiced = micActive) {
    for (let now = from; now <= to; now += 20)
      gate.observe({micActive, voiced, remoteActive}, now);
  }
  return {gate, playback, sound, count:() => interruptions};
}

test('長いAI発話に割り込み、元の音声が止まり人が言い終わるまで再生を抑える', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 680, true, true);
  assert.deepEqual(f.playback,[false]);
  assert.equal(f.count(),1);
  f.sound(700, 1140, true, false);
  assert.equal(f.gate.suppressed,true);
  f.sound(1160, 1420, false, false);
  assert.deepEqual(f.playback,[false,true]);
  f.sound(1440, 1640, false, true);
  assert.equal(f.count(),1);
  f.sound(1660, 2100, true, true);
  assert.equal(f.count(),2);
});

test('クリックや無声音だけでは止めず、スピーカーを止めて消えたエコーでは会話を中断しない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 280, true, true);
  f.sound(300, 600, false, true);
  f.sound(620, 900, true, true, false);
  assert.deepEqual(f.playback,[]);
  f.sound(920, 1040, true, true);
  f.sound(1060, 1440, false, true);
  assert.deepEqual(f.playback,[false,true]);
  assert.equal(f.count(),0);
});

test('AIの文節間と利用者の音節間で判定をやり直さず、続きのAI音声を再生しない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 260, true, true);
  f.sound(280, 380, false, false);
  f.sound(400, 440, true, false);
  assert.deepEqual(f.playback,[false]);
  f.sound(460, 820, true, false);
  f.sound(840, 1200, true, true);
  assert.deepEqual(f.playback,[false]);
  assert.equal(f.count(),1);
});

test('普通の交代と、顧客発話中の単発の受信音は割り込みとして扱わない', () => {
  const f = fixture();
  f.sound(0, 300, false, true);
  f.sound(320, 800, true, false);
  f.sound(820, 820, true, true);
  f.sound(840, 1100, true, false);
  f.sound(1120, 1500, false, true);
  assert.deepEqual(f.playback,[]);
  assert.equal(f.count(),0);
});

test('長い顧客発話の語尾と新しいAI回答が40〜60ms重なっても消音しない', () => {
  for (const overlap of [40, 60]) {
    const f = fixture();
    f.sound(0, 1000, true, false);
    f.sound(1020, 1000 + overlap, true, true);
    f.sound(1020 + overlap, 1900, false, true);
    assert.deepEqual(f.playback, []);
    assert.equal(f.count(), 0);
  }
});

test('顧客が先に話し、AIが重なった後も発言を続けたら再生を止める', () => {
  const f = fixture();
  f.sound(0, 1000, true, false);
  f.sound(1020, 1080, true, true);
  assert.deepEqual(f.playback, []);
  f.sound(1100, 1180, true, true);
  assert.deepEqual(f.playback, [false]);
  f.sound(1200, 1400, true, true);
  assert.equal(f.count(), 1);
});

test('受信が無音にならない場合と端末の計測が休止した場合にも新しい応答が永久に消音されない', () => {
  for (const suspended of [true, false]) {
    const f = fixture();
    f.sound(0, 600, true, true);
    if (!suspended) f.sound(620, 2260, false, true);
    f.gate.tick(2260);
    assert.deepEqual(f.playback,[false,true]);
    assert.equal(f.count(),1);
  }
});

test('Web Audioが使えない端末では同時刻の字幕で割り込み、遅延・再送分では止めない', () => {
  const f = fixture();
  f.gate.transcript(false,800,1200,1300);
  f.gate.transcript(true,350,650,1400);
  f.gate.transcript(true,1000,1400,1500);
  f.gate.transcript(true,1200,1500,1600);
  assert.deepEqual(f.playback,[false]);
  f.gate.tick(3200);
  f.gate.transcript(false,2000,2400,3250);
  f.gate.transcript(true,1000,1400,3300);
  f.gate.transcript(true,2050,2350,4100);
  assert.deepEqual(f.playback,[false,true]);
  assert.equal(f.count(),1);
});

test('相手の発声開始から100ms以内で再生を止め、声が続いたときだけ中断を確定する', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 320, true, true);
  assert.deepEqual(f.playback, [false]);
  assert.equal(f.count(), 0);
  f.sound(340, 440, true, true);
  assert.equal(f.count(), 1);
});

test('旧音声が静まった後、相手が言い終えて120msで届く新しい回答の頭を再生する', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 600, true, true);
  f.sound(620, 1100, true, false);
  f.sound(1120, 1200, false, false);
  assert.deepEqual(f.playback, [false]);
  f.sound(1220, 1220, false, true);
  assert.deepEqual(f.playback, [false, true]);
  assert.equal(f.count(), 1);
});

test('相手がまだ話している間に再開した前の説明を、息継ぎで開き直さない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 600, true, true);
  f.sound(620, 1020, true, false);
  f.sound(1040, 1040, false, true);
  f.sound(1060, 1260, true, true);
  f.sound(1280, 1600, false, true);
  assert.deepEqual(f.playback, [false]);
  f.sound(1620, 1900, false, false);
  assert.deepEqual(f.playback, [false, true]);
});

test('音響サンプルが途切れた時間を旧音声が静まった時間に含めない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 600, true, true);
  f.sound(620, 640, true, false);
  f.sound(920, 940, false, true);
  assert.deepEqual(f.playback, [false]);
});

test('音響計測がないときは顧客字幕が先着しても同時発話を検出し、古い字幕で再度止めない', () => {
  const f = fixture();
  f.gate.transcript(true, 1000, 1350, 1400);
  f.gate.transcript(false, 850, 1150, 1490);
  assert.deepEqual(f.playback, [false]);
  f.gate.tick(3100);
  f.gate.transcript(true, 1000, 1350, 3110);
  f.gate.transcript(false, 800, 1000, 3120);
  assert.deepEqual(f.playback, [false, true]);
  assert.equal(f.count(), 1);
});

test('AIに重なった無声子音の後で母音を検出すれば、AIの文節間でもすぐ再生を抑える', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 280, true, true, false);
  assert.deepEqual(f.playback, []);
  f.sound(300, 320, true, false);
  assert.deepEqual(f.playback, [false]);
  assert.equal(f.count(), 0);
  f.sound(340, 420, false, false);
  f.sound(440, 500, true, false);
  assert.equal(f.count(), 1);
});

test('短い相づち相当の180msの声にはいったん譲り、前の説明の中断は確定しない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 380, true, true);
  f.sound(400, 780, false, true);
  assert.deepEqual(f.playback, [false, true]);
  assert.equal(f.count(), 0);
});

test('長く続く無声の環境音を子音の立ち上がりとして扱わない', () => {
  const f = fixture();
  f.sound(0, 400, true, true, false);
  f.sound(420, 440, true, true);
  f.sound(460, 700, true, true, false);
  assert.deepEqual(f.playback, []);
});

test('エコーの予備消音後に静けさが戻れば、新たな割り込みを700ms待たずに受ける', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 320, true, true);
  f.sound(340, 740, false, true);
  assert.deepEqual(f.playback, [false, true]);
  f.sound(760, 860, true, true);
  assert.deepEqual(f.playback, [false, true, false]);
  f.sound(880, 1020, true, true);
  assert.equal(f.count(), 1);
});

test('前の説明が一文中の短い間をおいて再開したときは、顧客の音節間で開き直さない', () => {
  const f = fixture();
  f.sound(0, 200, false, true);
  f.sound(220, 600, true, true);
  f.sound(620, 800, true, false);
  f.sound(820, 900, false, false);
  f.sound(920, 960, false, true);
  f.sound(980, 1300, true, true);
  assert.deepEqual(f.playback, [false]);
  assert.equal(f.count(), 1);
});

test('字幕だけでも前の説明と新しい回答に間があり顧客の発言が落ち着けば再生を戻す', () => {
  const f = fixture();
  f.gate.transcript(false, 800, 1200, 1300);
  f.gate.transcript(true, 1050, 1450, 1500);
  f.gate.transcript(true, 1450, 1700, 1780);
  f.gate.transcript(false, 1820, 1960, 2090);
  assert.deepEqual(f.playback, [false]);
  f.gate.tick(2140);
  assert.deepEqual(f.playback, [false, true]);
});

test('字幕のみで再開を待つ間に言い直しが届いたら、旧回答の続きや再送では開かない', () => {
  const f = fixture();
  f.gate.transcript(false, 800, 1200, 1300);
  f.gate.transcript(true, 1050, 1450, 1500);
  f.gate.transcript(false, 1630, 1800, 1770);
  f.gate.transcript(true, 1440, 1770, 1810);
  f.gate.transcript(false, 1790, 2020, 2240);
  f.gate.transcript(false, 1630, 1800, 2300);
  f.gate.tick(2600);
  assert.deepEqual(f.playback, [false]);
  f.gate.tick(3310);
  assert.deepEqual(f.playback, [false, true]);
});

test('入力終了前からのAI字幕や、まとめて遅着したAI字幕は新しい回答の証拠にしない', () => {
  for (const lateBatch of [false, true]) {
    const f = fixture();
    f.gate.transcript(true, 1050, 1700, 1800);
    f.gate.transcript(false, 800, 1200, lateBatch ? 2110 : 1890);
    f.gate.transcript(false, lateBatch ? 1830 : 1640, 1950, 2190);
    f.gate.tick(2470);
    assert.deepEqual(f.playback, [false]);
  }
});
