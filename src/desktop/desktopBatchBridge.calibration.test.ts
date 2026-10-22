import { describe, expect, it, vi } from "vitest";
import { engineTaskRequestSchemaV1 } from "../application/engineTaskContractV1";
import { createEngineTaskHostV1 } from "./engineTaskHostV1";
import { autoReframeWorkflowFixtureV1 } from "../application/__fixtures__/autoReframeWorkflowV1.fixture";
import { beginAutoReframeEditV1, autoReframeJobRequestV1 } from "../application/autoReframeEditV1";
describe("calibrated desktop batch bridge",()=>{
  it("known-good existing auto-reframe request still passes",async()=>{
    const project=autoReframeWorkflowFixtureV1(false);
    const job=await beginAutoReframeEditV1(project,"selected",{operationId:"baseline-good-001",mode:"new_portrait_project",outputWidth:90,outputHeight:160,subject:{kind:"saliency"},
      newProject:{id:"portrait",name:"Portrait",createdAt:"2026-10-18T00:00:00.000Z"}});
    expect(engineTaskRequestSchemaV1.safeParse({schema:"editkin.engine-task/v1",kind:"auto_reframe_v1",project,input:autoReframeJobRequestV1(project,job)}).success).toBe(true);
  });
  it("requires the actual typed desktop kind, without a fake v4 project or plan",()=>{
    expect(engineTaskRequestSchemaV1.safeParse({schema:"editkin.engine-task/v1",kind:"desktop_batch_item_v1",input:{operationId:"batch-control-001",sessionId:"batch-123",jobId:"job-001"}}).success).toBe(true);
  });
  it("requires a real host caller for the desktop kind",()=>{
    const api=createEngineTaskHostV1(vi.fn() as never,()=>({}));
    expect(typeof api.runDesktopBatchTaskV1).toBe("function");
  });
});
