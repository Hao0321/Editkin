import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { LongformUiFocusJobsV1 } from "../application/longformUiFocusJobsV1";
import { closeLongformUiFocusHoldJobsV1 } from "../application/longformUiFocusHoldJobsV1";
import { summarizeLongformUiFocusArtifactV1 } from "../application/longformUiFocusArtifactV1";
import { uiFocusHoldJobFixtureV1 } from "../application/longformUiFocusHoldJobsV1.fixture";
import { confirmLongformUiFocusV1 } from "../application/longformUiFocusV1";
import { colorDigest } from "../application/materialColorSamplingRuntime";
import { registerLongformUiFocusToolsV1 } from "./longformUiFocusToolsV1";
import { registerLongformUiFocusHoldToolsV1, LONGFORM_UI_FOCUS_HOLD_TOOLS_V1 } from "./longformUiFocusHoldToolsV1";
type Response = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Entry = { config: { inputSchema: { parse(raw: unknown): unknown }; annotations: unknown }; handler: (raw: never) => Promise<Response> };
const sources: LongformUiFocusJobsV1[] = []; afterEach(async () => { await closeLongformUiFocusHoldJobsV1(); await Promise.all(sources.splice(0).map(source => source.close())); });
const turn = () => new Promise<void>(done => setImmediate(done));
const value = (response: Response) => JSON.parse(response.content[0].text!);
async function fixture() {
  const f = await uiFocusHoldJobFixtureV1(), entries = new Map<string, Entry>();
  const server = { registerTool: vi.fn((name, config, handler) => entries.set(name, { config, handler })) } as unknown as McpServer;
  const source = new LongformUiFocusJobsV1({ prepare: async () => summarizeLongformUiFocusArtifactV1(f.artifact) }); sources.push(source);
  const read = vi.fn<typeof import("./longformUiFocusFileV1").readCurrentLongformUiFocusFileV1>(async () => f.artifact);
  const confirm = vi.fn<typeof import("./longformUiFocusFileV1").confirmLongformUiFocusFileV1>(async (artifact, ids) => ({
    ...confirmLongformUiFocusV1(artifact.draft, { draftId: artifact.draft.draftId, candidateIds: ids }),
    artifactId: artifact.artifactId, projectRevision: artifact.project.revision, artworkStatus: "ART_PENDING_CLAUDE", selectableByDefault: false,
  }));
  const session = registerLongformUiFocusToolsV1(server, { EDITKIN_WORKSPACE: "D:/owned" }, { jobs: source, read, confirm,
    image: async () => ({ frame: f.frame, data: f.image }) });
  const prepare = vi.fn(async () => f.result), validateCurrent = vi.fn(async () => {});
  const holds = registerLongformUiFocusHoldToolsV1(server, session, { assertOwned: id => source.assertArtifactOwned(id),
    assertViewed: (id, frames) => source.assertFramesReturned(id, frames), confirmations: session.confirmations,
    read: id => read(id, session.runtime), prepare, validateCurrent });
  const call = async (name: string, raw: unknown) => { const entry = entries.get(name)!; return entry.handler(entry.config.inputSchema.parse(raw) as never); };
  await call("start_longform_ui_focus_detection", f.artifact.request); await turn();
  const view = () => call("view_longform_ui_focus_frames", { artifactId: f.artifact.artifactId, frameIds: [f.candidate.frameId] });
  const accept = () => call("confirm_longform_ui_focus_targets", { artifactId: f.artifact.artifactId, candidateIds: [f.candidate.candidateId] });
  return { ...f, source, entries, session, holds, prepare, validateCurrent, read, confirm, call, view, accept };
}
it("adds exactly four bounded hold tools, derives clocks/geometry from the prepared evidence and keeps source/art acceptance pending", async () => {
  const f = await fixture(); expect([...f.entries.keys()].slice(-4)).toEqual([...LONGFORM_UI_FOCUS_HOLD_TOOLS_V1]);
  expect(f.entries.get("start_longform_ui_focus_hold")!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  await f.view(); await f.accept(); const job = value(await f.call("start_longform_ui_focus_hold", f.request)); await turn();
  const ready = value(await f.call("get_longform_ui_focus_hold_job", { jobId: job.jobId }));
  expect(ready).toMatchObject({ state: "COMPLETED", result: { state: "TRACKING_EVIDENCE_READY", focusHintsReady: false, artworkStatus: "ART_PENDING_CLAUDE" } });
  const page = value(await f.call("read_longform_ui_focus_hold_frames", { jobId: job.jobId, offset: 1, limit: 2 }));
  expect(page.items.map((row: { pts: number }) => row.pts)).toEqual([7, 8]); expect(page.nextOffset).toBe(3);
  expect(page.items[0].targetQuad).toEqual(f.result.frames[1].targetQuad); expect(page.semanticIdentityAcrossIntervalVerified).toBe(false);
  expect(value(await f.call("cancel_longform_ui_focus_hold_job", { jobId: job.jobId })).state).toBe("COMPLETED");
});
it("requires a successful source confirmation event, not just returned images or candidate ID knowledge", async () => {
  const f = await fixture(); const before = await f.call("start_longform_ui_focus_hold", f.request);
  expect(value(before).error).toBe("UI_FOCUS_CONFIRM_TARGET_FIRST"); await f.view();
  expect(value(await f.call("start_longform_ui_focus_hold", f.request)).error).toBe("UI_FOCUS_CONFIRM_TARGET_FIRST");
  f.confirm.mockRejectedValueOnce(Error("UI_FOCUS_PROJECT_CHANGED")); expect((await f.accept()).isError).toBe(true);
  expect(value(await f.call("start_longform_ui_focus_hold", f.request)).error).toBe("UI_FOCUS_CONFIRM_TARGET_FIRST"); expect(f.prepare).not.toHaveBeenCalled();
  await f.accept(); const job = value(await f.call("start_longform_ui_focus_hold", f.request)); await turn(); expect((await f.holds.get(job.jobId)).state).toBe("COMPLETED");
});
it("rejects foreign/self-sealed artifact IDs before read and strict schemas reject manual coordinates and excessive pages", async () => {
  const f = await fixture(); f.read.mockClear();
  const response = await f.call("start_longform_ui_focus_hold", { ...f.request, artifactId: "d".repeat(64) });
  expect(response.isError).toBe(true); expect(value(response).error).toContain("THIS_OWNER"); expect(f.read).not.toHaveBeenCalled();
  await expect(f.call("start_longform_ui_focus_hold", { ...f.request, bounds: f.candidate.bounds })).rejects.toThrow();
  await expect(f.call("start_longform_ui_focus_hold", { ...f.request, sourcePath: "D:/manual.mp4" })).rejects.toThrow();
  await expect(f.call("read_longform_ui_focus_hold_frames", { jobId: "uh-" + "a".repeat(24), limit: 65 })).rejects.toThrow();
});
it("keeps BLOCKED visibility evidence blocked and refuses stale source/provider when pages are later requested", async () => {
  const f = await fixture(); await f.view(); await f.accept();
  f.prepare.mockRejectedValueOnce(Error("UI_FOCUS_HOLD_SOURCE_CHANGED")); const failed = value(await f.call("start_longform_ui_focus_hold", f.request)); await turn();
  expect(value(await f.call("get_longform_ui_focus_hold_job", { jobId: failed.jobId }))).toMatchObject({ state: "FAILED", error: "UI_FOCUS_HOLD_SOURCE_CHANGED" });
  const blocked = structuredClone(f.result); blocked.state = "BLOCKED"; blocked.pixelTemplateContinuityVerified = false;
  blocked.flags = ["LOCAL_TARGET_MISSING"]; blocked.frames[12].flags = ["LOCAL_TARGET_MISSING"]; blocked.localObservations[12].state = "missing";
  const { receiptSha256: _hash, ...body } = blocked; blocked.receiptSha256 = colorDigest(body); f.prepare.mockResolvedValueOnce(blocked);
  const ready = value(await f.call("start_longform_ui_focus_hold", f.request)); await turn();
  expect(value(await f.call("get_longform_ui_focus_hold_job", { jobId: ready.jobId }))).toMatchObject({ state: "COMPLETED", result: { state: "BLOCKED", focusHintsReady: false } });
  f.validateCurrent.mockRejectedValue(Error("UI_FOCUS_HOLD_NATIVE_IDENTITY"));
  expect(value(await f.call("read_longform_ui_focus_hold_frames", { jobId: ready.jobId })).error).toBe("UI_FOCUS_HOLD_NATIVE_IDENTITY");
});
