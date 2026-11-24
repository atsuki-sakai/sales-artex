import {TurnMeter} from './acoustics.mjs';
import {assess, segments} from './planner.mjs';
import {opening, strategy} from './strategy.mjs';
import {ReplyAdvice} from './advice.mjs';
import {ReplyLatency, createRemoteSampler, remoteAudioActive} from './latency.mjs';
import {Interruption} from './interruption.mjs';
import {ConversationControl} from './conversation-control.mjs';
import {microphoneError, openMicrophone} from './microphone.mjs';

const initialMic = {micStatus:'', micLevelDbfs:-90, canChangeMic:false, micNeedsReconnect:false, micChangeError:''};
const greetingStatus = '接続しました。AI担当が会話を始めます。';
const firstInputStatus = '接続しました。マイクに向かって話しかけてください。';

export const initialView = {
  mode: 'idle', closing: false, waitingForUser: false, readyToCall: false, configText: '音声APIの設定を確認しています。',
  status: '待機中', usage: '0 秒', turns: [], advisors: [], acoustic: [], latencyMs: null, expertState: '', ...initialMic,
  action: '商談を始めると、ここに次の応答方針が表示されます。', delivery: 'メモなし',
};

function gather(peer, signal) {
  return new Promise((resolve, reject) => {
    function done(error) {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', change);
      signal.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    }
    const change = () => { if (peer.iceGatheringState === 'complete') done(); };
    const cancel = () => done(new Error('接続を中止しました'));
    const timer = setTimeout(() => done(new Error('接続候補を取得できませんでした')), 10_000);
    peer.addEventListener('icegatheringstatechange', change);
    signal.addEventListener('abort', cancel, {once:true});
    if (signal.aborted) cancel(); else change();
  });
}

function recentAudio(s) {
  if (s.lastSample == null || performance.now() - s.lastSample > 500) return null;
  return s.meter.summarize(Math.max(s.firstSample, s.lastSample - 5_000), s.lastSample);
}

function audioRows(m) {
  const show = (n, unit) => n == null ? '—' : n + unit;
  return [
    ['基本周波数の中央値', show(m?.medianPitchHz, ' Hz')],
    ['入力音量', show(m?.levelDbfs, ' dBFS')],
    ['有声音', show(m?.voicedMs == null ? null : (m.voicedMs / 1000).toFixed(1), ' 秒')],
    ['200ms以上の休止', show(m?.pauseCount, ' 回')],
    ['発音区間の頻度', show(m?.activeRunsPerMinute, ' 区間/分')],
    ['観測率', show(m ? Math.round(m.coverage * 100) : null, ' %')],
  ];
}

export function playbackMode(s, audio) {
  if (!s.ready || s.closing || s.control.listening || !s.playbackTrack || !audio ||
      audio.paused || audio.muted || audio.volume === 0) return 'inactive';
  if (s.interruption.suppressed) return 'interrupted';
  return s.playbackTrack.enabled ? 'audible' : 'inactive';
}

async function requestExpert(input, signal) {
  const res = await fetch('/api/advice', {
    method:'POST', signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(input),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error('専門分析の応答を取得できませんでした');
  return (await res.json()).action;
}

export function expertInput(brief, turns, last, plan) {
  if (['finish', 'defer', 'handoff'].includes(plan.kind)) return null;
  // Reconstruct the latest question up to the user's last segment; output
  // captions may already include a reply when the coalescing timer fires.
  const history = turns.slice(0, turns.lastIndexOf(last) + 1).filter(turn => !turn.playbackSuppressed);
  const previousReply = history.findLastIndex(turn => turn.role === 'assistant');
  const question = history.slice(previousReply + 1).map(turn => turn.text).join('');
  if (plan.kind !== 'clarify' && !/比較|違い|優先|両立|どちら|どっち|悩んで|判断|一方で|どう選/.test(question)) return null;
  const transcript = history.slice(-6).map(t => (t.role === 'user' ? '顧客：' : '営業：') + t.text).join('\n');
  return {product:brief.product, goal:brief.goal, target:brief.target, transcript:Array.from(transcript).slice(-3000).join('')};
}

// All transports, timers and events belong to a single mounted desk.
export function createDesk(update, audioRef) {
  let current = null;
  let config;
  let disposed = false;
  const publish = (fields) => {
    if (disposed) return;
    if (current && fields.status !== undefined) current.status = fields.status;
    update(fields);
  };
  const configAbort = new AbortController();
  async function loadConfig() {
    try {
      const res = await fetch('/api/config', {signal:configAbort.signal});
      if (!res.ok) throw new Error();
      config = await res.json();
      publish({readyToCall:config.configured, configText:config.configured
        ? 'GPT-Live-1.1 APIキー設定済み ／ ' + (config.expert ? '追加分析 ' + config.expert : 'ローカル分析')
        : '音声通話のAPIキーが未設定です。下の設定方法から .env にキーを登録できます。テキストデモは今すぐ試せます。'});
    } catch { publish({configText:'接続設定を取得できませんでした。テキストデモを利用できます。'}); }
  }
  function begin(mode, brief) {
    if (current || disposed) return;
    if (!brief.product.trim() || !brief.goal.trim()) {
      publish({status:'商材と商談の目的を入力してください。'});
      return;
    }
    const s = {mode, brief, fragments:[], ids:new Set(), meter:new TurnMeter(), abort:new AbortController(),
      ready:false, closing:false, pending:null, clock:0, dirtySince:null};
    current = s;
    if (mode === 'live') {
      s.latency = new ReplyLatency();
      s.advice = new ReplyAdvice({
        sendMemo:content => {
          const id = crypto.randomUUID();
          if (!tell(s,{type:'session.thinking.append',event_id:id,delegation_id:null,content})) return false;
          s.pending = id;
          publish({delivery:'音声モデルへ送信・受領待ち'});
          return true;
        },
        requestExpert,
        onExpertState:expertState => { if (current === s && !s.closing) publish({expertState}); },
      });
      s.control = new ConversationControl({
        onChange:action => {
          if (current !== s || s.closing) return;
          if (action === 'end_call') { stop(); return; }
          const waiting = action === 'listen';
          if (waiting) {
            s.advice.interrupt();
            clearTimeout(s.analysisTimer);
            s.dirtySince = null;
          }
          if (s.playbackTrack) s.playbackTrack.enabled = !waiting && !s.interruption.suppressed;
          publish({waitingForUser:waiting, status:waiting ? 'お話を待っています。マイクは接続中です。' : '通話中',
            action:waiting ? '相手の発言を聞いています。' : '相手の直近の用件に応じます。'});
          // Live already heard the request or reply. An additional spoken-turn
          // instruction here would interrupt the answer that Live just began.
        },
        onFailure:() => publish({delivery:'会話制御の判定を取得できませんでした。画面のボタンで再開・終了できます。'}),
      });
      s.interruption = new Interruption({
        setPlayback:enabled => {
          if (s.playbackTrack) s.playbackTrack.enabled = enabled && !s.control.listening && !s.closing;
          if (enabled && s.hearingInterruption) {
            s.hearingInterruption = false;
            if (current === s && !s.closing && !s.control.listening) publish({status:'通話中'});
          }
        },
        onInterrupt:() => {
          if (s.control.listening) return;
          s.advice.interrupt();
          clearTimeout(s.analysisTimer);
          s.dirtySince = null;
          s.hearingInterruption = true;
          publish({status:'発言の途中で割り込みを受け付けました。お話しください。'});
          tell(s,{type:'session.instructions.append', event_id:crypto.randomUUID(), delegation_id:null,
            content:'いま重なった声を優先。質問や訂正なら前の説明を切り上げ、言い終わりに用件から答える。考える時間を求められたら待つ。聞き手の相づちだけなら説明を続ける。'});
        },
      });
    }
    publish({mode, closing:false, waitingForUser:false, ...initialMic, turns:[], advisors:[], acoustic:[], delivery:'メモなし', latencyMs:null, expertState:'',
      action:'相手の発言を待っています。', usage: mode === 'demo' ? 'デモ・API利用なし' : '集計待ち'});
    return s;
  }
  function finish(s, status) {
    if (current !== s) return;
    current = null;
    s.advice?.close();
    s.abort.abort();
    for (const timer of [s.analysisTimer,s.deadline,s.setupTimer,s.closeTimer,s.disconnectTimer]) clearTimeout(timer);
    clearInterval(s.sampling);
    clearInterval(s.playbackWatch);
    s.remoteSampler?.close();
    s.playbackTrack?.stop();
    if (s.frame) cancelAnimationFrame(s.frame);
    s.stream?.getTracks().forEach(t => t.stop());
    s.channel?.close();
    s.peer?.close();
    if (s.context && s.context.state !== 'closed') s.context.close().catch(()=>{});
    if (audioRef.current) audioRef.current.srcObject = null;
    const turns = segments(s.fragments);
    const customer = turns.findLast(t => t.role === 'user');
    publish({status, mode:'idle', closing:false, waitingForUser:false, canChangeMic:false, micLevelDbfs:-90, micNeedsReconnect:false, micChangeError:'', turns, expertState:'',
      ...(s.mode === 'live' && s.ready && {micStatus:s.inputLost ? 'マイクが切断された状態で通話を終了しました。'
        : customer ? 'この通話で顧客の字幕を受信しました。'
        : 'この通話では顧客の字幕を受信できませんでした。次の通話の前にマイクを確認できます。'}),
      action:s.ready || s.mode === 'demo' ? '会話は終了しました。' : '会話は開始されていません。',
      advisors:customer ? [['直近の顧客発言',customer.text]] : [],
      ...(s.pending && {delivery:'最後のメモの受領は未確認'})});
  }
  function tell(s, event) {
    if (current !== s || !s.ready || s.channel?.readyState !== 'open') return false;
    try { s.channel.send(JSON.stringify(event)); return true; }
    catch { finish(s, '接続が切れました。最終利用量は未確認です。'); return false; }
  }
  function stop() {
    const s = current;
    if (!s || s.closing) return;
    s.closing = true;
    s.advice?.close();
    clearTimeout(s.analysisTimer);
    if (s.mode === 'demo') return finish(s, 'デモを終了しました。');
    if (!s.ready) return finish(s, '接続を中止しました。');
    if (s.playbackTrack) s.playbackTrack.enabled = false;
    s.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    if (!tell(s, {type:'session.close'})) return finish(s, '終了しました。最終利用量は未確認です。');
    publish({closing:true, waitingForUser:false, action:'この通話での応対を終了します。', status:'通話の終了を確認中…'});
    s.closeTimer = setTimeout(() => finish(s, '終了しました。最終利用量は未確認です。'),15_000);
  }
  function updatePlan(s) {
    if (current !== s || s.closing) return;
    const turns = segments(s.fragments);
    const last = turns.filter(t=>t.role==='user').at(-1);
    if (!last) return;
    const plan = assess(turns, recentAudio(s));
    const next = strategy(s.brief, turns, plan);
    publish({...(s.control?.listening ? {} : {action:next.action}), advisors:[['論点',plan.topics], ['意向・異議',plan.state],
      ['選んだ手法',next.method], ['目標の進捗',next.progress], ['話すペース',plan.pace], ['直近の顧客発言',last.text]]});
    if (s.advice && !s.control.listening && config?.expert) {
      // Local keyword estimates drive the dashboard. They are never ground truth for Live.
      s.advice.stage(expertInput(s.brief, turns, last, plan));
    }
    return next;
  }
  function transcript(s,e) {
    if (typeof e.delta !== 'string' || !e.delta || !Number.isFinite(e.start_ms) || !Number.isFinite(e.end_ms) || e.end_ms < e.start_ms) return;
    const user = e.type === 'session.input_transcript.delta';
    if (user && e.delta.trim() && !s.inputLost) {
      if (s.status === greetingStatus || s.status === firstInputStatus) publish({status:'通話中'});
      s.inputSoundAt = null;
      s.weakFrames = 0;
      s.lastCaptionAt = performance.now();
      if (!s.stream?.getAudioTracks()[0]?.muted) micMessage(s, '顧客の字幕を受信しました。');
    }
    if (user && !s.closing) s.control.input(e,performance.now());
    if (!s.closing && e.delta.trim()) s.interruption.transcript(user,e.start_ms,e.end_ms,performance.now());
    // This records our playback policy at caption receipt; RTP audio has a separate clock.
    const playbackSuppressed = !user && (s.control.listening || s.interruption.suppressed || s.playbackTrack?.enabled === false);
    s.fragments.push({role:user?'user':'assistant', text:e.delta, start:e.start_ms, end:e.end_ms,
      ...(playbackSuppressed && {playbackSuppressed:true})});
    if (!s.frame) s.frame = requestAnimationFrame(()=>{
      s.frame=0;
      if (current === s) publish({turns:segments(s.fragments)});
    });
    if (user && !s.closing) {
      s.advice.input(e.end_ms);
      // Deltas have no final-turn event. Coalesce bursts but also analyse long utterances.
      s.dirtySince ??= performance.now();
      clearTimeout(s.analysisTimer);
      const delay = Math.max(0, Math.min(650, 2500 - (performance.now() - s.dirtySince)));
      s.analysisTimer = setTimeout(()=>{ s.dirtySince=null; updatePlan(s); },delay);
    } else if (!user && !s.closing && !s.interruption.suppressed && !s.control.listening && e.delta.trim()) {
      s.advice.output(e.start_ms);
    }
  }
  function event(s,e) {
    if (current !== s || !e || typeof e.type !== 'string') return;
    if (e.event_id && s.ids.has(e.event_id)) return;
    if (e.event_id) s.ids.add(e.event_id);
    switch (e.type) {
      case 'session.started':
        s.ready = true;
        clearTimeout(s.setupTimer);
        s.playbackWatch = setInterval(()=>{
          if (s.closing) return;
          const now = performance.now();
          s.interruption.tick(now);
          s.control.tick(now);
        },80);
        publish({canChangeMic:true, status:s.brief.proactive ? greetingStatus : firstInputStatus});
        break;
      case 'session.paused':
      case 'session.resumed':
        if (!s.closing && !s.control.listening) publish({status:e.type==='session.paused'?'待機中・話しかけると再開します':'通話中'});
        break;
      case 'decision.event':
        if (!s.closing) s.control.decision(e,performance.now());
        break;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        transcript(s,e);
        break;
      case 'session.thinking.appended':
        if (s.pending && s.pending===e.client_event_id) {s.pending=null; publish({delivery:'音声モデルが受領'});}
        break;
      case 'session.delegation.created':
        if (!s.closing && e.delegation?.id) {
          // No business tool was started. Cancel the automatic waiting announcement.
          tell(s,{type:'session.thinking.append',event_id:crypto.randomUUID(),delegation_id:e.delegation.id,content:''});
        }
        break;
      case 'session.usage.updated':
      case 'session.closed':
        if (Number.isFinite(e.usage?.seconds)) publish({usage:e.usage.seconds+' 秒'+(e.type==='session.closed'?'（確定）':'（累積）')});
        if (e.type==='session.closed') finish(s, '通話が終了しました。');
        break;
      case 'error': {
        const id = e.error?.client_event_id ?? e.client_event_id;
        if (id && id===s.pending) { s.pending=null; publish({delivery:'メモ送信エラー'}); }
        else publish({delivery:'Live API エラー（'+(e.error?.code ?? '不明')+'）'});
        break;
      }
    }
  }
  function micMessage(s, text, reconnect = false) {
    const message = s.micName + ' ／ ' + text;
    if (s.micMessage === message && s.micNeedsReconnect === reconnect) return;
    s.micMessage = message;
    s.micNeedsReconnect = reconnect;
    publish({micStatus:message, micNeedsReconnect:reconnect});
  }
  function connectMicMeter(s) {
    if (!s.micAnalyser) return;
    s.micSource?.disconnect();
    s.micSource = s.context.createMediaStreamSource(s.stream);
    s.micSource.connect(s.micAnalyser);
  }
  function useMicrophone(s, stream) {
    s.stream = stream;
    const track = stream.getAudioTracks()[0];
    s.micName = track.label || '選択したマイク';
    s.inputLost = false;
    s.inputSoundAt = null;
    s.weakFrames = 0;
    s.lastWeakAt = -Infinity;
    s.lastActiveAt = -Infinity;
    s.lastCaptionAt = null;
    s.firstSample = performance.now();
    publish({micLevelDbfs:-90});
    const stateChanged = () => {
      if (current !== s || s.closing || s.stream !== stream) return;
      s.inputLost = track.readyState === 'ended';
      if (s.inputLost || track.muted) publish({micLevelDbfs:-90});
      if (s.inputLost) micMessage(s, '接続が切れました。マイクを再接続するか、別の入力を選んでください。', true);
      else if (track.muted) micMessage(s, '入力が一時停止しています。ミュートを解除するか、マイクを再接続してください。', true);
      else micMessage(s, '顧客の字幕を待っています。');
    };
    for (const name of ['mute','unmute','ended']) track.addEventListener(name, stateChanged);
    stateChanged();
  }
  async function switchMicrophone(deviceId) {
    const s = current;
    if (!s?.ready || !s.micSender || s.closing || s.switchingMic) return false;
    s.switchingMic = true;
    publish({micChangeError:''});
    let stream;
    try {
      stream = await openMicrophone(deviceId);
      if (current !== s || s.closing) return false;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('マイクから音声を取得できません。');
      await s.micSender.replaceTrack(track);
      if (current !== s || s.closing) return false;
      const previous = s.stream;
      useMicrophone(s, stream);
      previous.getTracks().forEach(t => t.stop());
      try { connectMicMeter(s); }
      catch { publish({acoustic:[['計測状態','この入力を計測できませんでした']]}); }
      return true;
    } catch (error) {
      if (current === s && !s.closing) {
        publish({micChangeError:'入力を切り替えられませんでした。' + microphoneError(error)});
      }
      return false;
    } finally {
      if (stream && s.stream !== stream) stream.getTracks().forEach(t => t.stop());
      s.switchingMic = false;
    }
  }
  async function monitorMic(s) {
    s.context=new AudioContext({latencyHint:'interactive'});
    await s.context.resume();
    if (current!==s) return;
    const analyser=s.context.createAnalyser();
    analyser.fftSize=s.context.sampleRate>60_000?4096:2048;
    s.micAnalyser = analyser;
    connectMicMeter(s);
    const pcm=new Float32Array(analyser.fftSize);
    s.firstSample=performance.now();
    let drawn=0;
    let micLevelDbfs = -90;
    s.sampling=setInterval(()=>{
      const now=performance.now();
      if (s.context.state==='running') {
        analyser.getFloatTimeDomainData(pcm);
        const remote = s.remoteSampler?.read();
        const mic = s.meter.add(pcm,s.context.sampleRate,now);
        const input = s.stream.getAudioTracks()[0];
        if (s.ready && !s.closing && !s.inputLost && !input.muted) {
          micLevelDbfs = Math.max(micLevelDbfs, Math.round(mic?.levelDbfs ?? -90));
          if (mic?.active) {
            s.lastActiveAt = now;
            if (s.inputSoundAt == null && now - (s.lastCaptionAt ?? -Infinity) > 1500) {
              s.inputSoundAt = now;
              micMessage(s, '端末で入力音を検出しました。顧客の字幕を待っています。');
            }
            s.weakFrames = 0;
          } else if (mic?.levelDbfs > -72) {
            if (now - s.lastWeakAt > 250) s.weakFrames = 0;
            s.weakFrames++;
            s.lastWeakAt = now;
          }
          if (now - s.lastActiveAt > 8000) s.inputSoundAt = null;
          if (s.inputSoundAt != null && now - s.inputSoundAt > 4000) {
            micMessage(s, '端末で入力音を検出しました。この発言の顧客字幕はまだ届いていません。', true);
          } else if (s.inputSoundAt == null && now - (s.lastCaptionAt ?? s.firstSample) > 4000) {
            if (s.weakFrames >= 6 && now - s.lastWeakAt < 3000) {
              micMessage(s, '入力音が小さい状態です。マイクに近づくか、入力音量または「使用するマイク」を確認してください。', true);
            } else if (s.lastCaptionAt !== null && s.lastActiveAt <= s.lastCaptionAt + 1500) {
              micMessage(s, '前の発言の字幕を受信しました。次の発言を待っています。');
            } else if (now - (s.lastCaptionAt ?? s.firstSample) > 8000) {
              micMessage(s, '現在、入力音を検出していません。話しても変わらない場合はマイクを再接続するか、別の入力を選んでください。', true);
            }
          }
        }
        if (s.ready && !s.closing && mic?.voiced) s.control.voice(now);
        if (s.ready && !s.closing && !s.control.listening && mic && remote) {
          s.interruption.observe({micActive:mic.active, voiced:mic.voiced, remoteActive:remoteAudioActive(remote)}, now);
        }
        const delay = s.latency.observe(pcm,remote,now,playbackMode(s,audioRef.current));
        if (delay !== null) publish({latencyMs:delay});
        s.lastSample=now;
      }
      if (now-drawn>=500) {
        const silent = s.context.state !== 'running' || s.inputLost || s.stream.getAudioTracks()[0]?.muted;
        publish({acoustic:audioRows(recentAudio(s)), micLevelDbfs:silent ? -90 : micLevelDbfs});
        drawn=now;
        micLevelDbfs = -90;
      }
    },20);
  }
  async function startLive(product, goal, target, proactive, deviceId = '') {
    const s = begin('live', {product,goal,target,proactive});
    if (!s) return;
    publish({status:'マイクと音声接続を準備しています…'});
    s.setupTimer = setTimeout(()=>finish(s,'マイクの許可または接続がタイムアウトしました。'),55_000);
    try {
      let stream;
      try { stream = await openMicrophone(deviceId); }
      catch (error) { throw new Error(microphoneError(error)); }
      if (current!==s) {stream.getTracks().forEach(t=>t.stop()); return;}
      const inputTrack = stream.getAudioTracks()[0];
      if (!inputTrack || inputTrack.readyState === 'ended') {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('マイクから音声を取得できません。');
      }
      useMicrophone(s, stream);
      const peer=new RTCPeerConnection();
      s.peer=peer;
      peer.ontrack=({track,receiver})=>{
        if (current!==s || !audioRef.current) return;
        // Prefer minimum playout delay; WebRTC can increase it on a jittery link.
        if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
        const remoteStream = new MediaStream([track]);
        // Keep receiving and analysing the original even when the local speaker
        // is silenced. Track controls leave the user's volume and mute intact.
        s.playbackTrack?.stop();
        s.playbackTrack=track.clone();
        s.playbackTrack.enabled=!s.interruption.suppressed && !s.control.listening && !s.closing;
        audioRef.current.srcObject=new MediaStream([s.playbackTrack]);
        audioRef.current.play().catch(()=>{if(current===s) publish({status:'音声プレーヤーの再生を押してください。'});});
        if (s.context && s.context.state !== 'closed') {
          s.remoteSampler?.close();
          try { s.remoteSampler=createRemoteSampler(s.context,remoteStream); }
          catch { s.remoteSampler=null; }
        }
      };
      peer.onconnectionstatechange=()=>{
        if (current!==s) return;
        clearTimeout(s.disconnectTimer);
        if (peer.connectionState==='failed') finish(s,'音声接続が切れました。最終利用量は未確認です。');
        if (peer.connectionState==='disconnected') s.disconnectTimer=setTimeout(()=>finish(s,'接続が復帰しませんでした。最終利用量は未確認です。'),10_000);
      };
      s.micSender = peer.addTrack(inputTrack,stream);
      // Metering is optional. A suspended AudioContext must not delay the voice connection.
      void monitorMic(s).catch(()=>{
        if (current===s) publish({acoustic:[['計測状態','この端末で音響解析を開始できませんでした']]});
      });
      s.channel=peer.createDataChannel('oai-events');
      s.channel.onmessage=({data})=>{
        let parsed;
        try {parsed=JSON.parse(data);} catch {return;}
        event(s,parsed);
      };
      s.channel.onclose=()=>finish(s,'接続が切れました。最終利用量は未確認です。');
      await peer.setLocalDescription(await peer.createOffer());
      await gather(peer,s.abort.signal);
      const response=await fetch('/api/session',{method:'POST',signal:s.abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:peer.localDescription.sdp,...s.brief})});
      if (!response.ok) throw new Error((await response.text()).trim());
      const result=await response.json();
      if (current!==s) return;
      s.deadline=setTimeout(()=>{ if(current===s) stop(); },15*60_000);
      await peer.setRemoteDescription({type:'answer',sdp:result.transport.sdp});
    } catch (e) {
      finish(s,'開始できませんでした。'+(e.name==='NotAllowedError'?'マイクの使用を許可してください。':e.message));
    }
  }
  function startDemo(product, goal, target, proactive) {
    const s=begin('demo',{product,goal,target,proactive});
    if (!s) return;
    if (proactive) s.fragments.push({role:'assistant',text:opening(s.brief),start:0,end:900});
    publish({status:'テキストデモ・顧客役の発言を入力してください。',turns:segments(s.fragments),acoustic:audioRows(null)});
  }
  function sendDemo(text) {
    const s=current;
    if (!text.trim() || s?.mode!=='demo') return;
    s.clock+=2500;
    s.fragments.push({role:'user',text:text.trim(),start:s.clock,end:s.clock+700});
    const next=updatePlan(s);
    s.fragments.push({role:'assistant',text:next.example,start:s.clock+950,end:s.clock+1600});
    publish({turns:segments(s.fragments),delivery:'ローカル判定・応答例'});
  }
  function leave() {
    const s=current;
    if (!s) return;
    if (s.mode==='live' && s.ready && !s.closing) tell(s,{type:'session.close'});
    finish(s,'終了しました。');
  }
  function dispose() {
    disposed=true;
    configAbort.abort();
    window.removeEventListener('pagehide',leave);
    leave();
  }
  window.addEventListener('pagehide',leave);
  loadConfig();
  function resumeConversation() {
    const s = current;
    if (s?.ready && !s.closing && s.control.listening) {
      s.control.resume();
      tell(s,{type:'session.instructions.append',event_id:crypto.randomUUID(),delegation_id:null,
        content:'会話を再開する操作を受けた。顧客の直近の用件にまだ答えていなければ、直接応じる。'});
    }
  }
  return {startLive,startDemo,sendDemo,resumeConversation,switchMicrophone,stop,dispose};
}
