"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDesk } from "@/lib/use-desk";
import { MicrophoneSetup } from "./microphone-setup";

type Rows = [string, string][];

function Observations({ id, rows, empty }: { id: string; rows: Rows; empty: string }) {
  return rows.length ? (
    <dl id={id} className="observations">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  ) : <p id={id} className="hint">{empty}</p>;
}

export function Desk() {
  const desk = useDesk();
  const [product, setProduct] = useState("見積作成支援のデモ。商品一覧から見積書を作成できます。料金と納期は個別確認です。");
  const [goal, setGoal] = useState("見積作成で手間のかかる作業を伺い、関心があればデモの日程を相談する。");
  const [target, setTarget] = useState("架空例：設備工事会社の営業責任者。前回「見積を表計算で作っている」と伺った。転記の手間が課題かどうかは未確認。");
  const [proactive, setProactive] = useState(true);
  const [micDevice, setMicDevice] = useState("");
  const micCheck = useRef<AbortController | null>(null);
  const [sample, setSample] = useState("");
  const [demoLog, setDemoLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  const sessionOpen = desk.mode !== "idle" || desk.closing;
  const canStart = !sessionOpen && Boolean(product.trim() && goal.trim());

  useEffect(() => {
    const log = logRef.current;
    if (log && followLog.current) log.scrollTop = log.scrollHeight;
  }, [desk.turns]);

  return (
    <>
      <header className="topbar">
        <div className="brand"><span aria-hidden="true" className="wave"><i/><i/><i/><i/><i/></span>Sales Artex</div>
        <div className="session-state">
          <span id="status" role="status">{desk.status}</span>
          <span id="usage" aria-label="通話の利用状況">{desk.usage}</span>
        </div>
      </header>
      <main>
        <header className="intro">
          <h1>商談デスク</h1>
          <p>架空の「見積作成支援」で商談を試せます。自社の商材で音声商談を始めるには、案内できる内容と目的を入力してください。</p>
        </header>
        <div className="desk">
          <section className="settings" aria-labelledby="settings-title">
            <h2 id="settings-title">商談設定</h2>
            <Label htmlFor="product">商材と案内できる内容</Label>
            <Textarea id="product" rows={4} maxLength={1600} value={product} disabled={sessionOpen} onChange={e => setProduct(e.target.value)}/>
            <Label htmlFor="goal">今回の目的</Label>
            <Textarea id="goal" rows={3} maxLength={240} value={goal} disabled={sessionOpen} onChange={e => setGoal(e.target.value)}/>
            <Label htmlFor="target">商談相手の事前情報（任意）</Label>
            <Textarea id="target" rows={3} maxLength={1200} value={target} disabled={sessionOpen} onChange={e => setTarget(e.target.value)} placeholder="業種、役割、確認できた課題、未確認の仮説"/>
            <Label className="proactive" htmlFor="proactive">
              <input type="checkbox" id="proactive" checked={proactive} disabled={sessionOpen} onChange={e => setProactive(e.target.checked)}/>
              AI から挨拶を始める
            </Label>
            <p className="hint">オフにすると相手の声で開始し、15秒の無発話で省費用の待機状態に戻ります。</p>
            <MicrophoneSetup
              device={micDevice} select={setMicDevice} busy={sessionOpen} checkRef={micCheck}
              liveInput={desk.micStatus} liveLevel={desk.micLevelDbfs}
              reconnect={desk.micNeedsReconnect} changeError={desk.micChangeError}
              switchLive={desk.canChangeMic && !desk.closing ? desk.switchMicrophone : undefined}
            />
            <div className="controls">
              <Button id="start" size="lg" disabled={!canStart || !desk.readyToCall} onClick={() => {
                micCheck.current?.abort();
                setDemoLog(false);
                followLog.current = true;
                desk.startLive(product.trim(), goal.trim(), target.trim(), proactive, micDevice);
              }}>音声で商談を開始</Button>
              <Button id="demo" variant="outline" disabled={!canStart} onClick={() => {
                setDemoLog(true);
                setSample("");
                followLog.current = true;
                desk.startDemo(product.trim(), goal.trim(), target.trim(), proactive);
              }}>テキストで試す</Button>
              {desk.waitingForUser && desk.mode === "live" && !desk.closing && (
                <Button id="resume" variant="outline" onClick={desk.resumeConversation}>会話を再開</Button>
              )}
              <Button id="stop" variant="outline" disabled={!sessionOpen || desk.closing} onClick={() => desk.stop()}>終了</Button>
            </div>
            <p className="hint">音声通話では、相手のマイク音声を OpenAI に送り、AI 営業担当が声で応答します。相手の同意を得て開始してください。開始から15分で終了をリクエストします。</p>
            <p className="hint mt-2">テキストデモでは、商談設定と発言をもとに端末内で応答例を組み立てます。</p>
            <p className="config hint" id="config" role="status">{desk.configText}</p>
            <details>
              <summary>音声 API の設定方法</summary>
              <p className="hint">プロジェクト直下の <code>.env</code> を開き、<code>OPENAI_API_KEY=</code> の右側にキーを貼り付けて保存します。ファイルがない場合は <code>.env.example</code> を <code>.env</code> にコピーしてください。</p>
              <p className="hint">保存後にこの画面を再読み込みすると、次の通話に設定が反映されます。</p>
            </details>
          </section>
          <section className="conversation" aria-labelledby="log-title">
            <div className="section-head">
              <h2 id="log-title">会話ログ</h2>
              {demoLog && <span className="log-mode">テキストデモ</span>}
            </div>
            <div ref={logRef} id="transcript" role="log" aria-label="会話ログ" tabIndex={0} onScroll={e => {
              const log = e.currentTarget;
              followLog.current = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
            }}>
              {desk.turns.length === 0 && <p className="empty-log">商談を開始すると、ここに発言が並びます。</p>}
              {desk.turns.map((turn, i) => (
                <article key={turn.role + "-" + turn.start + "-" + i} className={"turn " + turn.role}>
                  <strong>{turn.role === "user" ? "顧客" : demoLog ? "応答例" : turn.playbackSuppressed ? "AI 営業担当（消音中に受信した字幕）" : "AI 営業担当"}</strong>
                  <p>{turn.text}</p>
                </article>
              ))}
            </div>
            <form id="sampleForm" hidden={desk.mode !== "demo"} onSubmit={e => {
              e.preventDefault();
              const text = sample.trim();
              if (!text) return;
              desk.sendDemo(text);
              setSample("");
            }}>
              <Label htmlFor="sampleText">顧客役の発言</Label>
              <div className="compose">
                <Input id="sampleText" required maxLength={1600} value={sample} onChange={e => setSample(e.target.value)} placeholder="たとえば「月額はいくらですか？」" autoComplete="off"/>
                <Button type="submit" disabled={!sample.trim()}>送信</Button>
              </div>
            </form>
            <div className="playback" hidden={demoLog}>
              <Label htmlFor="audio">AI の音声</Label>
              <audio ref={desk.audioRef} id="audio" controls autoPlay playsInline aria-label="AI 営業担当の音声"/>
            </div>
          </section>
          <section className="insights" aria-labelledby="insights-title">
            <h2 id="insights-title">商談分析</h2>
            <Card className="plan">
              <CardContent className="px-4">
                <h3>端末の応答候補</h3>
                <p id="action">{desk.waitingForUser ? "相手が再び質問するか、会話の再開を希望するまで聞く。" : desk.action || "顧客の発言を待っています。"}</p>
                <span id="delivery">{desk.delivery}</span>
              </CardContent>
            </Card>
            <h3>専門家の見立て</h3>
            <Observations id="advisors" rows={desk.advisors} empty="発言を受け取ると表示します。"/>
            {desk.expertState && <p id="expert-state" className="hint">{desk.expertState}</p>}
            {!demoLog && (desk.mode === 'live' || desk.latencyMs !== null) && <>
              <h3>直近の応答待ち時間</h3>
              <p id="reply-latency">{desk.latencyMs === null ? '計測待ち' : (desk.latencyMs / 1000).toFixed(2) + ' 秒'}</p>
              <p className="hint">相手が話し終えてから、ブラウザでAIの声が再生できるまでの推定値です。短い音や声が重なって区別できない区間は除きます。</p>
            </>}
            <h3>マイクの観測値</h3>
            <p className="hint period">直近5秒の音声</p>
            <Observations id="acoustic" rows={desk.acoustic} empty="音声通話中に計測します。"/>
          </section>
        </div>
      </main>
    </>
  );
}
