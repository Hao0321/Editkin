import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRenderJobControl, RENDER_CANCELED_MESSAGE } from "./renderJobControl";
import type { RenderProgressSnapshot } from "../render/renderProgress";

const roots: string[] = [];
async function jobFolder() {
  const root = await mkdtemp(join(tmpdir(), "editkin-render-job-"));
  roots.push(root);
  return { root, progressPath: join(root, "progress.json"), cancelPath: join(root, "cancel.request") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const snapshot = (sequence: number, fraction?: number): RenderProgressSnapshot => ({
  schema: "editkin.render-progress/v1", stage: "encode", totalSeconds: 10, ...(fraction === undefined ? {} : { fraction, doneSeconds: fraction * 10 }),
  startedAtMs: 1, stageStartedAtMs: 1, updatedAtMs: 1, sequence,
});

describe("desktop export job files", () => {
  it("does nothing for callers without a job (MCP, CLI, tests)", async () => {
    const control = openRenderJobControl({});
    expect(control.signal).toBeUndefined();
    expect(control.sink).toBeUndefined();
    await control.dispose();
  });

  it("refuses paths that are not the host's job files", () => {
    expect(() => openRenderJobControl({ progressPath: "progress.json" })).toThrow(/invalid/);
    expect(() => openRenderJobControl({ progressPath: join(tmpdir(), "other.json") })).toThrow(/invalid/);
    expect(() => openRenderJobControl({ progressPath: join(tmpdir(), "a", "progress.json"), cancelPath: join(tmpdir(), "b", "cancel.request") }))
      .toThrow(/one folder/);
  });

  it("writes the latest snapshot for the host, throttled, and always the last one", async () => {
    const files = await jobFolder();
    const control = openRenderJobControl(files, { minWriteIntervalMs: 60_000 });
    control.sink!(snapshot(1));
    control.sink!(snapshot(2, .2));
    control.sink!(snapshot(3, .4)); // within the interval: waits for the next write
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(JSON.parse(await readFile(files.progressPath, "utf8")).sequence).toBe(1);
    await control.dispose();
    expect(JSON.parse(await readFile(files.progressPath, "utf8"))).toMatchObject({ sequence: 3, fraction: .4 });
  });

  it("aborts the render when the host writes the cancel request", async () => {
    const files = await jobFolder();
    const control = openRenderJobControl(files, { pollMs: 10 });
    expect(control.signal!.aborted).toBe(false);
    await writeFile(files.cancelPath, "cancel\n");
    for (let attempt = 0; attempt < 100 && !control.signal!.aborted; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    expect(control.signal!.aborted).toBe(true);
    expect((control.signal!.reason as Error).message).toBe(RENDER_CANCELED_MESSAGE);
    await control.dispose();
  });
});
