import { describe, expect, it, vi } from "vitest";
import { createAutoReframeAppHostV1 } from "./autoReframeAppHostV1";
import { createProjectSession } from "./projectSession";
import { autoReframeWorkflowFixtureV1 } from "./__fixtures__/autoReframeWorkflowV1.fixture";
function fixture(dirty=false) {
  const source=autoReframeWorkflowFixtureV1(false), session=createProjectSession(source,"original.json");
  if(dirty) session.replaceProject(source,"original.json",{dirty:true});
  const confirmLeave=vi.fn(()=>true), openNew=vi.fn((next:typeof source)=>session.replaceProject(next,undefined,{dirty:true}));
  const host=createAutoReframeAppHostV1({session,confirmLeave,openNew});
  const next=structuredClone(source); next.id="portrait-new"; next.width=90; next.height=160;
  const request={baseProject:next,command:{type:"batch" as const,commands:[{type:"rename_project" as const,name:"Portrait output"}]},expectedSourceId:source.id,expectedSourceRevision:source.revision};
  return {source,session,confirmLeave,openNew,host,request};
}
describe("reframe uses the current document owner",()=>{
  it("opens a dirty separate project and leaves source bytes and path unchanged",()=>{
    const f=fixture(), before=JSON.stringify(f.source); expect(f.host(f.request).status).toBe("created");
    expect(JSON.stringify(f.source)).toBe(before); const s=f.session.getSnapshot(); expect(s.dirty).toBe(true); expect(s.projectPath).toBeUndefined(); expect(s.history.present.name).toBe("Portrait output");
    expect(f.confirmLeave).not.toHaveBeenCalled();
  });
  it("retains dirty source if the user cancels the existing leave-document confirmation",()=>{
    const f=fixture(true); f.confirmLeave.mockReturnValue(false); expect(f.host(f.request).status).toBe("cancelled");
    expect(f.openNew).not.toHaveBeenCalled(); expect(f.session.getSnapshot().projectPath).toBe("original.json");
  });
  it("rejects a project switch during confirmation",()=>{
    const f=fixture(true); f.confirmLeave.mockImplementation(()=>{f.session.replaceProject(f.source);return true;});
    expect(()=>f.host(f.request)).toThrow("AUTO_REFRAME_JOB_STALE"); expect(f.openNew).not.toHaveBeenCalled();
  });
  it("refuses a pending save, stale revision and a reused document identity",()=>{
    const f=fixture(); f.request.expectedSourceRevision++; expect(()=>f.host(f.request)).toThrow("STALE");
    f.request.expectedSourceRevision--; f.request.baseProject.id=f.source.id; expect(()=>f.host(f.request)).toThrow("IDENTITY");
    f.session.beginSave(); expect(f.host(f.request).status).toBe("cancelled"); expect(f.openNew).not.toHaveBeenCalled();
  });
});
