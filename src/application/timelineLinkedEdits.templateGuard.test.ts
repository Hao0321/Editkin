import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { applyCommand } from "../domain/commands";
import { LINK_TEMPLATE_REFUSAL } from "../domain/linkedClipCommands";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace } from "../typography/preparedGlyphRun";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
it("keeps a physical-font CURRENT title byte-identical when its linked source refuses a temporal edit", async () => {
  const { project, clip } = audioEnvelopeFixture(); project.width = 1080; project.height = 1920; project.assets[0].kind = "video";
  clip.trackId = "video-main"; clip.timelineStart = 0; clip.duration = 6; clip.linkGroupId = "owned-title-pair";
  project.tracks[0].clips = [clip]; project.tracks[1].clips = [{ ...structuredClone(clip), id: "sound-peer", trackId: "audio-main" }]; let next = 0;
  const packet = await prepareReferenceMotionTemplateInstance(project, { templateId: "level_bridge", clipId: clip.id, startFrame: 0, durationFrames: 180, title: "FOCUS", kicker: "LOOK", purpose: "Owned linked refusal", evidenceRefs: ["owned:clip-links"], graphicCadence: "kinetic", style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } }, prefix => `${prefix}-${++next}`,
    { prepareText: async (faceId, text) => { const raw = await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)); return (await preparePhysicalFace(faceId, new Uint8Array(raw)))(text); } });
  const managed = applyCommand(project, { type: "batch", commands: packet.commands }), before = JSON.stringify(managed);
  expect((await inspectReferenceMotionTemplateInstance(managed, packet.instance.id)).status).toBe("CURRENT");
  expect(() => applyCommand(managed, { type: "move_clip", clipId: "sound-peer", timelineStart: 1 })).toThrow(LINK_TEMPLATE_REFUSAL);
  expect(JSON.stringify(managed)).toBe(before); expect((await inspectReferenceMotionTemplateInstance(managed, packet.instance.id)).status).toBe("CURRENT");
});
