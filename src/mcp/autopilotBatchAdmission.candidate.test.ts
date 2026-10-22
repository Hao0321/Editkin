import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ entered: 0, release: undefined as (() => void) | undefined, held: undefined as Promise<void> | undefined }));
vi.mock("./autopilotTools", async importOriginal => ({
  ...await importOriginal<typeof import("./autopilotTools")>(),
  auditAutopilotPlan: async () => { controls.entered++; await controls.held; throw new Error("controlled audit refusal; no AI or apply"); },
}));
import { registerAutopilotBatchTools } from "./autopilotBatchTools";
import { createProjectFile } from "./storage";

it("registered sync/async MCP tools share the existing four-job owner and do not start a fifth audit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mcp-batch-admission-"));
  const previous = process.env.EDITKIN_WORKSPACE;
  process.env.EDITKIN_WORKSPACE = workspace;
  controls.entered = 0;
  controls.held = new Promise<void>(done => { controls.release = done; });
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>>();
  registerAutopilotBatchTools({ registerTool(name: string, _config: unknown, handler: never) { handlers.set(name, handler); } } as unknown as McpServer);
  const starts: string[] = [];
  const payload = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content.find(item => item.type === "text")!.text!);
  try {
    for (let index = 0; index < 5; index++) {
      await createProjectFile(`${index}/project.editkin.json`, `Admission ${index}`, 1080, 1920, 30);
      await writeFile(join(workspace, `${index}/plan.json`), JSON.stringify({ schema: "controlled-admission-plan" }));
      await writeFile(join(workspace, `${index}/batch.json`), JSON.stringify({ schema: "editkin.autopilot-batch/v1", batchId: `batch-${index}`, expectedDeliverableCount: 1,
        items: [{ id: `item-${index}`, projectPath: `${index}/project.editkin.json`, planPath: `${index}/plan.json`, outputPath: `${index}/result.mp4` }] }));
      if (index < 4) {
        const response = await handlers.get("start_autopilot_batch_job")!({ batchPath: `${index}/batch.json`, through: "apply", preferGpu: false });
        expect(response.isError).not.toBe(true);
        starts.push(payload(response).jobId);
      }
    }
    await vi.waitFor(() => expect(controls.entered).toBe(4));
    const repeated = await handlers.get("run_autopilot_batch")!({ batchPath: "0/batch.json", through: "apply", preferGpu: false });
    expect(repeated.isError).toBe(true);
    expect(JSON.stringify(repeated)).toContain("已有進行中的工作");
    const fifth = await handlers.get("run_autopilot_batch")!({ batchPath: "4/batch.json", through: "apply", preferGpu: false });
    expect(fifth.isError).toBe(true);
    expect(JSON.stringify(fifth)).toContain("上限");
    expect(controls.entered).toBe(4);
    const live = payload(await handlers.get("get_autopilot_batch_job")!({ jobId: starts[0] }));
    expect(live.progress).toMatchObject({ stage: "auditing", activeItemId: "item-0", applied: 0 });
  } finally {
    controls.release!();
    for (const jobId of starts) await vi.waitFor(async () => {
      const state = payload(await handlers.get("get_autopilot_batch_job")!({ jobId }));
      expect(state.finishedAt).toBeDefined();
    });
    if (previous === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previous;
  }
});
