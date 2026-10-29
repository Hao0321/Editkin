import { afterEach,expect,it,vi } from "vitest";
import { useBatchAutoEdit } from "./useBatchAutoEdit";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import type { BatchAutoEditSession,HaoDesktopApi } from "./types";
const slots=vi.hoisted(()=>({values:[] as unknown[],index:0}));
vi.mock("react",()=>({useEffect:()=>{},useCallback:(fn:unknown)=>fn,useMemo:(fn:()=>unknown)=>fn(),
  useRef:(initial:unknown)=>{const i=slots.index++;return slots.values[i]??=({current:initial});},
  useState:(initial:unknown)=>{const i=slots.index++;if(!(i in slots.values))slots.values[i]=initial;return[slots.values[i],(next:unknown)=>{slots.values[i]=next;}];}}));
afterEach(()=>{slots.values=[];slots.index=0;});
const session:BatchAutoEditSession={schemaVersion:1,id:"batch-state",editorialProfile:"auto",outputRoot:"D:/controlled/output",createdAt:"2026-10-18",updatedAt:"2026-10-18",
  jobs:["one","two"].map(id=>({id,sourceName:id,sourcePath:`D:/controlled/${id}.mp4`,status:"queued",warnings:[]}))};
function mount(api:HaoDesktopApi){const options={api,projectSession:createProjectSession(createDemoProject()),onOpenProject:()=>{},onStatus:vi.fn()};
  return()=>{slots.index=0;return useBatchAutoEdit(options);};}
it("a cancelled runner with a queued remainder is paused, not still running",async()=>{
  let finish!:(value:{session:BatchAutoEditSession})=>void;const pending=new Promise<{session:BatchAutoEditSession}>(done=>{finish=done;});
  const run=vi.fn(()=>pending);const api={pickBatchMedia:async()=>({canceled:false,session}),runBatchAutoEditItem:run,getBatchSession:async()=>({session})} as unknown as HaoDesktopApi;
  const render=mount(api),active=render().start("auto");await Promise.resolve();await Promise.resolve();expect(render().summary?.running).toBe(true);
  render().cancel();const stopped=structuredClone(session);stopped.jobs[0].status="failed";finish({session:stopped});await active;
  expect(render().summary).toMatchObject({running:false,queued:1,failed:1,total:2});expect(run).toHaveBeenCalledTimes(1);
});
it("an actual native running item still reports active when no local runner owns it",()=>{
  const restored=structuredClone(session);restored.jobs[0].status="running";slots.values=[restored,true];const render=mount({} as HaoDesktopApi);
  expect(render().summary).toMatchObject({running:true,queued:1});
});
it("a persisted queued-only session reports paused and offers the same queue resume entry",()=>{
  slots.values=[session,true];const render=mount({} as HaoDesktopApi);expect(render().summary).toMatchObject({running:false,queued:2});expect(typeof render().resume).toBe("function");
});
