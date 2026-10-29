import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { parseProject } from "../application/projectCodec";
import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import type { ReferenceMotionSourceReplacementPreparation } from "../application/referenceMotionSourceTransaction";
import type { ReferenceMotionCompatiblePlan } from "../application/referenceMotionSourcePlanV2";
import type { MediaProbe } from "../render/ffmpegContracts";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { registerReferenceMotionSourceTools } from "./referenceMotionSourceTools";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";
import { applyProjectCommands } from "./storage";

type Result = { content: { text: string }[]; isError?: boolean };
type Entry = { options: { inputSchema: { parse(value: unknown): any }; annotations: Record<string, boolean> }; handle: (input: any) => Promise<Result> };
type Prepared = ReferenceMotionSourceReplacementPreparation & { planDeclaration: ReferenceMotionCompatiblePlan };
const roots: string[] = [], prefix = "editkin-source-mcp-", previousWorkspace = process.env.EDITKIN_WORKSPACE;
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error("Refuse unowned source fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
});
// Controlled probe plus real owned bytes/disk project and real glyphs; this is not decoded footage, rights, artwork or native release acceptance.
async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); process.env.EDITKIN_WORKSPACE = root;
  let project = createEmptyProject("Source MCP exact compilation control", { id: "source-mcp", width: 1080, height: 1920, fps: 30 });
  if (native) project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  project.assets = ["old", "new"].map(id => ({ id, name: `Synthetic ${id}`, kind: "video" as const, uri: join(root, `${id}.mp4`),
    duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" as const } }));
  for (const asset of project.assets) await writeFile(asset.uri, `controlled probe source bytes ${asset.id}`);
  project.tracks[0].clips = [{ id: "primary", assetId: "old", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 1, duration: 8, volume: .7,
    keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }];
  let ordinal = 0;
  const original = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateInstance(project, {
    templateId: "level_bridge", clipId: "primary", startFrame: 0, durationFrames: 240, title: "FOCUS", kicker: "EDITKIN", subtitle: "CLEAR VIEW", sources: [],
    purpose: "Synthetic original compilation", evidenceRefs: ["synthetic:old"], graphicCadence: "brisk",
    ...(native ? { graphicPresentation: "native_paint_display_v2" as const } : {}),
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
  }, key => `${key}-original-${++ordinal}`, dependencies));
  project = parseProject(applyCommand(project, { type: "batch", commands: original.commands }));
  const path = join(root, "source.editkin.json"); await writeFile(path, JSON.stringify(project));
  const probe = vi.fn(async (): Promise<MediaProbe> => ({ duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    hasVideo: true, hasAudio: true, frameRate: { numerator: 24000, denominator: 1001 } }));
  const entries = new Map<string, Entry>();
  registerReferenceMotionSourceTools({ registerTool(name: string, options: unknown, handle: unknown) { entries.set(name, { options, handle } as Entry); } } as unknown as McpServer, process.env, probe);
  const entry = entries.get("prepare_reference_motion_template_source_replacement")!;
  const request = { projectPath: path, instanceId: original.instance.id, expectedInstanceRevision: 1, expectedProjectRevision: project.revision,
    primary: { assetId: "new", sourceStart: 2 }, audio: { primary: "keep_level" as const, extra: [] }, focusRegion: null, textRegion: null,
    purpose: "New synthetic observed source", evidenceRefs: ["synthetic:new"] };
  const prepare = async () => { const response = await entry.handle(entry.options.inputSchema.parse(request));
    if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text) as Prepared; };
  return { root, path, project, original, entry, request, prepare, probe };
}
describe("readonly same-instance source preparation and independent current v4 authority", () => {
  it.each([false, true])("independently rederives actual glyph commands, forwards source/native proof and preserves disk bytes (native=%s)", async native => {
    const f = await fixture(native), before = await readFile(f.path), prepared = await f.prepare();
    expect(f.entry.options.annotations.readOnlyHint).toBe(true); expect(await readFile(f.path)).toEqual(before);
    expect(prepared.sourceFrameRates[0]).toEqual({ assetId: "new", frameRate: { numerator: 24000, denominator: 1001 } });
    const verified = await verifyReferenceMotionPlan(prepared.planDeclaration, f.project, prepared.commands);
    expect(verified.instanceCount).toBe(1); expect(verified.referenceMotionSourceOwnerProof).toBeDefined();
    expect(Boolean(verified.nativePaintOwnerRevisionProof)).toBe(native);
    const batch = { type: "batch" as const, commands: prepared.commands };
    expect(() => applyCommand(f.project, batch)).toThrow();
    const final = parseProject(applyCommand(f.project, batch, verified));
    expect(final.referenceMotionInstances?.[0].instanceRevision).toBe(2); expect(final.referenceMotionInstances?.[0].input.title).toBe(f.original.instance.input.title);
    expect((await inspectReferenceMotionTemplateInstance(final, f.original.instance.id)).status).toBe("CURRENT");
    expect(final.tracks[0].clips[0]).toMatchObject({ assetId: "new", sourceStart: 2, volume: .7 });
    expect(canonicalJson(f.project)).toBe(canonicalJson(JSON.parse(before.toString())));
    await expect(applyProjectCommands(f.path, [{ type: "batch", commands: prepared.commands }])).rejects.toThrow(/raw commands/);
    expect(await readFile(f.path)).toEqual(before);
  });
  it("rejects serialized proof, wrong intent and visual changes even with altered scope metadata", async () => {
    const f = await fixture(); Object.assign(f.request, { durationFrames: 180 });
    const prepared = await f.prepare(), batch = { type: "batch" as const, commands: prepared.commands };
    const verified = await verifyReferenceMotionPlan(prepared.planDeclaration, f.project, prepared.commands);
    expect(() => applyCommand(f.project, batch, JSON.parse(JSON.stringify(verified)))).toThrow();
    const intent = structuredClone(prepared.planDeclaration); const step = intent.instances[0];
    if (step.mode !== "replace_source") throw new Error("Control requires source intent");
    step.replacement.primary!.sourceStart = 3;
    await expect(verifyReferenceMotionPlan(intent, f.project, prepared.commands)).rejects.toThrow(/independently recompiled/);
    const commands = structuredClone(prepared.commands), graphic = commands.find(command => command.type === "update_motion_graphic");
    if (!graphic || graphic.type !== "update_motion_graphic") throw new Error("Control requires an actual graphic revision");
    graphic.patch.fontSize = Number(graphic.patch.fontSize) + 1;
    const last = commands.at(-1)!; if (last.type !== "upsert_reference_motion_instance") throw new Error("Metadata missing");
    last.instance.appliedScopeSha256 = "e".repeat(64);
    await expect(verifyReferenceMotionPlan(prepared.planDeclaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });
  it("requires explicit fresh observations and regions, and exposes neither caller audio modes nor process grants", async () => {
    const f = await fixture();
    expect(() => f.entry.options.inputSchema.parse({ ...f.request, audio: { primary: "keep_level", extra: ["source"] } })).toThrow();
    expect(() => f.entry.options.inputSchema.parse({ ...f.request, proof: {} })).toThrow();
    f.request.evidenceRefs = ["synthetic:old"]; await expect(f.prepare()).rejects.toThrow(/新的素材確認/);
  });
  it("refuses changed measured geometry and disk mutation during the probe without overwriting either", async () => {
    const f = await fixture(), before = await readFile(f.path);
    f.probe.mockImplementationOnce(async () => ({ duration: 30, width: 1080, height: 1080, hasVideo: true, hasAudio: true }));
    await expect(f.prepare()).rejects.toThrow(/匯入時不同/); expect(await readFile(f.path)).toEqual(before);
    const changed = { ...f.project, name: "Concurrent disk edit" };
    f.probe.mockImplementationOnce(async () => { await writeFile(f.path, JSON.stringify(changed)); return { duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16, hasVideo: true, hasAudio: true }; });
    await expect(f.prepare()).rejects.toThrow(/changed during/); expect(JSON.parse((await readFile(f.path)).toString()).name).toBe(changed.name);
  });
});
