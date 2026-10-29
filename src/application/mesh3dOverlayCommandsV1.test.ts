import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo, redo } from "../domain/history";
import { editorCommandSchema } from "../domain/schema";
import { prepareMesh3dOverlaysV1 } from "./mesh3dOverlayCommandsV1";
import { readProjectFile, writeProjectFileAtomic } from "./projectFiles";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { renderMesh3dVideo } from "../render/mesh3dRender";
import type { Mesh3dOverlaysV1 } from "../motion/mesh3dOverlayV1";

function fixture() {
  const p = createEmptyProject("overlay", { width: 160, height: 90, fps: 10 });
  p.assets.push({ id: "image", name: "owned", kind: "image", uri: "D:/owned.png", duration: 1.5, color: { interpretation: "rec709" } });
  p.tracks[0].clips.push({ id: "art", assetId: "image", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: .5, duration: 1,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  p.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: "#FFFFFF", gridColor: "#000000", grid: false, spacing: 72 }, light: { direction: [0, 0, 1], ambient: .5, intensity: .5 },
    segments: [0, .5].map((time, i) => ({ id: `s${i}`, name: "shot", timelineStart: time, duration: .5,
      camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 55, near: .1, far: 30 }, cameraKeyframes: [],
      objects: [{ id: "hero", name: "hero", geometry: { kind: "box", width: 1, height: 1, depth: 1 }, material: { color: "#203040", unlit: true },
        pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }] })) };
  const bindings: Mesh3dOverlaysV1 = { schema: "editkin.mesh-overlays/v1",
    anchors: p.scene3d.segments.map(s => ({ id: s.id, segmentId: s.id, objectId: "hero", localPoint: [0, 0, .5] })),
    layers: p.scene3d.segments.map(s => ({ id: s.id, anchorId: s.id, clipId: "art", size: [.4, .4], offset: [0, 0], pivot: [.5, .5], opacity: 1, occlusion: "always_front" })) };
  return { p, bindings };
}
describe("saved hybrid bindings use ordinary project commands", () => {
  it("adds a new imported overlay source and its binding atomically from a valid existing project", () => {
    const { p, bindings } = fixture(); p.tracks[0].clips = []; validateProject(p);
    const prepared = prepareMesh3dOverlaysV1(p, bindings, [{ clipId: "art", assetId: "image", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1 }]);
    expect(prepared.commands).toHaveLength(1); expect(prepared.commands[0].type).toBe("batch"); expect(p.tracks[0].clips).toHaveLength(0);
    const history = dispatchCommand(createHistory(p), editorCommandSchema.parse(prepared.commands[0]));
    expect(history.past).toHaveLength(1); expect(history.present.tracks[0].clips[0].id).toBe("art");
    expect(undo(history).present).toEqual(p);
    p.tracks[0].locked = true; expect(() => prepareMesh3dOverlaysV1(p, bindings, [{ clipId: "art", assetId: "image", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1 }])).toThrow("鎖定");
  });
  it("prepares without mutation, commits once, saves/reopens identical pixels, and undoes/redoes", async () => {
    const { p, bindings } = fixture(), before = JSON.stringify(p), prepared = prepareMesh3dOverlaysV1(p, bindings);
    expect(JSON.stringify(p)).toBe(before); expect(prepared.status).toBe("PREPARED_NOT_APPLIED");
    const history = dispatchCommand(createHistory(p), editorCommandSchema.parse(prepared.commands[0]));
    expect(history.past).toHaveLength(1); expect(undo(history).present).toEqual(p); expect(redo(undo(history)).present).toEqual(history.present);
    const root = await mkdtemp(join(tmpdir(), "mesh-overlay-save-")), path = join(root, "saved.editkin.json");
    await writeProjectFileAtomic(path, history.present, 0, { createOnly: true });
    const reopened = await readProjectFile(path); expect(reopened.scene3d).toEqual(history.present.scene3d);
    const textures = new Map([["art", { width: 1, height: 1, rgba: new Uint8Array([0, 255, 0, 128]) }]]);
    const render = (scene: typeof p.scene3d) => renderMesh3dProjectFrameV1(scene!, { timelineFrame: 5, fps: 10 }, 160, 90, new Mesh3dGeometryCache(), textures);
    expect(render(reopened.scene3d).rgba).toEqual(render(history.present.scene3d).rgba);
  });
  it("enforces old and new source locks on attach, edit and removal, including atomic batch failure", () => {
    const { p, bindings } = fixture(), command = prepareMesh3dOverlaysV1(p, bindings).commands[0];
    p.tracks[0].locked = true;
    expect(() => prepareMesh3dOverlaysV1(p, bindings)).toThrow("鎖定");
    const history = createHistory(p), result = dispatchCommandSafely(history, { type: "batch", commands: [command] });
    expect(result.state).toBe(history); expect(result.error).toContain("鎖定");
    p.tracks[0].locked = false; const applied = dispatchCommand(history, command).present; applied.tracks[0].locked = true;
    expect(dispatchCommandSafely(createHistory(applied), { type: "set_mesh_3d_scene" }).error).toContain("鎖定");
  });
  it("rejects dangling, hidden, truncated and unsupported processed sources", () => {
    const { p, bindings } = fixture();
    const invalid = structuredClone(bindings); invalid.layers[0].anchorId = "missing";
    expect(() => prepareMesh3dOverlaysV1(p, invalid)).toThrow("附著點");
    p.tracks[0].hidden = true; expect(() => prepareMesh3dOverlaysV1(p, bindings)).toThrow("可見"); delete p.tracks[0].hidden;
    p.tracks[0].clips[0].duration = .4; expect(() => prepareMesh3dOverlaysV1(p, bindings)).toThrow("完整覆蓋");
    p.tracks[0].clips[0].duration = 1; p.tracks[0].clips[0].speed = 2;
    expect(() => prepareMesh3dOverlaysV1(p, bindings)).toThrow();
    delete p.tracks[0].clips[0].speed;
    p.tracks[0].clips[0].color.hue = 1; expect(() => prepareMesh3dOverlaysV1(p, bindings)).toThrow("物化");
    p.tracks[0].clips[0].color.hue = 0; p.tracks[0].muted = true; p.tracks[0].clips[0].transform.flipX = false;
    expect(() => prepareMesh3dOverlaysV1(p, bindings)).not.toThrow();
  });
  it("really decodes alpha video at source offsets across a cut and encodes the composed frames", async () => {
    const { p, bindings } = fixture(), root = await mkdtemp(join(tmpdir(), "mesh-overlay-encode-"));
    const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
    const raw = new Uint8Array(64 * 36 * 4 * 15);
    for (let f = 0; f < 15; f++) for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
      const q = ((f * 36 + y) * 64 + x) * 4; raw[q + Math.floor(f / 5)] = 255; raw[q + 3] = x > 8 && x < 55 ? 255 : 0;
    }
    const source = join(root, "owned.mov"), output = join(root, "out.mp4");
    const made = spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "64x36", "-r", "10", "-i", "pipe:0", "-c:v", "qtrle", "-pix_fmt", "argb", source], { input: raw, windowsHide: true, timeout: 15000 });
    expect(made.status, made.stderr.toString()).toBe(0);
    p.assets[0] = { ...p.assets[0], kind: "video", uri: source, width: 64, height: 36 };
    p.tracks[0].clips[0].duration = .5;
    p.tracks.push({ ...structuredClone(p.tracks[0]), id: "second-track", clips: [{ ...structuredClone(p.tracks[0].clips[0]),
      id: "second-art", trackId: "second-track", timelineStart: .2, sourceStart: .7, duration: .8 }] });
    bindings.layers[1].clipId = "second-art";
    const applied = dispatchCommand(createHistory(p), prepareMesh3dOverlaysV1(p, bindings).commands[0]).present;
    const receipt = await renderMesh3dVideo(validateProject(applied), output, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, timeoutMs: 15000 });
    expect(receipt.frameCount).toBe(10); expect(receipt.sources.map(s => s.sourceStart)).toEqual([.5, 1]);
    expect(receipt.overlaysV1).toMatchObject({ depth: "float64", compositor: "shared-project-frame/v1" });
    const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(160 * 90 * 3 * 10);
    const sample = (frame: number) => [...decoded.stdout.subarray((frame * 160 * 90 + 45 * 160 + 80) * 3, (frame * 160 * 90 + 45 * 160 + 80) * 3 + 3)];
    expect(sample(0)[1]).toBeGreaterThan(240); expect(sample(0)[0]).toBeLessThan(12);
    expect(sample(5)[2]).toBeGreaterThan(240); expect(sample(5)[1]).toBeLessThan(12);
    const transparentEdge = (45 * 160 + 50) * 3;
    expect(Math.min(...decoded.stdout.subarray(transparentEdge, transparentEdge + 3))).toBeGreaterThan(240);
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt)); expect((await readFile(output)).length).toBeGreaterThan(100);
    await expect(renderMesh3dVideo(applied, join(root, "rejected.unknown-format"), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, timeoutMs: 2000 })).rejects.toThrow();
    const image = join(root, "static.png");
    expect(spawnSync(ffmpeg, ["-y", "-v", "error", "-i", source, "-frames:v", "1", image], { windowsHide: true, timeout: 10000 }).status).toBe(0);
    const still = structuredClone(applied); still.assets[0].kind = "image"; still.assets[0].uri = image;
    const stillReceipt = await renderMesh3dVideo(still, join(root, "static-out.mp4"), { ffmpegPath: ffmpeg, ffprobePath: ffprobe, timeoutMs: 10000 });
    expect(stillReceipt.frameCount).toBe(10);
  }, 30000);
});
