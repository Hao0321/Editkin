import {useEffect, useRef, useState} from "react";
import type {MutableRefObject} from "react";
import type {EditProject} from "../domain/types";
import {ResidentAudioTransport, type ResidentAudioView} from "./residentAudioTransport";
import type {ResidentAudioApi} from "./residentAudioTypes";

interface Options {
  api?: ResidentAudioApi;
  project: EditProject;
  playing: boolean;
  hasAudio: boolean;
  seekRevision: number;
  playhead: MutableRefObject<number>;
  onClock: (time:number, ended:boolean)=>void;
}
export function useResidentAudioTransport({api, project, playing, hasAudio, seekRevision, playhead, onClock}:Options) {
  const [admission,setAdmission]=useState<{api?:ResidentAudioApi;caps?:Awaited<ReturnType<ResidentAudioApi["capabilities"]>>}>({});
  const [view,setView]=useState<ResidentAudioView>({mode:"idle"});
  const transport=useRef<ResidentAudioTransport|undefined>(undefined);
  const callback=useRef(onClock);callback.current=onClock;
  const route=!api?"legacy":admission.api!==api?"checking":admission.caps?.supported
    && admission.caps.gpuClock && admission.caps.clockSchema==="editkin.resident-audio-clock/v1"?"resident":"legacy";
  useEffect(()=>{
    if(!api)return;
    let active=true;
    void api.capabilities().then(caps=>{if(active)setAdmission({api,caps:caps.schema==="editkin.desktop-audio-capabilities/v1"&&caps.sampleRate===48000?caps:undefined});},()=>{if(active)setAdmission({api});});
    return()=>{active=false;};
  },[api]);
  useEffect(()=>{
    if(route!=="resident" || !api || !admission.caps)return;
    let active=true;const caps=admission.caps;
    const controller=new ResidentAudioTransport({...api,capabilities:async()=>caps},next=>{if(active)setView(next);},(time,ended)=>{if(active)callback.current(time,ended);});
    transport.current=controller;
    return()=>{active=false;if(transport.current===controller)transport.current=undefined;
      void controller.dispose().catch(error=>console.warn("Editkin resident audio cleanup remains unconfirmed",error));};
  },[api,route,admission.caps]);
  useEffect(()=>{
    if(route!=="resident")return;
    transport.current?.update({project,playing:playing&&hasAudio,seekRevision,timelineStartSeconds:playhead.current});
  },[route,api,project.id,project.revision,project.updatedAt,playing,hasAudio,seekRevision]);
  const bound=view.stage;
  const stale=bound&&(bound.projectId!==project.id||bound.projectRevision!==project.revision||bound.projectUpdatedAt!==project.updatedAt||view.seekRevision!==seekRevision);
  return {route,view:!hasAudio?{mode:playing?"compatible":"idle"} as ResidentAudioView
    :stale?{...view,mode:playing?"preparing":"idle",generation:undefined,stage:undefined} as ResidentAudioView:view};
}
