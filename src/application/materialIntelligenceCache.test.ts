import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareMaterialIntelligence, readMaterialIntelligence } from "./materialIntelligence";

// Source/cache bytes are real. Probe is a labelled audio fixture, not a decoder test.
vi.mock("./inspectMedia", () => ({ inspectMedia: vi.fn(async () => ({ duration: 3, hasAudio: true, hasVideo: false })) }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-material-cache-")); roots.push(root);
  const sourcePath = join(root, "source.wav"); await writeFile(sourcePath, "original source bytes");
  return {
    root,
    request: { assetId: "asset-a", clipId: "clip-a", sourcePath, sourceSha256: sha("original source bytes"), sourceStart: 0, duration: 3, fps: 30, kind: "audio" as const, includeTranscript: false },
    runtime: { ffmpegPath: process.execPath, modelRoot: root, cacheRoot: root },
  };
}
it("rejects a supplied stale source digest before returning cached evidence", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  await writeFile(request.sourcePath, "different source bytes");
  await expect(prepareMaterialIntelligence(request, runtime)).rejects.toThrow(/SHA|來源|source/i);
  expect((await readMaterialIntelligence(runtime.cacheRoot, first.packet.materialId)).source.sourceSha256).toBe(request.sourceSha256);
});
it("preserves a corrupt completed manifest and fails closed on warm/read", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  const path = join(runtime.cacheRoot, "material-intelligence", first.packet.materialId, "manifest.json");
  const corrupt = { ...first.packet, source: { ...first.packet.source, duration: 2 } };
  const bytes = JSON.stringify(corrupt); await writeFile(path, bytes);
  await expect(prepareMaterialIntelligence(request, runtime)).rejects.toThrow(/完整性|integrity|cache/i);
  await expect(readMaterialIntelligence(runtime.cacheRoot, first.packet.materialId)).rejects.toThrow(/完整性|integrity|cache/i);
  expect(await readFile(path, "utf8")).toBe(bytes);
});
it("does not reuse another clip's IDs for the same source window", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  const next = await prepareMaterialIntelligence({ ...request, assetId: "asset-b", clipId: "clip-b" }, runtime);
  expect(next.packet.materialId).not.toBe(first.packet.materialId);
  expect(next.packet.source).toMatchObject({ assetId: "asset-b", clipId: "clip-b" });
});
it("invalidates changed colour interpretation without replacing earlier evidence", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence({ ...request, color: { interpretation: "rec709" } }, runtime);
  const path = join(runtime.cacheRoot, "material-intelligence", first.packet.materialId, "manifest.json");
  const bytes = await readFile(path, "utf8");
  const next = await prepareMaterialIntelligence({ ...request, color: { interpretation: "hlg" } }, runtime);
  expect(next.packet.materialId).not.toBe(first.packet.materialId);
  expect(await readFile(path, "utf8")).toBe(bytes);
});
it("retains byte-equal cold/warm observations and audio-only applicability", async () => {
  const { request, runtime } = await fixture();
  const first = await prepareMaterialIntelligence(request, runtime);
  const warm = await prepareMaterialIntelligence(request, runtime);
  expect(first.cacheHit).toBe(false); expect(warm.cacheHit).toBe(true);
  expect(warm.packet).toEqual(first.packet);
  expect(warm.packet.analysis.color?.status).toBe("not_applicable");
});
it("concurrent preparations publish one verified complete cache and preserve byte-equal receipts", async () => {
  const { request, runtime } = await fixture();
  const results = await Promise.all([prepareMaterialIntelligence(request, runtime), prepareMaterialIntelligence(request, runtime)]);
  expect(results[0].packet).toEqual(results[1].packet);
  expect(results.filter(result => !result.cacheHit)).toHaveLength(1);
  expect((await readMaterialIntelligence(runtime.cacheRoot, results[0].packet.materialId))).toEqual(results[0].packet);
});
