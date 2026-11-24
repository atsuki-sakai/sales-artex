'use client';

import {useEffect, useRef, useState} from 'react';
import {createDesk, initialView} from './session.mjs';

type Turn = {role:'user'|'assistant'; text:string; start:number; end:number; playbackSuppressed?:boolean};
type DeskView = {
  mode:'idle'|'demo'|'live'; closing:boolean; waitingForUser:boolean; readyToCall:boolean;
  configText:string; status:string; usage:string; turns:Turn[];
  advisors:[string,string][]; acoustic:[string,string][]; action:string; delivery:string;
  latencyMs:number|null; expertState:string; micStatus:string; canChangeMic:boolean; micLevelDbfs:number; micNeedsReconnect:boolean; micChangeError:string;
};
type Start = (product:string, goal:string, target:string, proactive:boolean) => void;

export function useDesk() {
  const [view, setView] = useState<DeskView>({...initialView, mode:'idle'});
  const audioRef = useRef<HTMLAudioElement>(null);
  const desk = useRef<ReturnType<typeof createDesk> | null>(null);
  useEffect(() => {
    const instance = createDesk((fields:Partial<DeskView>)=>setView(before=>({...before,...fields})), audioRef);
    desk.current = instance;
    return () => { desk.current=null; instance.dispose(); };
  }, []);
  const startLive = (product:string, goal:string, target:string, proactive:boolean, deviceId:string)=>{
    void desk.current?.startLive(product, goal, target, proactive, deviceId);
  };
  const startDemo:Start = (...args)=>{ desk.current?.startDemo(...args); };
  return {...view, audioRef, startLive, startDemo,
    switchMicrophone:(id:string)=>desk.current?.switchMicrophone(id) ?? Promise.resolve(false),
    sendDemo:(text:string)=>desk.current?.sendDemo(text), resumeConversation:()=>desk.current?.resumeConversation(),
    stop:()=>desk.current?.stop()};
}
