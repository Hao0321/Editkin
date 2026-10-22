import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createProjectSession } from "./projectSession";
import type { MatteTrackArtifactsV1 } from "./matteTrackAnalysisV1";
const observed = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./matteTrackAnalysisV1", () => ({ analyzeMatteTrackV1: observed.verify }));
import { prepareSubjectSheenV1, bakeSubjectSheenV1, type SubjectSheenPreparationV1 } from "./subjectSheenV1";

function fixture() {
  const p = createEmptyProject("Synthetic sheen preparation", { width: 16, height: 16, fps: 24, id: "sheen-unit" });
  p.assets = [{ id: "source", kind: "video", name: "Synthetic graph", uri: "D:/synthetic/source.mp4", duration: 10, width: 16, height: 16, alphaMode: "auto" }];
  p.tracks[0].clips = [{ id: "selected", assetId: "source", trackId: p.tracks[0].id, timelineStart: 2, sourceStart: 0, duration: 1.25, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const request = { schema: "editkin.subject-sheen-request/v1", expectedRevision: 0, clipId: "selected", range: { startFrame: 49, endFrame: 77 },
    style: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 35, bandWidthRatio: .28, intensity: .7 } };
  const artifacts = { analysis: { request: { sourceColor: "rec709-rgb8" } } } as unknown as MatteTrackArtifactsV1;
  const host = { assetBase: process.cwd(), resolveConfirmed: async () => artifacts };
  const runtime = { cacheRoot: "relative-refused-root", ffmpegPath: "D:/synthetic/ffmpeg.exe", ffprobePath: "D:/synthetic/ffprobe.exe" };
  return { p, session: createProjectSession(p), request, artifacts, host, runtime };
}
beforeEach(() => { observed.verify.mockReset(); observed.verify.mockResolvedValue({ measurement: { width: 16, height: 16, alphaBits: 16, fps: 4, frameCount: 5,
  sourceSha256: "1".repeat(64), alphaSha256: "2".repeat(64), subjectConfirmationSha256: "3".repeat(64) } }); });
describe("manual confirmed subject-sheen preparation (canonical verifier doubled only in these units)", () => {
  it("returns explicit clean hold with no verifier/media/output when no confirmed selection exists", async () => {
    const f = fixture(), result = await prepareSubjectSheenV1(f.session, f.request, { assetBase: process.cwd() });
    expect(result).toMatchObject({ state: "clean_hold", reason: "confirmed_subject_required", mutated: false, mediaProcesses: 0, filesWritten: 0 });
    expect(observed.verify).not.toHaveBeenCalled(); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("captures original request and host selection while retaining diagnostic/unapproved state", async () => {
    const f = fixture(), before = JSON.stringify(f.p);
    f.host.resolveConfirmed = async () => { f.request.style.intensity = .1; return f.artifacts; };
    const result = await prepareSubjectSheenV1(f.session, f.request, f.host); expect(result.state).toBe("ready");
    if (result.state !== "ready") throw Error("Expected ready");
    expect(result.style.intensity).toBe(.7); expect(result.matte.alphaBits).toBe(16); expect(result.defaultEnabled).toBe(false); expect(result.directApplyAllowed).toBe(false);
    expect(JSON.stringify(f.p)).toBe(before); expect(observed.verify).toHaveBeenCalledTimes(1); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["aces", "hdr", "straight-alpha", "premultiplied-alpha", "locked", "hidden", "range", "revision", "unknown-style"])("refuses %s without producing a candidate", async reason => {
    const f = fixture();
    if (reason === "aces") f.p.colorManagement!.mode = "aces2";
    if (reason === "hdr") f.p.colorManagement!.outputTransform = "rec2100_pq" as never;
    if (reason === "straight-alpha") f.p.assets[0].alphaMode = "straight"; if (reason === "premultiplied-alpha") f.p.assets[0].alphaMode = "premultiplied";
    if (reason === "locked") f.p.tracks[0].locked = true; if (reason === "hidden") f.p.tracks[0].hidden = true;
    if (reason === "range") f.request.range.endFrame = 79; if (reason === "revision") f.request.expectedRevision = 1;
    if (reason === "unknown-style") Object.assign(f.request.style, { certified: true });
    await expect(prepareSubjectSheenV1(f.session, f.request, f.host)).rejects.toThrow(); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it.each(["same-id-reopen", "in-place", "verifier-change"])("rejects %s across resolver/verifier awaits", async mode => {
    const f = fixture();
    if (mode === "verifier-change") observed.verify.mockImplementation(async () => { f.p.name = "Changed during canonical verification"; return {}; });
    else f.host.resolveConfirmed = async () => { if (mode === "same-id-reopen") f.session.replaceProject(structuredClone(f.p)); else f.p.name = "Changed during selection"; return f.artifacts; };
    await expect(prepareSubjectSheenV1(f.session, f.request, f.host)).rejects.toThrow("PROJECT_CHANGED");
  });
  it("cancels a nonresponsive selection with the exact parent reason", async () => {
    const f = fixture(), c = new AbortController(), reason = Error("sheen-selection-stop");
    const pending = prepareSubjectSheenV1(f.session, f.request, { ...f.host, resolveConfirmed: () => new Promise(() => {}) }, { signal: c.signal });
    setTimeout(() => c.abort(reason), 5); await expect(pending).rejects.toBe(reason);
    await expect(prepareSubjectSheenV1(f.session, f.request, { ...f.host, resolveConfirmed: () => new Promise(() => {}) }, { timeoutMs: 100 })).rejects.toThrow("DEADLINE");
  });
  it.each(["foreign-session", "JSON-copy", "packet-change", "source-change"])("refuses %s before any bake filesystem/tool action", async mode => {
    const f = fixture(), value = await prepareSubjectSheenV1(f.session, f.request, f.host); if (value.state !== "ready") throw Error("Expected ready");
    let packet = value, session = f.session;
    if (mode === "foreign-session") session = createProjectSession(f.p); if (mode === "JSON-copy") packet = structuredClone(value);
    if (mode === "packet-change") packet.style.intensity = .1; if (mode === "source-change") f.p.name = "Changed before bake";
    await expect(bakeSubjectSheenV1(session, packet, f.runtime)).rejects.toThrow(); expect(observed.verify).toHaveBeenCalledTimes(1);
    expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("consumes an accepted bake failure without replaying it and refuses a clean-hold JSON as a capability", async () => {
    const f = fixture(), value = await prepareSubjectSheenV1(f.session, f.request, f.host); if (value.state !== "ready") throw Error("Expected ready");
    await expect(bakeSubjectSheenV1(f.session, value, f.runtime)).rejects.toThrow("ROOT_OR_BYTE_BUDGET");
    await expect(bakeSubjectSheenV1(f.session, value, f.runtime)).rejects.toThrow("USED");
    const hold = await prepareSubjectSheenV1(f.session, f.request, { assetBase: process.cwd() });
    await expect(bakeSubjectSheenV1(f.session, hold as unknown as SubjectSheenPreparationV1, f.runtime)).rejects.toThrow("FOREIGN");
  });
});
