import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmptyProject, validateProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../../domain/types";
import { createMotionGraphic } from "../../motion/composition";
import { findMotionGraphicPreset } from "../../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../../typography/preparedGlyphRun";
import { motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout } from "../../motion/compositionV2";
import { prepareMotionSceneCamera2D } from "../../motion/sceneCamera2d";

export const trackedTextFaceV1 = "EditkinFace-bebas-neue-400";
const fontBytes = readFile(resolve("public/fonts", bundledFontFaceSpec(trackedTextFaceV1).fontFile));
/** Genuine bundled outlines, synthetic source geometry, no real-footage/art claim. */
export async function trackedTextFixtureV1(options: { mode?: "anchor" | "surface"; text?: string;
  edit?: (project: EditProject, graphic: MotionGraphic) => void } = {}) {
  const p = createEmptyProject("Owned text tracking control", { id: "tracked-text-control", width: 320, height: 180, fps: 12 });
  p.assets = [{ id: "source", name: "synthetic source", kind: "video", uri: "D:/synthetic/text-tracking.mkv", duration: 2.25,
    width: 320, height: 180, color: { interpretation: "rec709" } }];
  p.tracks[0].clips = [{ id: "clip", assetId: "source", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: .25, duration: 2,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  p.motionTracks = [{ id: "follow", clipId: "clip", name: "numeric reference", engine: "manual:owned-control", analysisFps: 2,
    initialRect: { x: .1, y: .2, width: .4, height: .4 }, createdAt: "2026-10-17T00:00:00Z", lostRatio: 1 / 3,
    points: [{ frame: 0, time: 0, status: "manual", confidence: 1, rotationDegrees: 0, scale: 1,
      rect: { x: .1, y: .2, width: .4, height: .4 }, quad: [{ x: .1, y: .2 }, { x: .5, y: .2 }, { x: .5, y: .6 }, { x: .1, y: .6 }] },
    { frame: 2, time: 1, status: "tracked", confidence: 1, rotationDegrees: 20, scale: 1.15,
      rect: { x: .16, y: .18, width: .48, height: .5 }, quad: [{ x: .2, y: .2 }, { x: .64, y: .18 }, { x: .6, y: .68 }, { x: .16, y: .6 }] },
    { frame: 3, time: 1.5, status: "lost", confidence: 0, rotationDegrees: 20, scale: 1.15,
      rect: { x: .16, y: .18, width: .48, height: .5 }, quad: [{ x: .2, y: .2 }, { x: .64, y: .18 }, { x: .6, y: .68 }, { x: .16, y: .6 }] }] }];
  const g = createMotionGraphic("graphic", "title", options.text ?? "AV", 0, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(g, { x: .12, y: .25, width: .7, fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 24,
    backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0, letterSpacing: 0,
    vectorTrackingV1: { schema: "editkin.vector-tracking/v1", trackId: "follow", mode: options.mode ?? "anchor", referenceTime: 0 } });
  g.layoutV2 = { ...g.layoutV2!, widthMode: "fit_content", align: "left", minFontSize: 24 };
  g.motionV2 = { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 },
    entrance: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: { type: "linear" } } };
  p.motionGraphics = [g]; options.edit?.(p, g); validateProject(p);
  const run = await prepareGlyphRun(trackedTextFaceV1, g.text, new Uint8Array(await fontBytes));
  const layout = prepareMotionGraphicV2FrameLayout(p, g, motionGraphicV2PhysicalLayoutReceipt(p, g, run));
  const camera = (frame: number) => prepareMotionSceneCamera2D(p).sample(g.id, frame);
  return { p, g, run, layout, camera };
}
