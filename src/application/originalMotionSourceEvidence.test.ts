import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectFiles";
import type { EditorialPlan } from "./editorialPlan";
import type { OriginalMotionScene2dInput } from "./originalMotionScene2d";
import { originalMaterialEvidenceSchema, originalMotionSourceSetSchema, originalMotionCueEvidenceReference,
  prepareOriginalMotionSourceEvidence, assertOriginalMotionSourcePlanBinding, verifyOriginalMotionSourceEvidence,
  type OriginalMotionSourceEvidence, type OriginalMotionSourceRights, type OriginalMotionSourceSet } from "./originalMotionSourceEvidence";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const rights: OriginalMotionSourceRights = { origin: "self_authored", medium: "native_vector_and_glyph", contentKind: "authored_illustration",
  realityProof: false, importedReferenceMedia: false, declaration: "Original authored panel, text and focus targets; no imported reference media or reality claim." };
const faceId = "EditkinFace-bebas-neue-400";
let bytes: Uint8Array;
beforeAll(async () => { bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile))); });
const trueText = (face: string, text: string) => prepareGlyphRun(face, text, bytes);
function fixture(text = false) {
  const project = parseProject(createEmptyProject("Original source evidence", { width: 640, height: 360, fps: 30 }));
  const input: OriginalMotionScene2dInput = { expectedRevision: project.revision, sceneId: "source-scene", intent: "standalone_showcase",
    reason: "A self-authored object hands focus across exact authored frames", startFrame: 0, durationFrames: 90,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: text ? [{ id: "source-object", kind: "text", text: "FOCUS", typographyRole: "heading", fontWeight: 400,
      range: { startFrame: 0, endFrame: 90 }, xPixels: 100, yPixels: 80, widthPixels: 430, fontSize: 48, minFontSize: 32,
      maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text" }]
      : [{ id: "source-object", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 210, yPixels: 130,
        widthPixels: 220, heightPixels: 100, cornerRadiusPixels: 12, colorRole: "accent" }],
    semanticCues: [{ id: "introduce", frame: 0, purpose: "Introduce the authored object", graphicIds: ["source-object"], evidenceRefs: ["authoring:object"] },
      { id: "focus", frame: 20, purpose: "Hand focus to the authored object", graphicIds: ["source-object"], evidenceRefs: ["authoring:focus"], focus: { centerX: 330, centerY: 180, zoom: 1.02 } },
      { id: "hold", frame: 55, purpose: "Hold the authored object", graphicIds: ["source-object"], evidenceRefs: ["authoring:hold"], focus: { centerX: 320, centerY: 180, zoom: 1 } }] };
  return { project, input };
}
type Prepared = Awaited<ReturnType<typeof prepareOriginalMotionSourceEvidence>>;
function binding(prepared: Prepared) {
  const source = prepared.evidence;
  const editorial: Pick<EditorialPlan, "graphics" | "narrative"> = { graphics: prepared.preparation.editorialGraphics,
    narrative: { backbone: "An authored object with original focal handoff", setupPayoffs: [],
      beats: source.scene.semanticCues.map((cue, ordinal, cues) => ({ id: `beat-${ordinal}`, range: { startFrame: source.scene.startFrame + cue.frame,
        endFrame: source.scene.startFrame + (cues[ordinal + 1]?.frame ?? source.scene.durationFrames) },
        role: ordinal === 0 ? "promise" as const : ordinal === cues.length - 1 ? "payoff" as const : "build" as const,
        summary: cue.purpose, primaryFocus: cue.purpose, energy: .5,
        evidenceRefs: [originalMotionCueEvidenceReference(source.sourceSha256, cue.id)] })) } };
  const set: OriginalMotionSourceSet = { schema: "editkin.original-motion-source/v1", sources: [source] };
  return { set, editorial, commands: prepared.preparation.commands };
}
function reseal(source: OriginalMotionSourceEvidence): void {
  const { sourceSha256: _old, ...body } = source; source.sourceSha256 = hash(body);
}

describe("original source evidence from actual authoring and physical preparation", () => {
  it("creates a true vector source without material receipts or project mutation and re-verifies it", async () => {
    const { project, input } = fixture(), before = structuredClone(project), prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText });
    const { set, commands, editorial } = binding(prepared);
    expect(project).toEqual(before); expect(prepareText).not.toHaveBeenCalled();
    expect(originalMaterialEvidenceSchema.parse({ ...set, receipts: [] }).receipts).toEqual([]);
    expect(() => originalMaterialEvidenceSchema.parse({ ...set, receipts: [{ clipId: "invented" }] })).toThrow();
    expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).not.toThrow();
    expect(await verifyOriginalMotionSourceEvidence(set, project, commands, editorial)).toMatchObject({ state: "SOURCE_BOUND_REVIEW_REQUIRED", sourceCount: 1 });
    expect(prepared.preparation).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true });
    expect(parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands })))).motionScenes?.[0]).toEqual(prepared.evidence.scene);
  });

  it("uses the same guarded compiler for authored overlay without declaring observed footage", async () => {
    const { project, input } = fixture(); input.intent = "authored_overlay";
    const prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0), { set, commands, editorial } = binding(prepared);
    expect(prepared.evidence.authoring.intent).toBe("authored_overlay");
    expect(prepared.preparation.source).toMatchObject({ kind: "original_authored_graphics", existingMediaUntouched: true });
    expect(await verifyOriginalMotionSourceEvidence(set, project, commands, editorial)).toMatchObject({ sourceCount: 1 });
    // Media admission is owned by the parent v4 branch; this source does not manufacture one.
    expect(Object.keys(prepared.evidence)).not.toContain("materialId");
  });

  it("binds actual glyph, layout and compiled font identities without serializing glyph runs or bytes", async () => {
    const { project, input } = fixture(true), prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText });
    expect(prepareText).toHaveBeenCalledExactlyOnceWith(faceId, "FOCUS");
    const spec = bundledFontFaceSpec(faceId), graphic = prepared.evidence.graphicBindings[0];
    expect(graphic.physicalFont).toMatchObject({ faceId, fontSha256: spec.sha256, manifestSha256: spec.manifestSha256 });
    expect(graphic.layoutSha256).toMatch(/^[a-f0-9]{64}$/); expect(prepared.evidence.resources.outlineCodeUnits).toBeGreaterThan(0);
    const roundtrip = originalMotionSourceSetSchema.parse(JSON.parse(JSON.stringify(binding(prepared).set)));
    expect(JSON.stringify(roundtrip)).not.toContain('"glyphs"'); expect(JSON.stringify(roundtrip)).not.toContain('"bytes"');
    const { commands, editorial } = binding(prepared);
    expect(await verifyOriginalMotionSourceEvidence(roundtrip, project, commands, editorial, { prepareText: trueText })).toMatchObject({ graphicCount: 1 });
  });

  it("offsets all actual command and cue indexes into a larger flat plan", async () => {
    const { project, input } = fixture();
    const prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 1), { set, editorial } = binding(prepared);
    const commands: EditorCommand[] = [{ type: "set_aesthetic_system", aestheticSystem: project.aestheticSystem! }, ...prepared.preparation.commands];
    expect(prepared.evidence.commands.map(command => command.commandIndex)).toEqual([1, 2]);
    expect(prepared.preparation.v4Binding.semanticCues.map(cue => cue.commandIndexes)).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).not.toThrow();
  });

  it("requires explicit scene identity, current revision and exact original rights", async () => {
    const { project, input } = fixture(), missing = structuredClone(input); delete missing.sceneId;
    await expect(prepareOriginalMotionSourceEvidence(project, missing, rights, 0)).rejects.toThrow();
    await expect(prepareOriginalMotionSourceEvidence(project, { ...input, expectedRevision: 2 }, rights, 0)).rejects.toThrow(/stale/);
    for (const wrong of [{ ...rights, importedReferenceMedia: true }, { ...rights, realityProof: true }, { ...rights, declaration: "" }]) {
      await expect(prepareOriginalMotionSourceEvidence(project, input, wrong as OriginalMotionSourceRights, 0)).rejects.toThrow();
    }
  });

  it("rejects manifest tampering rather than trusting a carried caller checksum", async () => {
    const { project, input } = fixture(), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    const { set, commands, editorial } = binding(prepared); set.sources[0].rights.declaration += " altered";
    expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/manifest hash/);
  });

  it("rejects a resealed authoring camera or cue that no longer matches the actual scene", async () => {
    const { project, input } = fixture(), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    for (const camera of [true, false]) {
      const { set, commands, editorial } = binding(structuredClone(prepared)), source = set.sources[0];
      if (camera) source.authoring.camera.initial.centerX += 1; else source.authoring.semanticCues[1].frame += 1;
      source.authoringSha256 = hash(source.authoring); reseal(source);
      expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/camera|cue/);
    }
  });

  it("rejects actual command/index changes, nested batches and unbound scene commands", async () => {
    const { project, input } = fixture(), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    const { set, commands, editorial } = binding(prepared), changed = structuredClone(commands);
    if (changed[0].type !== "add_motion_graphic") throw new Error("fixture graphic missing"); changed[0].graphic.x += .001;
    expect(() => assertOriginalMotionSourcePlanBinding(set, changed, editorial)).toThrow(/command hash/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands].reverse(), editorial)).toThrow(/scene command|command hash/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [{ type: "batch", commands }], editorial)).toThrow(/flat/);
    const orphan = structuredClone(prepared.evidence.scene); orphan.id = "orphan-scene";
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands, { type: "add_motion_scene", scene: orphan }], editorial)).toThrow(/not source-bound/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands, { type: "delete_motion_scene", sceneId: orphan.id }], editorial)).toThrow(/add-only/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands, { type: "update_motion_graphic", graphicId: "source-object", patch: { text: "ALTERED" } }], editorial)).toThrow(/source-owned/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands, { type: "delete_motion_graphic", graphicId: "source-object" }], editorial)).toThrow(/source-owned/);
    expect(() => assertOriginalMotionSourcePlanBinding(set, [...commands, { type: "set_project_resolution", width: 1280, height: 720 }], editorial)).toThrow(/canvas|dimensions/);
  });

  it("binds graphic message, preset variant, frame range and canonical cue references exactly", async () => {
    const { project, input } = fixture(true), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText: trueText });
    for (const field of ["message", "range", "preset", "reference"] as const) {
      const { set, commands, editorial } = binding(structuredClone(prepared)), event = editorial.graphics[0];
      if (field === "message") event.message = "OTHER";
      if (field === "range") event.range.endFrame--;
      if (field === "preset") event.presetVariant!.overrides.fontSize = 47;
      if (field === "reference") event.evidenceRefs = ["authoring:focus"];
      expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/editorial graphic|graphic evidence/);
    }
  });

  it("requires every actual cue in its narrative beat and rejects foreign or wrong-time references", async () => {
    const { project, input } = fixture(), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    for (const mode of ["missing", "foreign", "time"] as const) {
      const { set, commands, editorial } = binding(structuredClone(prepared));
      if (mode === "missing") editorial.narrative.beats.pop();
      if (mode === "foreign") editorial.narrative.beats[0].evidenceRefs = [`original:${"a".repeat(64)}:cue:introduce`];
      if (mode === "time") editorial.narrative.beats[1].range.startFrame = 21;
      expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/every actual|foreign|beat frame/);
    }
  });

  it("never uses an authored illustration for proof even alongside a material-looking reference", async () => {
    const { project, input } = fixture(), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    for (const extra of [false, true]) {
      const { set, commands, editorial } = binding(structuredClone(prepared)); editorial.narrative.beats[1].role = "proof";
      if (extra) editorial.narrative.beats[1].evidenceRefs.push(`mi:${"a".repeat(64)}:${"b".repeat(64)}:cue:0`);
      expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/reality proof/);
    }
    const { set, commands, editorial } = binding(prepared); editorial.graphics[0].purpose = "identity";
    expect(() => assertOriginalMotionSourcePlanBinding(set, commands, editorial)).toThrow(/editorial graphic/);
  });

  it("recompiles true layout and safety instead of accepting a correctly resealed forged digest", async () => {
    const { project, input } = fixture(true), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText: trueText });
    for (const field of ["layout", "safety"] as const) {
      const { set, commands, editorial } = binding(structuredClone(prepared)), source = set.sources[0], old = source.sourceSha256;
      if (field === "layout") source.graphicBindings[0].layoutSha256 = "a".repeat(64); else source.preparedSafetySha256 = "a".repeat(64);
      reseal(source);
      for (const event of editorial.graphics) event.evidenceRefs = event.evidenceRefs.map(ref => ref.replace(old, source.sourceSha256));
      for (const beat of editorial.narrative.beats) beat.evidenceRefs = beat.evidenceRefs.map(ref => ref.replace(old, source.sourceSha256));
      await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { prepareText: trueText })).rejects.toThrow(/recompiled/);
    }
  });

  it("requires real factory glyph runs, current font bytes and exact catalog identities", async () => {
    const { project, input } = fixture(true), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText: trueText });
    const { set, commands, editorial } = binding(prepared);
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial)).rejects.toThrow(/FONT_BYTES_REQUIRED/);
    const run = await trueText(faceId, "FOCUS");
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { prepareText: async () => JSON.parse(JSON.stringify(run)) as PreparedGlyphRun })).rejects.toThrow();
    const wrong = bytes.slice(); wrong[100] ^= 1;
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { prepareText: (face, text) => prepareGlyphRun(face, text, wrong) })).rejects.toThrow(/SHA|bytes|字型/i);
  });

  it("rejects stale or unversioned project drift before and during asynchronous recompile", async () => {
    const { project, input } = fixture(true), prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { prepareText: trueText });
    const { set, commands, editorial } = binding(prepared);
    for (const revision of [true, false]) {
      const changed = structuredClone(project); if (revision) changed.revision++; else changed.name += " changed";
      await expect(verifyOriginalMotionSourceEvidence(set, changed, commands, editorial, { prepareText: trueText })).rejects.toThrow(/live project/);
    }
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { prepareText: async (face, text) => {
      project.name += " changed during prepare"; return trueText(face, text);
    } })).rejects.toThrow(/changed/);
  });

  it("requires an exact fresh producer-file descriptor for file-bound evidence", async () => {
    const { project, input } = fixture();
    // The source I/O suite supplies real files. This tests the trusted-runtime boundary only.
    const descriptor = { sourcePath: ".editkin/original-sources/unit.json", sourceSha256: hash(input), sourcePayloadSha256: hash(input), bytes: Buffer.byteLength(canonicalJson(input)) };
    const prepared = await prepareOriginalMotionSourceEvidence(project, input, rights, 0, { authoringSource: descriptor });
    const { set, commands, editorial } = binding(prepared);
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial)).rejects.toThrow(/full-byte read/);
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { authoringSource: { ...descriptor, sourceSha256: "c".repeat(64) } })).rejects.toThrow(/current authoring file/);
    expect(await verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { resolveAuthoringSource: async () => descriptor })).toMatchObject({ sourceCount: 1 });
    let reads = 0;
    await expect(verifyOriginalMotionSourceEvidence(set, project, commands, editorial, { resolveAuthoringSource: async () =>
      ++reads === 1 ? descriptor : { ...descriptor, sourceSha256: "d".repeat(64) } })).rejects.toThrow(/current authoring file after preparation/);
    expect(reads).toBe(2);
  });

  it("admits separate source objects while rejecting duplicate ownership and aggregate budgets", async () => {
    const { project, input } = fixture(), first = await prepareOriginalMotionSourceEvidence(project, input, rights, 0);
    const secondInput = structuredClone(input); secondInput.sceneId = "second-scene"; secondInput.elements[0].id = "second-object";
    secondInput.semanticCues.forEach(cue => { cue.graphicIds = ["second-object"]; });
    const second = await prepareOriginalMotionSourceEvidence(project, secondInput, rights, 2), one = binding(first), two = binding(second);
    const set: OriginalMotionSourceSet = { schema: one.set.schema, sources: [first.evidence, second.evidence] }, commands = [...one.commands, ...two.commands];
    const editorial = { graphics: [...one.editorial.graphics, ...two.editorial.graphics], narrative: { ...one.editorial.narrative,
      beats: one.editorial.narrative.beats.map((beat, ordinal) => ({ ...beat, evidenceRefs: [...beat.evidenceRefs, ...two.editorial.narrative.beats[ordinal].evidenceRefs] })) } };
    expect(await verifyOriginalMotionSourceEvidence(set, project, commands, editorial)).toMatchObject({ sourceCount: 2, graphicCount: 2 });
    expect(() => assertOriginalMotionSourcePlanBinding({ ...set, sources: [first.evidence, first.evidence] }, commands, editorial)).toThrow(/indexes|identities/);
    const over = structuredClone(one.set); over.sources[0].resources.outlineCodeUnits = 8 * 1024 * 1024; over.sources.push(structuredClone(over.sources[0]));
    expect(() => assertOriginalMotionSourcePlanBinding(over, commands, editorial)).toThrow(/aggregate/);
    await expect(prepareOriginalMotionSourceEvidence(project, input, rights, 99)).rejects.toThrow(/100-command/);
    expect(() => originalMotionSourceSetSchema.parse({ ...one.set, unexpected: true })).toThrow();
  });
});
