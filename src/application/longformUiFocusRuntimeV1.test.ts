import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { colorBytesSha, colorDigest } from "./materialColorSamplingRuntime";
import { uiFocusFixtureV1 } from "./longformUiFocusV1.fixture";
import { detectLongformUiFocusV1 } from "./longformUiFocusRuntimeV1";

const io = vi.hoisted(() => ({ extract: vi.fn(), ocr: vi.fn(), identity: vi.fn() }));
vi.mock("./materialKeyframeExtraction", async original => ({ ...await original<typeof import("./materialKeyframeExtraction")>(), extractMaterialKeyframes: io.extract }));
vi.mock("./materialColorSamplingRuntime", async original => ({ ...await original<typeof import("./materialColorSamplingRuntime")>(), getMaterialColorRuntimeIdentity: io.identity }));
vi.mock("./windowsOcrRuntimeV1", async original => ({ ...await original<typeof import("./windowsOcrRuntimeV1")>(), recognizeWindowsOcrV1: io.ocr }));
const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { for (const root of roots.splice(0)) { await unlink(join(root, "source.mp4")); await rmdir(root); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uif-io-test-")); roots.push(root);
  await writeFile(join(root, "source.mp4"), "owned protocol-control source, not decodable footage");
  const f = uiFocusFixtureV1(), sourceSha = colorBytesSha(Buffer.from("owned protocol-control source, not decodable footage"));
  f.frame.display.source.sha256 = sourceSha; f.reseal();
  const identity = { schema: "editkin.material-color-runtime/v1", status: "verified", tools: [], implementations: [], identitySha256: "a".repeat(64) };
  io.identity.mockResolvedValue(identity);
  const analysis = { schema: "editkin.material-keyframe-analysis/v1", state: "ready", policy: "neutral-srgb-display-v1",
    runtimeIdentitySha256: identity.identitySha256, requestedSamples: [f.frame.display.requested], omitted: [] };
  const extracted = { analysis, frames: [{ id: f.frame.id, time: .15, sceneIndex: 0, display: f.frame.display, data: f.image }] };
  io.extract.mockResolvedValue(extracted); io.ocr.mockResolvedValue(f.frame.ocr);
  const request = { schema: "editkin.longform-ui-focus-request/v1", recordingId: "screen", sourcePath: "source.mp4",
    expectedSourceSha256: sourceSha, sourceStart: .05, duration: 1, language: "zh-Hant-TW", frameTimes: [.1] };
  const runtime = { sourceRoot: root, workRoot: root, ffmpegPath: join(root, "trusted-ffmpeg-control.exe") };
  return { root, f, request, runtime, identity, extracted };
}
it("decodes source bytes directly and sends actual returned JPEG/dimensions to the detector, not caller boxes or cache", async () => {
  const f = await fixture(), result = await detectLongformUiFocusV1(f.request, f.runtime);
  expect(io.extract).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: join(f.root, "source.mp4"), sourceSha256: f.request.expectedSourceSha256,
    sourceStart: .05, samples: [{ id: "focus-frame-1", time: .1, sceneIndex: 0 }] }), f.runtime, f.identity);
  expect(io.ocr).toHaveBeenCalledWith(f.f.image, { imageSha256: f.f.frame.display.jpeg.sha256, width: 960, height: 640, language: "zh-Hant-TW" }, f.runtime);
  expect(result.frames[0].display.decoded.relativeTime).toBe(.15); expect(result.projectModified).toBe(false);
});
it("refuses stale source identity before extraction and source mutation during OCR", async () => {
  const f = await fixture();
  await expect(detectLongformUiFocusV1({ ...f.request, expectedSourceSha256: "b".repeat(64) }, f.runtime)).rejects.toThrow("SOURCE_CHANGED");
  expect(io.extract).not.toHaveBeenCalled();
  io.ocr.mockImplementationOnce(async () => { await writeFile(join(f.root, "source.mp4"), "changed"); return f.f.frame.ocr; });
  await expect(detectLongformUiFocusV1(f.request, f.runtime)).rejects.toThrow("SOURCE_CHANGED");
});
it("checks canonical source boundary rather than accepting an absolute outside path", async () => {
  const f = await fixture(), outside = await fixture();
  await expect(detectLongformUiFocusV1({ ...f.request, sourcePath: join(outside.root, "source.mp4") }, f.runtime)).rejects.toThrow("BOUNDARY");
  expect(io.extract).not.toHaveBeenCalled();
});
it("does not convert failed OCR or zero decoded frames into a successful empty draft", async () => {
  const f = await fixture(); io.ocr.mockRejectedValueOnce(Error("OCR_LANGUAGE_NOT_INSTALLED"));
  await expect(detectLongformUiFocusV1(f.request, f.runtime)).rejects.toThrow("OCR_LANGUAGE_NOT_INSTALLED");
  io.extract.mockResolvedValueOnce({ analysis: { ...f.extracted.analysis, state: "blocked", omitted: [{ id: "focus-frame-1", reason: "unknown-color" }] }, frames: [] });
  await expect(detectLongformUiFocusV1(f.request, f.runtime)).rejects.toThrow("DECODE_BLOCKED:unknown-color");
});
it("propagates cancellation before admission and immediately after extraction", async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await expect(detectLongformUiFocusV1(f.request, { ...f.runtime, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(io.extract).not.toHaveBeenCalled();
  const active = new AbortController(); io.extract.mockImplementationOnce(async () => { active.abort(); return f.extracted; });
  await expect(detectLongformUiFocusV1(f.request, { ...f.runtime, signal: active.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(io.ocr).not.toHaveBeenCalled();
});
it("rejects decode identity drift and resealed OCR with a different image", async () => {
  const f = await fixture(); io.identity.mockResolvedValueOnce(f.identity).mockResolvedValueOnce({ ...f.identity, identitySha256: "b".repeat(64) });
  await expect(detectLongformUiFocusV1(f.request, f.runtime)).rejects.toThrow("RUNTIME_CHANGED");
  const bad = structuredClone(f.f.frame.ocr); bad.imageSha256 = "b".repeat(64); bad.receiptSha256 = colorDigest({ ...bad, receiptSha256: undefined }); io.ocr.mockResolvedValueOnce(bad);
  await expect(detectLongformUiFocusV1(f.request, f.runtime)).rejects.toThrow("OCR_FRAME_BINDING");
});
it("an evidence sink receives isolated image/receipt copies and cannot modify detector coordinates", async () => {
  const f = await fixture();
  const d = await detectLongformUiFocusV1(f.request, { ...f.runtime, onFrame: frame => {
    frame.data[0] = 0; frame.ocr.result.lines[0].words[0].x = 800; frame.display.decoded.relativeTime = .99;
  } });
  expect(f.f.image[0]).toBe(255); expect(d.frames[0].display.decoded.relativeTime).toBe(.15);
  expect(d.frames[0].ocr.result.lines[0].words[0].x).toBe(100);
});
