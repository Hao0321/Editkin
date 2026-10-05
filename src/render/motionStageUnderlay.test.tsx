import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { editorCommandSchema, projectSchema, motionPresetOverridesSchema } from "../domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MotionGraphic } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { buildReferenceMotionTemplateCommands } from "../application/referenceMotionTemplateCommands";
import { writeAssContent } from "./captionAss";
import { buildEngineRenderGraph } from "./engineGraph";
import MotionOverlay from "../ui/MotionOverlay";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderProject } from "./ffmpeg";

export function stageFixture() {
  const p = createEmptyProject("Stage diagnostic", { width: 256, height: 456, fps: 30 });
  p.colorManagement!.mode = "rec709";
  p.assets = Array.from({ length: 4 }, (_, i) => ({ id: `rgb-${i}`, name: `RGB ${i}`, kind: "video" as const, uri: `D:/owned/rgb-${i}.mp4`, width: 256, height: 456, duration: 5, color: { interpretation: "rec709" as const } }));
  p.tracks[0].clips = [{ id: "rgb", trackId: p.tracks[0].id, assetId: "rgb-0", sourceStart: 0, timelineStart: 0, duration: 5, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  return p;
}

export function stagePanel(layer: "background" | "foreground" = "background"): MotionGraphic {
  const g = createMotionGraphic("stage", "card", "", .5, 1, undefined, findMotionGraphicPreset("reel_native_panel").seed);
  return { ...g, compositeLayer: layer, x: 0, y: 0, width: 1, fontSize: 8, cornerRadius: 0, backgroundColor: "#FFFFFF", outlineWidth: 0, shadowDepth: 0,
    motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
      entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
      exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } },
    layoutV2: { safeArea: { top: 0, left: 0, right: 0, bottom: 0 }, minFontSize: 8, maxLines: 1, lineGap: 0, align: "left" },
    vectorV2: { schema: layer === "background" ? "editkin.motion-vector-stage/v1" : "editkin.motion-vector/v1", kind: "panel", heightPixels: 456, revealFrames: 1 } };
}

describe("Motion stage layer contract", () => {
  it("persists explicit background in project, command and preset variants; default foreground is unchanged", () => {
    const p = stageFixture(), g = stagePanel();
    const changed = applyCommand(p, editorCommandSchema.parse({ type: "add_motion_graphic", graphic: g }));
    expect(projectSchema.parse(JSON.parse(JSON.stringify(changed))).motionGraphics[0]).toEqual(g);
    expect(motionPresetOverridesSchema.parse({ compositeLayer: "background" })).toEqual({ compositeLayer: "background" });
    const restored = applyCommand(changed, editorCommandSchema.parse({ type: "update_motion_graphic", graphicId: g.id, patch: { compositeLayer: "foreground" } }));
    expect(restored.motionGraphics[0].compositeLayer).toBe("foreground");
    expect(p.motionGraphics).toEqual([]);
  });
  it("rejects v1, text, tracking and unknown background positions instead of stripping intent", () => {
    for (const patch of [{ schema: "hao.motion-composition/v1" }, { text: "遮住主體" }, { trackId: "track" }, { compositeLayer: "behind-everything" }, { vectorV2: { ...stagePanel().vectorV2, schema: "editkin.motion-vector/v1" } }]) {
      const g = { ...stagePanel(), ...patch }, p = stageFixture();
      expect(() => editorCommandSchema.parse({ type: "add_motion_graphic", graphic: g })).toThrow();
      p.motionGraphics = [g as MotionGraphic];
      expect(() => validateProject(p)).toThrow();
    }
  });
  it("partitions ASS by actual video composite, keeping captions and foreground out of the background pass", () => {
    const p = stageFixture(); p.motionGraphics = [stagePanel(), { ...stagePanel("foreground"), id: "fore", backgroundColor: "#175CD3" }];
    p.captions = [{ id: "caption", text: "TEST CAPTION", start: 0, duration: 2 }];
    const foreground = writeAssContent(p, p.captionStyle), background = writeAssContent(p, p.captionStyle, { compositeLayer: "background" });
    expect(foreground).toContain("TEST CAPTION"); expect(background).not.toContain("TEST CAPTION");
    expect(background).toContain("&HFFFFFF&"); expect(foreground).not.toContain("\\1c&HFFFFFF&");
    expect(foreground).toContain("&HD35C17&"); expect(background).not.toContain("&HD35C17&");
  });
  it("uses z-index zero for native vector background and retains normal foreground priority", () => {
    const p = stageFixture(); p.motionGraphics = [stagePanel(), { ...stagePanel("foreground"), id: "fore" }];
    const html = renderToStaticMarkup(<MotionOverlay project={p} playhead={1} trackingSelectionEnabled={false}/>);
    expect(html).toContain('data-motion-composite-layer="background"'); expect(html).toContain('z-index:0');
    expect(html).toContain('data-motion-composite-layer="foreground"'); expect(html.match(/z-index:0/g)).toHaveLength(1);
    expect(() => buildEngineRenderGraph(p)).toThrow(/尚未支援/);
  });
  for (const templateId of ["comparison_pair", "focus_wall"] as const) it(`${templateId} authors a shared editable white/grid stage behind its distinct real video slots`, () => {
    const p = stageFixture(); let id = 0;
    const sources = p.assets.slice(1, templateId === "focus_wall" ? 4 : 2).map(a => ({ assetId: a.id, sourceStart: 0, label: "素材" }));
    const packet = buildReferenceMotionTemplateCommands(p, { templateId, clipId: "rgb", startFrame: 0, durationFrames: 150, title: "焦點", sources, purpose: "Stage geometry diagnostic", evidenceRefs: ["synthetic:RGB"] }, prefix => `${prefix}-${id++}`);
    const scene = applyCommand(p, { type: "batch", commands: packet.commands });
    const underlays = scene.motionGraphics.filter(g => g.compositeLayer === "background");
    expect(underlays.map(g => g.vectorV2?.kind)).toEqual(["panel", "line_grid"]);
    expect(underlays[0].backgroundColor).toBe("#FFFFFF"); expect(underlays[0].vectorV2?.heightPixels).toBe(456);
    expect(packet.mediaBindings.length).toBeGreaterThan(1);
    expect(scene.motionGraphics.filter(g => g.text).every(g => g.compositeLayer !== "background")).toBe(true);
  });
});

it("decodes every frame of production RGB / vector layering with positive and two negative controls", async () => {
  const root = resolve(".rd/benchmarks/motion-stage-underlay-20261001/pixels");
  await mkdir(root, { recursive: true });
  const ff = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
  const source = resolve(root, "red.mp4"), width = 256, height = 456, frames = 60;
  const run = (args: string[]) => {
    const result = spawnSync(ff, args, { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw Error(result.stderr?.toString() || String(result.error));
    return result.stdout;
  };
  run(["-y", "-v", "error", "-f", "lavfi", "-i", `color=red:s=${width}x${height}:r=30:d=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const p = stageFixture(); p.assets = [{ ...p.assets[0], uri: source, duration: 2 }];
  p.tracks[0].clips[0].duration = 2; p.tracks[0].clips[0].transform.scale = .5;
  const observations: Array<{ control: string; artifactSha256: string; elapsedMs: number; frameCount: number; samples: Array<{ frame: number; background: number[]; subject: number[] }> }> = [];
  for (const control of ["no-stage", "background", "incorrect-foreground"] as const) {
    const scene = structuredClone(p);
    scene.motionGraphics = control === "no-stage" ? [] : [stagePanel(control === "background" ? "background" : "foreground")];
    const output = resolve(root, `${control}.mp4`), begin = performance.now();
    await renderProject(scene, output, { ffmpegPath: ff, ffprobePath: fp, fontRoot: resolve(process.env.EDITKIN_FONT_ROOT ?? "public/fonts"), preferGpu: false, timeoutMs: 30000 });
    const elapsedMs = performance.now() - begin;
    const raw = run(["-v", "error", "-i", output, "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(raw.length).toBe(width * height * 3 * frames);
    const pixel = (frame: number, x: number, y: number) => [...raw.subarray((frame * width * height + y * width + x) * 3, (frame * width * height + y * width + x) * 3 + 3)];
    const samples = Array.from({ length: frames }, (_, frame) => ({ frame, background: pixel(frame, 12, 220), subject: pixel(frame, 128, 228) }));
    observations.push({ control, artifactSha256: createHash("sha256").update(await readFile(output)).digest("hex"), elapsedMs, frameCount: frames, samples });
  }
  const stageCorrect = (observation: typeof observations[number]) => observation.samples.every(s => {
    const active = s.frame >= 15 && s.frame < 45;
    const expectedBackground = active ? s.background.every(v => v >= 240) : s.background.every(v => v <= 12);
    return expectedBackground && s.subject[0] > 220 && s.subject[1] < 25 && s.subject[2] < 25;
  });
  const verdict = observations.map(o => ({ control: o.control, evaluatorAccepted: stageCorrect(o) }));
  await writeFile(resolve(root, "PIXEL_VERIFICATION.json"), JSON.stringify({ scope: "source production Rec.709 adapter diagnostic, not film/art/native Windows verification", dimensions: [width, height], fps: 30, sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"), verdict, observations }, null, 2));
  expect(verdict).toEqual([{ control: "no-stage", evaluatorAccepted: false }, { control: "background", evaluatorAccepted: true }, { control: "incorrect-foreground", evaluatorAccepted: false }]);
  expect(observations[0].samples.every(s => s.background.every(v => v <= 12))).toBe(true);
  expect(observations[2].samples.slice(15, 45).every(s => s.subject.every(v => v >= 240))).toBe(true);
}, 60000);
