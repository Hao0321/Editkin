import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMedia } from "./inspectMedia";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-exr-sequence-"));
  roots.push(root);
  const first = Buffer.from("762f310100000000", "hex");
  const last = Buffer.from("762f310101020304", "hex");
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  await writeFile(join(root, "frame-00000007.exr"), first);
  await writeFile(join(root, "frame-00000008.exr"), last);
  await writeFile(join(root, "preview.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const manifest = {
    schema: "editkin.openexr-sequence/v1", status: "GREEN", workingColorSpace: "linear_rec709", artifactFormat: "rgba32_float", artifactContainer: "openexr", alphaMode: "straight",
    timebase: { numerator: 1, denominator: 30 }, startFrame: 7, frameCount: 2, lastFrame: 8,
    filePattern: "frame-%08d.exr", previewFile: "preview.png", width: 40, height: 24,
    sequenceSha256: "a".repeat(64), firstFrameSha256: hash(first), lastFrameSha256: hash(last),
  };
  const path = join(root, "editkin-openexr-sequence.json");
  await writeFile(path, JSON.stringify(manifest));
  return { path, manifest };
}

describe("inspectMedia OpenEXR sequences", () => {
  it("recognizes a complete scene-linear sequence as one timed image asset", async () => {
    const { path } = await fixture();
    const result = await inspectMedia(path);
    expect(result).toMatchObject({ duration: 2 / 30, width: 40, height: 24, hasVideo: true, hasAudio: false });
    expect(result.imageSequence).toMatchObject({ frameCount: 2, startFrame: 7, lastFrame: 8, format: "openexr" });
    expect(result.imageSequence?.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.previewPath).toMatch(/preview\.png$/);
  });

  it("rejects incomplete sequence manifests instead of importing a still", async () => {
    const { path, manifest } = await fixture();
    await writeFile(path, JSON.stringify({ ...manifest, frameCount: 3, lastFrame: 9 }));
    await expect(inspectMedia(path)).rejects.toThrow(/不完整/);
  });
});
