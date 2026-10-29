import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { LongformUiFocusJobsV1 } from "../application/longformUiFocusJobsV1";
import { uiFocusFileFixtureV1 } from "../application/longformUiFocusFileV1.fixture";
import { summarizeLongformUiFocusArtifactV1 } from "../application/longformUiFocusArtifactV1";
import { confirmLongformUiFocusV1 } from "../application/longformUiFocusV1";
import { assembleLongformUiFocusDraftV1 } from "../application/longformUiFocusV1";
import { registerLongformUiFocusToolsV1, LONGFORM_UI_FOCUS_TOOLS_V1, LONGFORM_UI_FOCUS_RESPONSE_BYTES_V1,
  type LongformUiFocusToolDepsV1 } from "./longformUiFocusToolsV1";

type Response = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
type Registration = { config: { inputSchema: { parse(value: unknown): unknown }; annotations: unknown };
  handler: (input: never) => Promise<Response> };
const owners: LongformUiFocusJobsV1[] = []; afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture() {
  const f = uiFocusFileFixtureV1("D:/owned", "D:/owned/source.mp4"), registered = new Map<string, Registration>();
  const server = { registerTool: vi.fn((name, config, handler) => registered.set(name, { config, handler })) } as unknown as McpServer;
  const jobs = new LongformUiFocusJobsV1({ prepare: async () => summarizeLongformUiFocusArtifactV1(f.artifact) }); owners.push(jobs);
  const read = vi.fn<typeof import("./longformUiFocusFileV1").readCurrentLongformUiFocusFileV1>(async () => f.artifact);
  const confirm = vi.fn<typeof import("./longformUiFocusFileV1").confirmLongformUiFocusFileV1>(async (artifact, ids) => ({
    ...confirmLongformUiFocusV1(artifact.draft, { draftId: artifact.draft.draftId, candidateIds: ids }),
    artifactId: artifact.artifactId, projectRevision: artifact.project.revision, artworkStatus: "ART_PENDING_CLAUDE", selectableByDefault: false,
  }));
  const image = vi.fn<typeof import("../application/longformUiFocusArtifactV1").readLongformUiFocusImageV1>(async () => ({ frame: f.frame, data: f.image }));
  const deps: LongformUiFocusToolDepsV1 = { jobs, read, confirm, image };
  registerLongformUiFocusToolsV1(server, { EDITKIN_WORKSPACE: "D:/owned", EDITKIN_CACHE_ROOT: "D:/owned/cache" }, deps);
  const call = async (name: string, input: unknown) => { const entry = registered.get(name)!; return entry.handler(entry.config.inputSchema.parse(input) as never); };
  const started = jobs.start(f.request); await turn();
  return { ...f, registered, jobs, deps, read, confirm, imageMock: image, call, started };
}
const value = (response: Response) => JSON.parse(response.content[0].text!);
it("registers the explicit six-tool source surface and returns bounded pages with unchanged candidate geometry", async () => {
  const f = await fixture(); expect([...f.registered.keys()]).toEqual([...LONGFORM_UI_FOCUS_TOOLS_V1]);
  const page = value(await f.call("read_longform_ui_focus_candidates", { artifactId: f.artifact.artifactId, offset: 1, limit: 1 }));
  expect(page.items).toEqual([f.draft.candidates[1]]); expect(page.nextOffset).toBe(2); expect(page.focusHintsReady).toBe(false);
  expect(page.projectModified).toBe(false); expect(page.targetMatches[0].state).toBe("ONE_MATCH_REQUIRES_CONFIRMATION");
  expect(f.registered.get("confirm_longform_ui_focus_targets")!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(value(await f.call("get_longform_ui_focus_job", { jobId: f.started.jobId })).state).toBe("COMPLETED");
  expect(value(await f.call("cancel_longform_ui_focus_job", { jobId: f.started.jobId })).state).toBe("COMPLETED");
  expect(value(await f.call("start_longform_ui_focus_detection", f.request)).state).toBe("RUNNING");
});
it("requires returned source images before ID confirmation; image return alone does not certify a hint", async () => {
  const f = await fixture(), input = { artifactId: f.artifact.artifactId, candidateIds: [f.draft.candidates[0].candidateId] };
  const blocked = await f.call("confirm_longform_ui_focus_targets", input); expect(blocked.isError).toBe(true);
  expect(value(blocked).error).toBe("UI_FOCUS_VIEW_SOURCE_FRAMES_FIRST"); expect(f.confirm).not.toHaveBeenCalled();
  const image = await f.call("view_longform_ui_focus_frames", { artifactId: f.artifact.artifactId, frameIds: [f.frame.id] });
  expect(image.content[1]).toMatchObject({ type: "image", data: f.image.toString("base64"), mimeType: "image/jpeg" });
  const confirmed = value(await f.call("confirm_longform_ui_focus_targets", input));
  expect(confirmed).toMatchObject({ focusHintsReady: false, projectModified: false, artworkStatus: "ART_PENDING_CLAUDE" });
});
it("blocks even well-formed foreign artifact IDs before filesystem ingress", async () => {
  const f = await fixture(), foreign = "c".repeat(64);
  for (const [name, fields] of [
    ["read_longform_ui_focus_candidates", {}], ["view_longform_ui_focus_frames", { frameIds: [f.frame.id] }],
    ["confirm_longform_ui_focus_targets", { candidateIds: [f.draft.candidates[0].candidateId] }],
  ] as const) {
    const response = await f.call(name, { artifactId: foreign, ...fields }); expect(response.isError).toBe(true); expect(value(response).error).toContain("THIS_OWNER");
  }
  expect(f.read).not.toHaveBeenCalled();
});
it("strict schemas refuse caller boxes, excessive pages and duplicate source frame requests", async () => {
  const f = await fixture(), artifactId = f.artifact.artifactId;
  await expect(f.call("start_longform_ui_focus_detection", { ...f.request, bounds: {} })).rejects.toThrow();
  await expect(f.call("confirm_longform_ui_focus_targets", { artifactId, candidateIds: [f.draft.candidates[0].candidateId], bounds: {} })).rejects.toThrow();
  await expect(f.call("read_longform_ui_focus_candidates", { artifactId, limit: 101 })).rejects.toThrow();
  await expect(f.call("view_longform_ui_focus_frames", { artifactId, frameIds: [f.frame.id, f.frame.id] })).rejects.toThrow();
  const unknown = await f.call("read_longform_ui_focus_candidates", { artifactId, frameId: "focus-frame-12" });
  expect(value(unknown).error).toBe("UI_FOCUS_FRAME_NOT_FOUND");
});
it("rechecks ownership after asynchronous read and propagates current-source drift", async () => {
  const f = await fixture(); f.read.mockImplementationOnce(async () => { await f.jobs.close(); return f.artifact; });
  const closed = await f.call("read_longform_ui_focus_candidates", { artifactId: f.artifact.artifactId });
  expect(value(closed).error).toContain("THIS_OWNER");
  const other = await fixture(); other.read.mockRejectedValueOnce(Error("UI_FOCUS_SOURCE_CHANGED"));
  expect(value(await other.call("read_longform_ui_focus_candidates", { artifactId: other.artifact.artifactId })).error).toBe("UI_FOCUS_SOURCE_CHANGED");
});
it("bounds text/image output and does not grant frame access after an oversized or failed image response", async () => {
  const f = await fixture(), artifactId = f.artifact.artifactId;
  // A schema-valid OCR observation can still exceed the public page budget:
  // sixteen lines, each two maximum-length Chinese words, exactly 65,536
  // observation characters. Geometry remains independently source-derived.
  const text = "字".repeat(1024);
  f.frame.ocr.result.lines = Array.from({ length: 16 }, (_, index) => ({ index, text: text + text,
    words: [0, 1].map(index => ({ index, text, x: 100 + index * 80, y: 100, width: 60, height: 30 })) }));
  f.reseal();
  const draft = assembleLongformUiFocusDraftV1(f.source, [f.frame], [], f.request.targetTexts);
  f.read.mockResolvedValueOnce({ ...f.artifact, draft });
  expect(value(await f.call("read_longform_ui_focus_candidates", { artifactId })).error).toContain("RESPONSE_BUDGET");
  f.imageMock.mockResolvedValueOnce({ frame: f.frame, data: Buffer.alloc(2 * 1024 * 1024 + 1) });
  expect(value(await f.call("view_longform_ui_focus_frames", { artifactId, frameIds: [f.frame.id] })).error).toContain("IMAGE_RESPONSE_BUDGET");
  expect(() => f.jobs.assertFramesReturned(artifactId, [f.frame.id])).toThrow("VIEW_SOURCE");
  f.imageMock.mockRejectedValueOnce(Error("UI_FOCUS_IMAGE_INTEGRITY"));
  expect(value(await f.call("view_longform_ui_focus_frames", { artifactId, frameIds: [f.frame.id] })).error).toBe("UI_FOCUS_IMAGE_INTEGRITY");
  expect(() => f.jobs.assertFramesReturned(artifactId, [f.frame.id])).toThrow("VIEW_SOURCE");
});
