import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createEmptyProject, animatedClipState } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { parseProject } from "./projectCodec";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { prepareReferenceMotionTemplate, type ReferenceMotionTemplatePreparationDependencies } from "./referenceMotionTemplates";
import { REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";

const bytes = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  let selected = bytes.get(faceId);
  if (!selected) {
    selected = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    if (bytes.size >= 2) bytes.delete(bytes.keys().next().value!);
    bytes.set(faceId, selected);
  }
  return prepareGlyphRun(faceId, text, selected);
}
function fixture(templateId: ReferenceMotionTemplateId = "level_bridge") {
  const project = createEmptyProject("Owned template source", { id: "template-v2-source", width: 1080, height: 1920, fps: 30 });
  project.assets = Array.from({ length: 9 }, (_, index) => ({ id: `asset-${index}`, name: `Owned source ${index}`, kind: "video" as const,
    uri: `D:/owned/template-source-${index}.mp4`, duration: 20, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const } }));
  project.tracks[0].clips = [{ id: "source-clip", assetId: "asset-0", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 2, duration: 12, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = { templateId, clipId: "source-clip", startFrame: 0, durationFrames: 360,
    title: "FOCUS", kicker: "OWNED", subtitle: "STAY CLEAR", previousText: "OLD IDEA", primaryLabel: "MAIN",
    items: [{ label: "ONE", detail: "SOURCE" }, { label: "TWO", detail: "READ" }, { label: "THREE", detail: "RETURN" }],
    sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 2 : 0 }, (_, index) => ({
      assetId: `asset-${index + 1}`, sourceStart: 3, label: `VIEW ${index + 1}` })),
    purpose: "Show the declared source and retain readable semantic holds", evidenceRefs: ["owned:observed-source-window"],
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
  return { project, input };
}
function idSequence() { let next = 0; return (prefix: string) => `${prefix}-${next++}`; }
const dependencies = (): ReferenceMotionTemplatePreparationDependencies => ({ prepareText: physicalText });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("latest reference template preparation with verified physical glyphs", () => {
  it.each(REFERENCE_MOTION_TEMPLATES)("prepares actual physical layouts for $id and reopens unchanged source clocks", async ({ id }) => {
    const { project, input } = fixture(id), before = canonicalJson(project), runs = new Map<string, PreparedGlyphRun>();
    input.style = undefined;
    input.title = "保留焦點"; input.kicker = "核對素材"; input.subtitle = "先看清楚";
    input.previousText = "動態越多越好"; input.primaryLabel = "主要來源";
    input.items = [{ label: "素材", detail: "核對內容" }, { label: "焦點", detail: "保留閱讀" }, { label: "收束", detail: "回到原片" }];
    input.sources = input.sources!.map((source, index) => ({ ...source, label: `素材${index + 1}` }));
    const packet = await prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText: async (faceId, text) => {
      const run = await physicalText(faceId, text); runs.set(canonicalJson([faceId, text]), run); return run;
    } });
    expect(canonicalJson(project)).toBe(before);
    expect(packet).toMatchObject({ schema: "editkin.reference-motion-template/v2", status: "REVIEW_REQUIRED", readOnly: true,
      preparation: { applied: false, maximumPhysicalGlyphRequests: 64, deadlineMs: 10_000 } });
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: packet.commands }))));
    expect(reopened.tracks[0].clips[0]).toMatchObject({ id: "source-clip", sourceStart: 2, timelineStart: 0, duration: 12, volume: .7 });
    expect(reopened.assets).toEqual(project.assets);
    expect(reopened.tracks.flatMap(track => track.clips).filter(clip => clip.volume > 0)).toHaveLength(1);
    const textGraphics = reopened.motionGraphics.filter(graphic => !graphic.vectorV2);
    expect(textGraphics.some(graphic => /[\u3400-\u9fff]/u.test(graphic.text))).toBe(true);
    expect(new Set(packet.physicalLayoutBindings.map(row => row.physicalFont.faceId))).toEqual(
      new Set(textGraphics.map(graphic => {
        const layout = packet.layouts.find(row => row.graphicId === graphic.id)!;
        expect(layout.physicalFont!.faceId).toMatch(/^EditkinFace-noto-(sans|serif)-tc-/);
        return layout.physicalFont!.faceId;
      })));
    expect(packet.physicalLayoutBindings).toHaveLength(textGraphics.length);
    for (const graphic of textGraphics) {
      const receipt = packet.layouts.find(layout => layout.graphicId === graphic.id)!;
      const run = runs.get(canonicalJson([receipt.physicalFont!.faceId, graphic.text.replaceAll("\r", "")]))!;
      expect(receipt.physicalFont!.fontSha256).toBe(bundledFontFaceSpec(run.faceId).sha256);
      expect(motionGraphicV2PhysicalLayoutReceipt(reopened, graphic, run)).toEqual(receipt);
      expect(receipt.segments.filter(segment => segment.outline).length).toBeGreaterThan(0);
      const event = packet.editorialGraphics.find(row => row.id === graphic.id)!;
      expect(() => assertMotionPresetVariantBinding(graphic, event.presetId, event.presetVariant!)).not.toThrow();
      expect(event.range).toEqual({ startFrame: Math.round(graphic.timelineStart * 30), endFrame: Math.round((graphic.timelineStart + graphic.duration) * 30) });
    }
    expect(packet.sourceGeneration.projectSha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(packet.sourceContinuity.originalAudioUnchanged).toBe(true);
  });

  it("requires a physical provider and never calls the estimated legacy generation", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), undefined as unknown as ReferenceMotionTemplatePreparationDependencies)).rejects.toThrow(/FONT_BYTES_REQUIRED/);
    expect(project.motionGraphics).toHaveLength(0);
  });
  it("rejects a cloned factory receipt rather than trusting claimed font hashes", async () => {
    const { project, input } = fixture(), prepareText = vi.fn(async (faceId: string, text: string) => structuredClone(await physicalText(faceId, text)));
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText })).rejects.toThrow(/not made by this factory/);
    expect(prepareText).toHaveBeenCalledTimes(1); expect(project.motionGraphics).toHaveLength(0);
  });
  it("rejects a true run from a different physical face", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), {
      prepareText: (_faceId, text) => physicalText("EditkinFace-fredoka-700", text),
    })).rejects.toThrow(/different font or text/);
  });
  it("rejects a true run for different visible text", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), {
      prepareText: faceId => physicalText(faceId, "DIFFERENT"),
    })).rejects.toThrow(/different font or text/);
  });
  it("keeps real font byte corruption as a terminal failure without re-entry", async () => {
    const { project, input } = fixture(), prepareText = vi.fn(async (faceId: string, text: string) => {
      const selected = Uint8Array.from(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
      selected[0] ^= 1; return prepareGlyphRun(faceId, text, selected);
    });
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText })).rejects.toThrow(/SHA|digest|hash/i);
    expect(prepareText).toHaveBeenCalledTimes(1);
  });
  it("does not retry a provider error or emit partial commands", async () => {
    const { project, input } = fixture(), error = new Error("physical source unavailable"), prepareText = vi.fn(async () => { throw error; });
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText })).rejects.toBe(error);
    expect(prepareText).toHaveBeenCalledTimes(1); expect(project.motionGraphics).toHaveLength(0);
  });
  it("rejects a changed asset generation after actual font preparation", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText: async (faceId, text) => {
      const run = await physicalText(faceId, text); project.assets[0].displayAspectRatio = 16 / 9; return run;
    } })).rejects.toThrow(/source generation changed/);
    expect(project.motionGraphics).toHaveLength(0);
  });
  it("rejects changed authoring inputs after actual font preparation", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText: async (faceId, text) => {
      const run = await physicalText(faceId, text); input.title = "NEW INPUT"; return run;
    } })).rejects.toThrow(/source generation changed/);
  });
  it("honours cancellation before requesting font work", async () => {
    const { project, input } = fixture(), controller = new AbortController(), prepareText = vi.fn(physicalText); controller.abort();
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(prepareText).not.toHaveBeenCalled();
  });
  it("stops on cancellation while a glyph provider is pending and ignores its late success", async () => {
    const { project, input } = fixture(), controller = new AbortController();
    const run = await physicalText("EditkinFace-bebas-neue-400", "OWNED");
    let finish!: (run: PreparedGlyphRun) => void;
    const preparing = prepareReferenceMotionTemplate(project, input, idSequence(), { signal: controller.signal,
      prepareText: () => new Promise<PreparedGlyphRun>(resolve => { finish = resolve; }) });
    const rejected = expect(preparing).rejects.toThrow(/cancelled/); controller.abort(); await rejected;
    finish(run); await Promise.resolve(); expect(project.motionGraphics).toHaveLength(0);
  });
  it("uses one original deadline and does not renew it at compiler re-entry", async () => {
    const { project, input } = fixture(); let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const prepareText = vi.fn(async (faceId: string, text: string) => { const run = await physicalText(faceId, text); clock = 10_001; return run; });
    await expect(prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText })).rejects.toThrow(/original 10-second deadline/);
    expect(prepareText).toHaveBeenCalledTimes(1); expect(project.motionGraphics).toHaveLength(0);
  });
  it("holds every generated identity across glyph suspension including cloned clips, masks and keyframes", async () => {
    const { project, input } = fixture("focus_wall"), ids: string[] = [], prefixes: string[] = [];
    const packet = await prepareReferenceMotionTemplate(project, input, prefix => { const id = `${prefix}-${ids.length}`; prefixes.push(prefix); ids.push(id); return id; }, dependencies());
    const emitted = packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id]
      : command.type === "add_track" ? [command.track.id] : command.type === "add_clip" ? [command.clip.id]
        : command.type === "add_clip_mask" ? [command.mask.id] : command.type === "add_keyframe" ? [command.keyframe.id] : []);
    expect(new Set(ids).size).toBe(ids.length); expect(emitted).toHaveLength(ids.length);
    expect(new Set(emitted)).toEqual(new Set(ids));
    expect(prefixes).toEqual(expect.arrayContaining(["motion-template", "motion-source-track", "motion-source-clip", "motion-edge", "motion-key"]));
    expect(packet.mediaBindings.at(-1)).toMatchObject({ assetId: "asset-0", sourceStart: 2, role: "選中素材連續前景（不是新證據）" });
  });
  it("shares equal face-text runs while recomputing each differently styled physical layout", async () => {
    const { project, input } = fixture("context_stack"); input.title = "SAME"; input.kicker = "SAME";
    input.items = [{ label: "SAME", detail: "SAME" }, { label: "SAME", detail: "SAME" }];
    const prepareText = vi.fn(physicalText), packet = await prepareReferenceMotionTemplate(project, input, idSequence(), { prepareText });
    const calls = prepareText.mock.calls.map(([faceId, text]) => canonicalJson([faceId, text]));
    expect(new Set(calls).size).toBe(calls.length);
    expect(prepareText.mock.calls.filter(([, text]) => text === "SAME")).toHaveLength(1);
    const same = packet.commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.text === "SAME" ? [command.graphic] : []);
    const layouts = same.map(graphic => packet.layouts.find(layout => layout.graphicId === graphic.id)!);
    expect(new Set(layouts.map(layout => layout.fontSize)).size).toBeGreaterThan(1);
    expect(new Set(layouts.map(layout => layout.sourceSignature)).size).toBe(same.length);
  });
  it("applies generated commands in one Undo step without changing the actual source windows", async () => {
    const { project, input } = fixture("comparison_pair"), before = canonicalJson(project);
    input.sources = [{ assetId: "asset-8", sourceStart: 5, label: "REPLACEMENT" }];
    const packet = await prepareReferenceMotionTemplate(project, input, idSequence(), dependencies());
    expect(packet.mediaBindings[1]).toMatchObject({ assetId: "asset-8", sourceStart: 5 });
    const history = dispatchCommand(createHistory(project), { type: "batch", commands: packet.commands }, "apply-template");
    expect(history.past).toHaveLength(1); expect(history.journal).toHaveLength(1);
    const restored = undo(history); expect(canonicalJson({ ...restored.present, revision: project.revision, updatedAt: project.updatedAt })).toBe(before);
  });
  it("derives strike endpoints from real TC glyph ink rather than estimated text widths", async () => {
    const { project, input } = fixture("strike_reframe"); input.title = "保留焦點"; input.previousText = "不要亂堆";
    input.style!.typography = { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" };
    const packet = await prepareReferenceMotionTemplate(project, input, idSequence(), dependencies());
    const previous = packet.commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.text === input.previousText ? [command.graphic] : [])[0];
    const layout = packet.layouts.find(row => row.graphicId === previous.id)!, strike = packet.commands.flatMap(command => command.type === "add_motion_graphic" && command.graphic.vectorV2?.kind === "rule" ? [command.graphic] : [])[0];
    expect(layout.physicalFont?.faceId).toBe("EditkinFace-noto-sans-tc-700");
    const left = Math.min(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMin));
    const right = Math.max(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMax));
    const top = Math.min(...layout.segments.map(segment => segment.y + segment.outline!.ink!.yMin));
    const bottom = Math.max(...layout.segments.map(segment => segment.y + segment.outline!.ink!.yMax));
    expect(strike.x * project.width).toBeCloseTo(left, 8); expect(strike.width * project.width).toBeCloseTo(right - left, 8);
    expect(strike.y * project.height).toBeCloseTo(top + (bottom - top) * .52, 8);
  });
  it("keeps every takeover hold fixed after true-font authoring and preserves exact source identity", async () => {
    const { project, input } = fixture("evidence_takeover"), packet = await prepareReferenceMotionTemplate(project, input, idSequence(), dependencies());
    const applied = applyCommand(project, { type: "batch", commands: packet.commands }), clip = applied.tracks[0].clips[0];
    for (const hold of packet.phases.filter(phase => phase.role === "hold")) {
      const first = animatedClipState(clip, hold.startFrame / project.fps).transform;
      for (let frame = hold.startFrame; frame < hold.endFrame; frame++) expect(animatedClipState(clip, frame / project.fps).transform).toEqual(first);
    }
    expect(clip.id).toBe("source-clip"); expect(clip.sourceStart).toBe(2); expect(packet.mediaBindings).toHaveLength(1);
  });
});
