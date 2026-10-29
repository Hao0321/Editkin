import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { validateProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { decodeProjectBytes, encodeProjectBytes, parseProject, PROJECT_MAX_BYTES } from "./projectCodec";
import { assertBrowserMediaRelink, missingBrowserMedia, readBrowserProjectFile } from "./browserProjectFiles";

function fixture(fps = 30) {
  const project = createDemoProject();
  project.id = "original-persisted-graph";
  project.name = "原創 · 保存與重開";
  project.revision = 7;
  project.fps = fps;
  project.assets[0].duration = 2.017;
  const clip = project.tracks[0].clips[0];
  clip.timelineStart = 61 / fps;
  clip.sourceStart = 0;
  clip.duration = 60 / fps;
  project.motionGraphics = [createMotionGraphic("same-title", "title", "真文字", 3, 2)];
  project.motionScenes = [];
  return validateProject(project);
}

describe("browser file codec and explicit media relink (no browser delivery claim)", () => {
  it.each([30, 30000 / 1001])("roundtrips actual graph IDs/revision/schema and frame precision at %s fps", fps => {
    const original = fixture(fps);
    const before = structuredClone(original);
    const reopened = decodeProjectBytes(encodeProjectBytes(original));
    expect(reopened).toEqual(parseProject(original));
    expect(original).toEqual(before);
    expect(reopened).toMatchObject({ id: original.id, revision: 7, schemaVersion: 9, fps, motionScenes: [] });
    expect(reopened.tracks[0].clips[0]).toMatchObject({ id: "clip-demo", timelineStart: 61 / fps, duration: 60 / fps, sourceStart: 0 });
    expect(reopened.motionGraphics[0].id).toBe("same-title");
  });

  it("reads selected file bytes through the same parser and rejects corrupt UTF-8/JSON/schema", async () => {
    const bytes = encodeProjectBytes(fixture());
    const opened = await readBrowserProjectFile({ size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer });
    expect(opened.id).toBe("original-persisted-graph");
    expect(() => decodeProjectBytes(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => decodeProjectBytes(new TextEncoder().encode("{bad"))).toThrow();
    expect(() => decodeProjectBytes(new TextEncoder().encode(JSON.stringify({ ...fixture(), fps: 0 })))).toThrow();
  });

  it("rejects oversize before reading and a selected-size/actual-byte mismatch", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    await expect(readBrowserProjectFile({ size: PROJECT_MAX_BYTES + 1, arrayBuffer: read })).rejects.toThrow("64 MiB");
    expect(read).not.toHaveBeenCalled();
    await expect(readBrowserProjectFile({ size: 1, arrayBuffer: read })).rejects.toThrow("變動");
  });

  it("keeps older migration semantics and refuses an old schema hiding new scene data", () => {
    const old = { ...fixture(), schemaVersion: 8 };
    delete old.motionScenes;
    expect(parseProject(old).schemaVersion).toBe(9);
    expect(() => parseProject({ ...old, motionScenes: [] })).toThrow("Motion scenes require schema 9");
  });

  it("requires explicit exact asset IDs even for duplicated names and preserves the graph on accepted relink", () => {
    const project = fixture();
    project.assets.push({ ...project.assets[0], id: "duplicate-name" });
    const before = structuredClone(project);
    expect(missingBrowserMedia(project, {} ).map(asset => asset.id)).toEqual(["asset-demo", "duplicate-name"]);
    expect(missingBrowserMedia(project, { "asset-demo": "blob:owned" }).map(asset => asset.id)).toEqual(["duplicate-name"]);
    expect(assertBrowserMediaRelink(project, "duplicate-name", { kind: "video", duration: 2.017, width: 960, height: 540 }).id).toBe("duplicate-name");
    expect(() => assertBrowserMediaRelink(project, project.assets[0].name, { kind: "video", duration: 2.017, width: 960, height: 540 })).toThrow("不存在");
    expect(project).toEqual(before);
  });

  it("rejects wrong kind/dimensions/nonfinite duration and a shorter source even within one-frame metadata tolerance", () => {
    const project = fixture();
    const measured = { kind: "video" as const, duration: 2.017, width: 960, height: 540 };
    for (const delta of [{ kind: "audio" as const }, { width: 1920 }, { height: 0 }, { duration: NaN }, { duration: Infinity }, { duration: 1.99 }]) {
      expect(() => assertBrowserMediaRelink(project, "asset-demo", { ...measured, ...delta })).toThrow();
    }
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { ...measured, duration: 3 })).toThrow("時長");
  });

  it("checks nested composition source ranges and requires an actual pinned source digest", () => {
    const project = fixture();
    const clone = structuredClone(project.tracks);
    clone[0].clips[0].sourceStart = .02;
    project.compositions.push({ ...project, schema: "editkin.composition/v1", id: "nested", name: "nested", duration: 5, tracks: clone });
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { kind: "video", duration: 2.017, width: 960, height: 540 })).toThrow("來源範圍");
    project.compositions = [];
    project.assets[0].derivatives = { sourceSha256: "a".repeat(64), generatedAt: project.updatedAt };
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { kind: "video", duration: 2.017, width: 960, height: 540 })).toThrow("SHA-256");
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { kind: "video", duration: 2.017, width: 960, height: 540, sourceSha256: "b".repeat(64) })).toThrow("SHA-256");
    expect(assertBrowserMediaRelink(project, "asset-demo", { kind: "video", duration: 2.017, width: 960, height: 540, sourceSha256: "a".repeat(64) }).id).toBe("asset-demo");
  });

  it("treats image timing as authored static duration, checks actual dimensions, and blocks sequence relink", () => {
    const project = fixture();
    project.assets[0].kind = "image";
    const before = structuredClone(project);
    expect(assertBrowserMediaRelink(project, "asset-demo", { kind: "image", width: 960, height: 540 }).duration).toBe(2.017);
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { kind: "image", width: 640, height: 360 })).toThrow("尺寸");
    expect(project).toEqual(before);
    project.assets[0].imageSequence = { schema: "editkin.openexr-sequence/v1", format: "openexr", frameCount: 60, startFrame: 0, lastFrame: 59,
      timebase: { numerator: 30, denominator: 1 }, sequenceSha256: "a".repeat(64), manifestSha256: "b".repeat(64), previewUri: "sequence-preview" };
    expect(() => assertBrowserMediaRelink(project, "asset-demo", { kind: "image", width: 960, height: 540 })).toThrow("OpenEXR");
  });
});
