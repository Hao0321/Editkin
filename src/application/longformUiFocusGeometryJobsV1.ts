import {randomBytes} from "node:crypto";
import type {EditProject} from "../domain/types";
import type {PreparedLongformUiFocusGeometryV1} from "../domain/longformUiFocusGeometryDraftV1";
import {longformUiFocusGeometryFileRequestV1Schema} from "../domain/longformUiFocusGeometryFileV1";
import {describeLongformUiFocusGeometryV1} from "./longformUiFocusGeometryDraftV1";
export interface LongformUiFocusGeometryOwnedV1 {project:EditProject;handle:PreparedLongformUiFocusGeometryV1}
export interface LongformUiFocusGeometryJobDepsV1 {
  admitHold:(holdJobId:string)=>void;
  prepare:(holdJobId:string,signal:AbortSignal)=>Promise<LongformUiFocusGeometryOwnedV1>;
  validateCurrent:(holdJobId:string,value:LongformUiFocusGeometryOwnedV1,signal?:AbortSignal)=>Promise<void>;
}
export interface LongformUiFocusGeometryJobV1 {
  jobId:string;holdJobId:string;state:'RUNNING'|'CANCELLING'|'CANCELLED'|'FAILED'|'COMPLETED';startedAt:string;finishedAt?:string;error?:string;
  result?:{draftId:string;artifactId:string;holdReceiptSha256:string;frameCount:number;projectModified:false;focusHintsReady:false;artworkStatus:'ART_PENDING_CLAUDE'};
}
type Owned={ticket:LongformUiFocusGeometryJobV1;controller:AbortController;done:Promise<void>;value?:LongformUiFocusGeometryOwnedV1};
const active=(row:Owned)=>row.ticket.state==='RUNNING'||row.ticket.state==='CANCELLING';
export class LongformUiFocusGeometryJobsV1 {
  private readonly jobs=new Map<string,Owned>();private closed=false;
  constructor(private readonly deps:LongformUiFocusGeometryJobDepsV1){}
  private admit(id:string){if(this.closed)throw Error('UI_FOCUS_GEOMETRY_JOBS_CLOSED');this.deps.admitHold(id);}
  start(raw:unknown){const request=longformUiFocusGeometryFileRequestV1Schema.parse(raw);this.admit(request.holdJobId);
    if([...this.jobs.values()].some(active))throw Error('UI_FOCUS_GEOMETRY_ALREADY_RUNNING');
    while(this.jobs.size>=32){const oldest=[...this.jobs.entries()].find(([,r])=>!active(r));if(!oldest)throw Error('UI_FOCUS_GEOMETRY_HISTORY_FULL');this.jobs.delete(oldest[0]);}
    const ticket:LongformUiFocusGeometryJobV1={jobId:'ug-'+randomBytes(12).toString('hex'),...request,state:'RUNNING',startedAt:new Date().toISOString()};
    const row:Owned={ticket,controller:new AbortController(),done:Promise.resolve()};this.jobs.set(ticket.jobId,row);
    row.done=Promise.resolve().then(async()=>{const signal=row.controller.signal;try{
      signal.throwIfAborted();this.admit(request.holdJobId);const value=await this.deps.prepare(request.holdJobId,signal);signal.throwIfAborted();
      this.admit(request.holdJobId);await this.deps.validateCurrent(request.holdJobId,value,signal);signal.throwIfAborted();this.admit(request.holdJobId);
      const draft=describeLongformUiFocusGeometryV1(value.project,value.handle);row.value=value;
      ticket.result={draftId:draft.draftId,artifactId:draft.artifactId,holdReceiptSha256:draft.holdReceiptSha256,frameCount:draft.frames.length,
        projectModified:false,focusHintsReady:false,artworkStatus:'ART_PENDING_CLAUDE'};ticket.state='COMPLETED';
    }catch(error){ticket.state=signal.aborted?'CANCELLED':'FAILED';ticket.error=signal.aborted?'Geometry analysis cancelled after owned process settlement':
      (error instanceof Error?error.message:String(error)).replace(/[A-Za-z]:[\\/][^\r\n]+/g,'[local-path]').slice(0,1000);delete row.value;delete ticket.result;
    }finally{ticket.finishedAt=new Date().toISOString();}});return structuredClone(ticket);
  }
  private row(id:string){const row=this.jobs.get(id);if(!row)throw Error('UI_FOCUS_GEOMETRY_JOB_NOT_FOUND');return row;}
  private async current(row:Owned){this.admit(row.ticket.holdJobId);if(!row.value||row.ticket.state!=='COMPLETED')throw Error('UI_FOCUS_GEOMETRY_NOT_COMPLETED');
    await this.deps.validateCurrent(row.ticket.holdJobId,row.value);this.admit(row.ticket.holdJobId);
    if(this.jobs.get(row.ticket.jobId)!==row)throw Error('UI_FOCUS_GEOMETRY_OWNER_RETIRED');return describeLongformUiFocusGeometryV1(row.value.project,row.value.handle);}
  async get(id:string){const row=this.row(id);if(row.value)await this.current(row);return structuredClone(row.ticket);}
  cancel(id:string){const row=this.row(id);if(active(row)){row.ticket.state='CANCELLING';row.controller.abort();}return structuredClone(row.ticket);}
  async read(id:string,offset:number,limit:number){if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>32)throw Error('UI_FOCUS_GEOMETRY_PAGE_BUDGET');
    const row=this.row(id),draft=await this.current(row),items=draft.frames.slice(offset,offset+limit);
    const{frames:_frames,...summary}=draft;return structuredClone({...row.ticket,...summary,offset,total:draft.frames.length,items,
      nextOffset:offset+items.length<draft.frames.length?offset+items.length:null});}
  async close(){this.closed=true;for(const[id,row]of this.jobs)if(active(row))this.cancel(id);
    await Promise.all([...this.jobs.values()].map(r=>r.done));this.jobs.clear();}
}
const owners=new Set<LongformUiFocusGeometryJobsV1>();
export function ownLongformUiFocusGeometryJobsV1(deps:LongformUiFocusGeometryJobDepsV1){const owner=new LongformUiFocusGeometryJobsV1(deps);owners.add(owner);return owner;}
export async function closeLongformUiFocusGeometryJobsV1(){await Promise.all([...owners].map(o=>o.close()));owners.clear();}
