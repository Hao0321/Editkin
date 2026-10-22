import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { openFileJobControlV1, openRenderJobControl, RENDER_CANCELED_MESSAGE } from "./renderJobControl";
import type { RenderProgressSnapshot } from "../render/renderProgress";
const temp = resolve(process.env.TEMP!), roots: string[] = [];
async function folder() { const p = await mkdtemp(join(temp, "engine-file-control-")); roots.push(p); return p; }
afterEach(async () => { for (const p of roots.splice(0)) { if (!p.startsWith(temp + sep)) throw Error("outside owned temp"); await rm(p, { recursive: true }); } });
describe("one file job lifetime for export and engine analysis", () => {
  it("keeps the old export wrapper's progress bytes identical to the generic control", async () => {
    const a = await folder(), b = await folder(), old = openRenderJobControl({ progressPath: join(a, "progress.json") }, { minWriteIntervalMs: 60000 });
    const shared = openFileJobControlV1<RenderProgressSnapshot>({ progressPath: join(b, "progress.json") }, { minWriteIntervalMs: 60000 });
    for (let sequence = 1; sequence <= 3; sequence++) {
      const r: RenderProgressSnapshot = { schema: "editkin.render-progress/v1", stage: "encode", startedAtMs: 1, stageStartedAtMs: 1, updatedAtMs: 1, sequence, fraction: sequence / 10 }; old.sink!(r); shared.sink!(r);
    }
    await old.dispose(); await shared.dispose(); expect(await readFile(join(a, "progress.json"))).toEqual(await readFile(join(b, "progress.json")));
  });
  it.each([undefined, "ENGINE_TASK_CANCELLED"])("uses the chosen cancel reason %s without changing the legacy default", async cancelMessage => {
    const root = await folder(), c = openFileJobControlV1({ cancelPath: join(root, "cancel.request") }, { cancelMessage, pollMs: 5 });
    await writeFile(join(root, "cancel.request"), "cancel\n"); for (let n = 0; n < 100 && !c.signal!.aborted; n++) await new Promise(r => setTimeout(r, 5));
    expect(c.signal!.aborted).toBe(true); expect(c.signal!.reason.message).toBe(cancelMessage ?? RENDER_CANCELED_MESSAGE); await c.dispose();
  });
  it("flushes typed engine progress exactly and never deletes the host's files", async () => {
    const root = await folder(), progressPath = join(root, "progress.json"), c = openFileJobControlV1<{ schema: string; completed: number }>({ progressPath }, { minWriteIntervalMs: 60000 });
    c.sink!({ schema: "engine-test", completed: 1 }); c.sink!({ schema: "engine-test", completed: 5 }); await c.dispose();
    expect(JSON.parse(await readFile(progressPath, "utf8"))).toEqual({ schema: "engine-test", completed: 5 });
  });
});
