import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesk} from './session.mjs';

function audioStream(label) {
  const track = Object.assign(new EventTarget(), {
    label, readyState:'live', muted:false, enabled:true,
    stop() { this.readyState = 'ended'; },
  });
  return {getAudioTracks:()=>[track], getTracks:()=>[track]};
}

test('通話中のマイク変更は同じ送信機を使い、許可拒否・旧機器の切断・通話終了と競合しても復旧できる', async t => {
  const devices = {first:audioStream('最初の入力'), next:audioStream('新しい入力'), late:audioStream('通話終了時に届いた入力')};
  const first = devices.first.getTracks()[0];
  let receiveLate;
  const afterEnd = new Promise(resolve => { receiveLate = resolve; });
  const mediaDevices = {getUserMedia: async ({audio}) => {
    const id = audio.deviceId?.exact ?? 'first';
    if (id === 'missing') throw new DOMException('not found', 'NotFoundError');
    if (id === 'late') { await afterEnd; }
    return devices[id];
  }};
  const config = {configured:true};
  let peer;
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    constructor() { super(); peer=this; }
    addTrack(track) {
      assert.equal(this.sender,undefined);
      return this.sender = {track,replaceTrack: async function(next) { this.track=next; }};
    }
    createDataChannel() { return this.channel={readyState:'open',send() {},close() {}}; }
    async createOffer() { return {type:'offer', sdp:'offer'}; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
    async setRemoteDescription() { this.channel.onmessage({data:'{"type":"session.started"}'}); }
    close() {}
  }
  const save = (obj, key, value) => {
    const original = Object.getOwnPropertyDescriptor(obj,key);
    Object.defineProperty(obj,key,{configurable:true,value});
    t.after(() => original ? Object.defineProperty(obj,key,original) : delete obj[key]);
  };
  save(globalThis,'window',new EventTarget());
  save(globalThis,'requestAnimationFrame',() => 1);
  save(globalThis,'cancelAnimationFrame',() => {});
  save(globalThis,'navigator',{mediaDevices});
  save(globalThis,'RTCPeerConnection',Peer);
  t.mock.method(globalThis,'fetch', async url => Response.json(url==='/api/config' ? config : {transport:{sdp:'answer'}}));
  const view = {};
  const desk = createDesk(fields=>Object.assign(view,fields),{current:null});
  try {
    await desk.startLive('商材','目的','',true);
    assert.equal(view.canChangeMic,true);
    assert.equal(peer.sender.track,first);
    assert.match(view.status,/AI担当が会話を始めます/);
    peer.channel.onmessage({data:JSON.stringify({type:'session.input_transcript.delta',delta:'こんにちは',start_ms:100,end_ms:500})});
    assert.equal(view.status,'通話中');
    assert.equal(await desk.switchMicrophone('missing'),false);
    assert.equal(first.readyState,'live');
    assert.equal(peer.sender.track,first);
    first.muted=true;
    first.dispatchEvent(new Event('mute'));
    assert.match(view.micStatus,/一時停止/);
    assert.equal(view.micNeedsReconnect,true);
    assert.match(view.micChangeError,/切り替えられませんでした/);
    first.stop();
    first.dispatchEvent(new Event('ended'));
    assert.equal(view.mode,'live');
    assert.match(view.micStatus,/接続が切れ/);
    assert.equal(await desk.switchMicrophone('next'),true);
    const next = devices.next.getTracks()[0];
    assert.equal(peer.sender.track,next);
    assert.equal(view.micChangeError,'');
    assert.equal(view.micNeedsReconnect,false);
    first.dispatchEvent(new Event('mute'));
    assert.match(view.micStatus,/新しい入力/);
    const change = desk.switchMicrophone('late');
    desk.stop();
    peer.channel.onmessage({data:'{"type":"session.closed"}'});
    receiveLate();
    assert.equal(await change,false);
    assert.equal(devices.late.getTracks()[0].readyState,'ended');
    assert.equal(next.readyState,'ended');
    assert.equal(view.canChangeMic,false);
  } finally { desk.dispose(); }
});
