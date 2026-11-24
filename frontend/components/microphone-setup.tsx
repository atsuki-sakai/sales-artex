"use client";

import { useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { microphoneError, openMicrophone } from "@/lib/microphone.mjs";

type Props = {
  device: string;
  select: (id: string) => void;
  busy: boolean;
  checkRef: RefObject<AbortController | null>;
  liveInput: string;
  liveLevel: number;
  reconnect: boolean;
  changeError: string;
  switchLive?: (id: string) => Promise<boolean>;
};

export function MicrophoneSetup({device, select, busy, switchLive, liveLevel, liveInput, reconnect, changeError, checkRef}: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [switching, setSwitching] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  const [level, setLevel] = useState(-90);

  const live = Boolean(switchLive);

  useEffect(() => {
    const media = navigator.mediaDevices;
    let active = true;
    async function refresh() {
      const list = await media?.enumerateDevices().catch(() => []);
      if (active) setDevices((list ?? []).filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"));
    }
    void refresh();
    media?.addEventListener("devicechange", refresh);
    return () => { active = false; media?.removeEventListener("devicechange", refresh); };
  }, [checking, busy, live]);

  useEffect(() => {
    const release = () => checkRef.current?.abort();
    window.addEventListener("pagehide", release);
    return () => { window.removeEventListener("pagehide", release); release(); };
  }, [checkRef]);
  useEffect(() => {
    if (busy) { checkRef.current?.abort(); setChecking(false); setResult(""); }
  }, [busy, checkRef]);

  async function check() {
    if (checkRef.current || busy) return;
    const controller = new AbortController();
    checkRef.current = controller;
    setChecking(true);
    setLevel(-90);
    setResult("マイクの使用を許可してください。");
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    function release() {
      clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => {});
      if (checkRef.current === controller) checkRef.current = null;
    }
    controller.signal.addEventListener("abort", release, {once:true});
    try {
      const capture: MediaStream = await openMicrophone(device);
      stream = capture;
      if (controller.signal.aborted) { release(); return; }
      const name = capture.getAudioTracks()[0]?.label || "選択したマイク";
      context = new AudioContext();
      await context.resume();
      if (controller.signal.aborted) return;
      const analyser = context.createAnalyser();
      const source = context.createMediaStreamSource(capture);
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let audibleFrames = 0;
      setResult(name + " に向かって、いつもの声で話してください。");
      const start = performance.now();
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const power = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
        const db = Math.max(-90, 10 * Math.log10(power));
        setLevel(db);
        if (db > -45) audibleFrames++;
        if (performance.now() - start < 6000) return;
        setResult(audibleFrames >= 3
          ? name + " で入力音を検出しました。"
          : name + " で十分な入力音を検出できませんでした。入力を選び直すか、入力音量を確認してください。");
        setChecking(false);
        controller.abort();
      }, 60);
    } catch (error) {
      if (!controller.signal.aborted) {
        setResult(microphoneError(error));
        setChecking(false);
        controller.abort();
      }
    }
  }

  async function changeDevice(id: string) {
    setResult("");
    if (!switchLive) { select(id); return; }
    setSwitching(true);
    try { if (await switchLive(id)) select(id); }
    finally { setSwitching(false); }
  }

  return <div className="mic-setup">
    <Label htmlFor="mic-device">使用するマイク</Label>
    <select id="mic-device" value={device} disabled={checking || switching || (busy && !switchLive)} onChange={e => { void changeDevice(e.target.value); }}>
      <option value="">ブラウザの既定の入力</option>
      {device && !devices.some(d => d.deviceId === device) && <option value={device}>選択したマイク（現在見つかりません）</option>}
      {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || "マイク " + (i + 1)}</option>)}
    </select>
    {reconnect && switchLive && <Button variant="outline" type="button" disabled={switching} onClick={() => { void changeDevice(device); }}>マイクを再接続</Button>}
    {changeError && <p className="hint" role="alert">{changeError}</p>}
    {!busy && <Button id="mic-check" variant="outline" type="button" onClick={() => {
      if (checking) { checkRef.current?.abort(); setChecking(false); setResult(""); }
      else void check();
    }}>{checking ? "確認を停止" : "マイクを確認（6秒）"}</Button>}
    {(switchLive || checking) && <meter aria-label="マイクの入力レベル" min={-90} max={0} value={checking ? level : liveLevel}/>}
    {(result || liveInput) && <p id="mic-result" className="hint" role="status">{result || liveInput}</p>}
  </div>;
}
