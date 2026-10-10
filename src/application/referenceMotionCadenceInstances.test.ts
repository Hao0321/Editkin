import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/server";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { referenceMotionTemplateInputSchema, REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { normalizeReferenceMotionTemplateInput } from "./referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import { registerReferenceMotionTemplateTools } from "../mcp/referenceMotionTemplateTools";
import type { ReferenceMotionPlan } from "./referenceMotionPlan";

const faces = new Map<string, Uint8Array>();
async function prepareText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    if (faces.size >= 2) faces.delete(faces.keys().next().value!);
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() { let ordinal = 0; return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`; }
function fixture() {
  const project = createEmptyProject("Synthetic cadence ownership control", { id: "cadence-project", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", kind: "video", name: "Synthetic source metadata", uri: "D:/owned/cadence-source.mp4",
    duration: 20, width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "primary", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0,
    sourceStart: 2, duration: 12, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "primary", startFrame: 0, durationFrames: 360,
    title: "FOCUS", kicker: "OWN", subtitle: "READ THE SOURCE", sources: [], intent: "standalone_showcase",
    purpose: "Synthetic real-glyph cadence control; no media or artwork certification", evidenceRefs: ["synthetic:cadence-source"],
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
  return { project, input };
}
async function saved(cadence?: "legacy" | "brisk" | "kinetic") {
  const f = fixture(); if (cadence !== undefined) f.input.graphicCadence = cadence;
  const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText });
  return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
}
const sourceState = (project: EditProject) => project.tracks.map(track => ({ id: track.id, kind: track.kind, muted: track.muted,
  clips: track.clips.map(clip => ({ id: clip.id, trackId: clip.trackId, assetId: clip.assetId, sourceStart: clip.sourceStart,
    timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume })) }));
const createDeclaration = (packet: Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>): ReferenceMotionPlan => ({
  schema: "editkin.reference-motion-plan/v1", instances: [{ mode: "create", instanceId: packet.instance.id,
    commandIndexes: packet.commands.map((_, index) => index) }],
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("saved native graphic cadence with real physical glyph preparation", () => {
  it("binds kinetic to its own versioned recipe identity and reopens it unchanged", async () => {
    const kinetic = await saved("kinetic"), brisk = await saved("brisk");
    expect(kinetic.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/kinetic-v1:[a-f0-9]{64}$/);
    expect(kinetic.packet.instance.dependencies.recipeVersion).not.toBe(brisk.packet.instance.dependencies.recipeVersion);
    const reopened = decodeProjectBytes(encodeProjectBytes(kinetic.current));
    const same = await prepareReferenceMotionTemplateRevision(reopened, kinetic.packet.instance.id, { title: "FOCUS" }, { expectedInstanceRevision: 1, prepareText });
    expect(same.status).toBe("UNCHANGED"); expect(same.instance.input.graphicCadence).toBe("kinetic");
  });
  it("keeps historical omitted and explicit legacy graph timings and exact recipe hash", async () => {
    const omitted = await saved(), legacy = await saved("legacy");
    expect(normalizeReferenceMotionTemplateInput(omitted.input).graphicCadence).toBeUndefined();
    expect(omitted.packet.instance.input.graphicCadence).toBeUndefined();
    const expected = "editkin.reference-motion-recipes/semantic-roles-v1:94e0e436895b0bb0dfd1d9f6f44d82bc8de924dd7901e5ebbb1012010aa06e1e";
    expect(omitted.packet.instance.dependencies.recipeVersion).toBe(expected);
    expect(legacy.packet.instance.dependencies.recipeVersion).toBe(expected);
    expect(legacy.packet.commands.slice(0, -1)).toEqual(omitted.packet.commands.slice(0, -1));
    const reopened = decodeProjectBytes(encodeProjectBytes(omitted.current));
    const unchanged = await prepareReferenceMotionTemplateRevision(reopened, omitted.packet.instance.id, { title: "FOCUS" }, { expectedInstanceRevision: 1, prepareText });
    expect(unchanged.status).toBe("UNCHANGED"); expect(unchanged.commands).toEqual([]);
    expect(unchanged.instance.input.graphicCadence).toBeUndefined();
  });

  it("persists explicit brisk and true font dependencies through actual project bytes", async () => {
    const f = await saved("brisk"), reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.referenceMotionInstances?.[0]).toEqual(f.packet.instance);
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/brisk-v1:[a-f0-9]{64}$/);
    expect(f.packet.instance.dependencies.recipeVersion.length).toBeLessThanOrEqual(120);
    expect(f.packet.instance.dependencies.fonts.length).toBeGreaterThan(0);
    expect(f.packet.physicalLayoutBindings.every(binding => binding.physicalFont.parserVersion === "opentype.js@1.3.4")).toBe(true);
    expect(f.packet.status).toBe("REVIEW_REQUIRED"); expect(JSON.stringify(f.packet.instance)).not.toMatch(/pathCommands|glyphs|outline/);
    expect(sourceState(reopened)).toEqual(sourceState(f.project));
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("revises cadence in one real Undo batch while retaining semantic IDs source frames and primary gain", async () => {
    const f = await saved(); f.current.tracks[0].clips[0].volume = .31;
    const before = canonicalJson(f.current), revised = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id,
      { graphicCadence: "brisk" }, { expectedInstanceRevision: 1, prepareText });
    expect(canonicalJson(f.current)).toBe(before); expect(revised.instance.instanceRevision).toBe(2);
    expect(revised.instance.roles).toEqual(f.packet.instance.roles);
    expect(revised.instance.input.style.animationSpeed).toBe(1);
    const oldHeading = f.current.motionGraphics.find(graphic => graphic.id === f.packet.instance.roles.find(role => role.key === "headline")!.id)!;
    const history = dispatchCommand(createHistory(f.current), { type: "batch", commands: revised.commands });
    const newHeading = history.present.motionGraphics.find(graphic => graphic.id === oldHeading.id)!;
    expect(newHeading.motionV2!.entrance.durationFrames).toBeLessThan(oldHeading.motionV2!.entrance.durationFrames);
    expect(sourceState(history.present)).toEqual(sourceState(f.current)); expect(history.past).toHaveLength(1);
    const restored = undo(history); expect(restored.present.motionGraphics).toEqual(f.current.motionGraphics);
    expect(restored.present.referenceMotionInstances).toEqual(f.current.referenceMotionInstances);
    const repeated = redo(restored); expect(repeated.present.motionGraphics).toEqual(history.present.motionGraphics);
    expect(repeated.present.referenceMotionInstances).toEqual(history.present.referenceMotionInstances);
  });

  it("retains current brisk on copy-only revision and can explicitly return to the original legacy graph", async () => {
    const f = await saved("legacy"), brisk = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id,
      { graphicCadence: "brisk" }, { expectedInstanceRevision: 1, prepareText });
    const current = applyCommand(f.current, { type: "batch", commands: brisk.commands });
    const same = await prepareReferenceMotionTemplateRevision(current, f.packet.instance.id, { title: "FOCUS" }, { expectedInstanceRevision: 2, prepareText });
    expect(same.status).toBe("UNCHANGED"); expect(same.commands).toEqual([]); expect(same.instance.input.graphicCadence).toBe("brisk");
    const back = await prepareReferenceMotionTemplateRevision(current, f.packet.instance.id, { graphicCadence: "legacy" }, { expectedInstanceRevision: 2, prepareText });
    const restored = applyCommand(current, { type: "batch", commands: back.commands });
    expect(restored.motionGraphics).toEqual(f.current.motionGraphics); expect(sourceState(restored)).toEqual(sourceState(f.current));
    expect(back.instance.roles).toEqual(f.packet.instance.roles); expect(back.instance.dependencies).toEqual(f.packet.instance.dependencies);
  });

  it("independently recompiles brisk v4 creation and rejects a forged transient or a mismatched cadence patch", async () => {
    const f = await saved("brisk");
    await expect(verifyReferenceMotionPlan(createDeclaration(f.packet), f.project, f.packet.commands)).resolves.toMatchObject({ instanceCount: 1 });
    const forged = structuredClone(f.packet.commands), add = forged.find(command => command.type === "add_motion_graphic" && command.graphic.text === "FOCUS");
    if (!add || add.type !== "add_motion_graphic") throw new Error("Real cadence control lacks a physical heading");
    add.graphic.motionV2!.entrance.durationFrames += 1;
    await expect(verifyReferenceMotionPlan(createDeclaration(f.packet), f.project, forged)).rejects.toThrow(/independently recompiled/);
    const revised = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { graphicCadence: "legacy" }, { expectedInstanceRevision: 1, prepareText });
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ mode: "revise", instanceId: f.packet.instance.id,
      expectedInstanceRevision: 1, patch: { graphicCadence: "brisk" }, commandIndexes: revised.commands.map((_, index) => index) }] };
    await expect(verifyReferenceMotionPlan(declaration, f.current, revised.commands)).rejects.toThrow(/Unchanged|independently recompiled/);
  });

  it("rejects stale and already cancelled cadence revision before preparing fonts or mutating its owner", async () => {
    const f = await saved(), before = canonicalJson(f.current), provider = vi.fn(prepareText);
    await expect(prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { graphicCadence: "brisk" },
      { expectedInstanceRevision: 2, prepareText: provider })).rejects.toThrow(/stale/);
    const controller = new AbortController(); controller.abort();
    await expect(prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { graphicCadence: "brisk" },
      { expectedInstanceRevision: 1, prepareText: provider, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(provider).not.toHaveBeenCalled(); expect(canonicalJson(f.current)).toBe(before);
  });

  it("rejects unknown numeric null and boolean cadence without opening arbitrary revision timing fields", () => {
    const f = fixture();
    for (const value of ["fast", 2, null, true]) {
      expect(() => referenceMotionTemplateInputSchema.parse({ ...f.input, graphicCadence: value })).toThrow();
      expect(() => referenceMotionTemplateRevisionPatchSchema.parse({ graphicCadence: value })).toThrow();
    }
    expect(() => referenceMotionTemplateRevisionPatchSchema.parse({ style: { animationSpeed: 2 } })).toThrow();
    expect(() => referenceMotionTemplateRevisionPatchSchema.parse({ graphicCadence: "brisk", durationFrames: 60 })).toThrow();
    expect(referenceMotionTemplateRevisionPatchSchema.parse({ graphicCadence: "brisk" })).toEqual({ graphicCadence: "brisk" });
  });

  it("uses the real registered MCP new-authoring default while preserving explicit legacy and recipe descriptors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-cadence-mcp-"));
    try {
      vi.stubEnv("EDITKIN_WORKSPACE", directory);
      const f = fixture(), path = join(directory, "synthetic.editkin.json"); await writeFile(path, encodeProjectBytes(f.project));
      type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };
      const handlers = new Map<string, (input: Record<string, unknown>) => Promise<Reply>>();
      const server = { registerTool: (name: string, _config: unknown, handler: (input: Record<string, unknown>) => Promise<Reply>) => { handlers.set(name, handler); } };
      registerReferenceMotionTemplateTools(server as unknown as McpServer, { EDITKIN_FONT_ROOT: resolve("public/fonts") });
      const call = async (name: string, input: Record<string, unknown>) => {
        const reply = await handlers.get(name)!(input); expect(reply.isError).not.toBe(true);
        return JSON.parse(reply.content[0].text!) as Record<string, any>;
      };
      const catalog = await call("list_reference_motion_templates", {});
      expect(catalog.templates).toEqual(REFERENCE_MOTION_TEMPLATES);
      expect(catalog.graphicCadenceCapabilities).toMatchObject({ newAuthoringDefault: "kinetic", historicalOmittedDefault: "legacy",
        savedInstanceAutomaticUpgrade: false, revisionCanChangeCadence: true });
      const requested = await call("prepare_reference_motion_template", { projectPath: path, ...f.input });
      expect(requested.instance.input.graphicCadence).toBe("kinetic"); expect(requested.status).toBe("REVIEW_REQUIRED");
      const legacy = await call("prepare_reference_motion_template", { projectPath: path, ...f.input, graphicCadence: "legacy" });
      expect(legacy.instance.input.graphicCadence).toBe("legacy");
      expect(legacy.instance.dependencies.recipeVersion).toBe("editkin.reference-motion-recipes/semantic-roles-v1:94e0e436895b0bb0dfd1d9f6f44d82bc8de924dd7901e5ebbb1012010aa06e1e");
      expect(Buffer.from(await readFile(path)).equals(Buffer.from(encodeProjectBytes(f.project)))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
