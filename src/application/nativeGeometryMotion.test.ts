import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { parseProject } from "./projectFiles";
import { prepareNativeGeometryMotion, type NativeGeometryMotionInput } from "./nativeGeometryMotion";
import { sampleSpringGeometryTrack } from "../motion/springGeometryTrack";
import { canonicalJson } from "../shared/canonicalJson";
import { motionCommandFamilies } from "./motionTreatment";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";

function fixture() {
  const project = parseProject(createDemoProject());
  const input: NativeGeometryMotionInput = { expectedRevision: project.revision,
    range: { startFrame: 30, endFrame: 150 }, position: { x: .1, y: .2 }, fixedEnvelope: { width: 400, height: 250 },
    initial: { left: 60, top: 70, right: 180, bottom: 170, cornerRadius: 16 },
    dynamics: { stiffness: 120, damping: 24, mass: 1 }, targets: [
      { property: "right", frame: 12, target: 320 }, { property: "bottom", frame: 18, target: 210 },
      { property: "left", frame: 24, target: 40 }, { property: "top", frame: 24, target: 50 },
      { property: "cornerRadius", frame: 36, target: 24 },
    ], purpose: "保留同一個流程節點，沿右緣擴展為下一段內容的容器", evidenceRefs: ["brief:process-node-expansion"] };
  return { project, input };
}

describe("original editable continuity authoring", () => {
  it("prepares without mutation and roundtrips one stable foreground geometry identity", async () => {
    const { project, input } = fixture(), original = structuredClone(project);
    const prepared = await prepareNativeGeometryMotion(project, input, () => "process-node");
    expect(project).toEqual(original); expect(prepared.status).toBe("PREPARED_NOT_APPLIED");
    expect(prepared.v4Binding).toMatchObject({ visibleFamily: "motion", graphicId: "process-node", createsGraphic: true });
    expect(prepared.v4Binding.visibleFamilies).toEqual(motionCommandFamilies(prepared.commands[0]));
    expect(prepared.v4Binding.visibleFamilies).toEqual(["cards", "motion"]);
    expect(prepared.commands).toHaveLength(1); expect(prepared.commands[0].type).toBe("add_motion_graphic");
    const creation = prepared.commands[0], variant = prepared.presetVariant;
    if (creation.type !== "add_motion_graphic" || !variant) throw new Error("fixture lost creation binding");
    expect(() => assertMotionPresetVariantBinding(creation.graphic, "reel_native_panel", variant)).not.toThrow();
    expect(prepared.editorialGraphics).toEqual([{ id: "process-node", presetId: "reel_native_panel", presetVariant: prepared.presetVariant,
      range: input.range, kind: "native_shape", purpose: "context", message: "", evidenceRefs: input.evidenceRefs }]);
    expect(prepared.invalidates.afterVectorSha256).toBe(createHash("sha256").update(canonicalJson(prepared.after)).digest("hex"));
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, prepared.commands[0]))));
    const graphic = reopened.motionGraphics.find(item => item.id === "process-node")!;
    expect(graphic.presetId).toBe("reel_native_panel"); expect(graphic.compositeLayer).toBe("foreground");
    expect(graphic.text).toBe(""); expect(graphic.backgroundColor).toBe("#175CD3");
    expect(graphic.motionV2?.entrance.opacity).toBe(1); expect(graphic.motionV2?.exit.opacity).toBe(1);
    expect(graphic.vectorV2?.kind).toBe("spring_panel");
    if (graphic.vectorV2?.kind !== "spring_panel") throw new Error("fixture lost continuity geometry");
    expect(graphic.vectorV2.geometry.localId).toBe(graphic.id);
    expect(graphic.vectorV2.geometry.right.fps).toBe(project.fps);
    expect(sampleSpringGeometryTrack(graphic.vectorV2.geometry, 11).geometry.width).toBe(120);
    expect(sampleSpringGeometryTrack(graphic.vectorV2.geometry, 70).geometry.width).toBeGreaterThan(270);
    expect(reopened.tracks).toEqual(project.tracks); expect(reopened.assets).toEqual(project.assets);
  });

  it("updates only vector data and preserves the fixed range, canvas and graphic identity", async () => {
    const { project, input } = fixture();
    const first = await prepareNativeGeometryMotion(project, input, () => "process-node");
    const current = applyCommand(project, first.commands[0]), before = structuredClone(current);
    const update = await prepareNativeGeometryMotion(current, { ...input, expectedRevision: current.revision, graphicId: "process-node",
      initial: { ...input.initial, cornerRadius: 12 }, targets: input.targets.map(event => event.property === "right" ? { ...event, target: 300 } : event) });
    expect(current).toEqual(before); expect(update.operation).toBe("update");
    expect(update.commands[0]).toMatchObject({ type: "update_motion_graphic", graphicId: "process-node" });
    if (update.commands[0].type !== "update_motion_graphic") throw new Error("fixture did not prepare update");
    expect(Object.keys(update.commands[0].patch)).toEqual(["vectorV2"]);
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(current, update.commands[0]))));
    const { vectorV2: _old, ...oldGraphic } = current.motionGraphics[0], { vectorV2: _new, ...newGraphic } = reopened.motionGraphics[0];
    expect(newGraphic).toEqual(oldGraphic); expect(update.invalidates.beforeVectorSha256).not.toBe(update.invalidates.afterVectorSha256);
    expect(update.v4Binding.createsGraphic).toBe(false);
    expect(update.v4Binding.visibleFamilies).toEqual(motionCommandFamilies(update.commands[0]));
    expect(update.v4Binding.visibleFamilies).toEqual(["motion"]);
    expect(update.editorialGraphics).toEqual([]); expect(update.presetVariant).toBeUndefined();
  });

  it("retains physical seconds and explicit property dynamics at a fractional project rate", async () => {
    const { project, input } = fixture(); project.fps = 29.97;
    const prepared = await prepareNativeGeometryMotion(project, { ...input, propertyDynamics: { right: { stiffness: 90, damping: 20, mass: 1 } } }, () => "fractional-node");
    if (prepared.after.kind !== "spring_panel") throw new Error("fixture lost geometry");
    expect(prepared.after.geometry.left.fps).toBe(29.97);
    expect(prepared.after.geometry.right.spring).toEqual({ stiffness: 90, damping: 20, mass: 1 });
    expect(prepared.after.geometry.left.spring).toEqual(input.dynamics);
  });

  it("rejects stale, missing, duplicate, foreign and no-op updates", async () => {
    const { project, input } = fixture();
    await expect(prepareNativeGeometryMotion(project, { ...input, expectedRevision: project.revision + 1 })).rejects.toThrow(/過期/);
    await expect(prepareNativeGeometryMotion(project, { ...input, graphicId: "missing" })).rejects.toThrow(/前景/);
    const first = await prepareNativeGeometryMotion(project, input, () => "process-node"), current = applyCommand(project, first.commands[0]);
    await expect(prepareNativeGeometryMotion(current, input, () => "process-node")).rejects.toThrow(/唯一/);
    await expect(prepareNativeGeometryMotion(current, { ...input, graphicId: "process-node" })).rejects.toThrow(/沒有任何變更/);
    for (const patch of [{ range: { startFrame: 31, endFrame: 151 } }, { position: { x: .11, y: .2 } },
      { fixedEnvelope: { width: 399, height: 250 } }, { fillColor: "#FFFFFF" }]) {
      await expect(prepareNativeGeometryMotion(current, { ...input, graphicId: "process-node", ...patch })).rejects.toThrow(/保留|填色/);
    }
  });

  it("fails closed on event budgets, ordering, range, invalid geometry and safe-area truncation", async () => {
    const { project, input } = fixture();
    await expect(prepareNativeGeometryMotion(project, { ...input, targets: Array.from({ length: 33 }, (_, frame) => ({ property: "right", frame, target: 300 })) })).rejects.toThrow();
    for (const targets of [[{ property: "right" as const, frame: 12, target: 300 }, { property: "right" as const, frame: 12, target: 320 }],
      [{ property: "right" as const, frame: 24, target: 300 }, { property: "right" as const, frame: 12, target: 320 }],
      [{ property: "right" as const, frame: 120, target: 300 }]]) {
      await expect(prepareNativeGeometryMotion(project, { ...input, targets })).rejects.toThrow();
    }
    await expect(prepareNativeGeometryMotion(project, { ...input, range: { startFrame: 30, endFrame: 31 } })).rejects.toThrow(/2 至 1800/);
    await expect(prepareNativeGeometryMotion(project, { ...input, initial: { ...input.initial, right: 50 } })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, initial: { ...input.initial, cornerRadius: 100 } })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, position: { x: .9, y: .2 } })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, dynamics: { stiffness: Infinity, damping: 24, mass: 1 } })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, purpose: " " })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, evidenceRefs: [] })).rejects.toThrow();
    await expect(prepareNativeGeometryMotion(project, { ...input, fixedEnvelope: { width: 16, height: 250 } })).rejects.toThrow(/畫布 1%/);
  });

  it("admits the existing 1% variant boundary without relaxing the saved geometry contract", async () => {
    const { project, input } = fixture(); project.width = 1600;
    const prepared = await prepareNativeGeometryMotion(project, { ...input, fixedEnvelope: { width: 16, height: 100 },
      initial: { left: 1, top: 1, right: 15, bottom: 99, cornerRadius: 1 }, targets: [] }, () => "small-node");
    const creation = prepared.commands[0], variant = prepared.presetVariant;
    if (creation.type !== "add_motion_graphic" || !variant) throw new Error("fixture lost binding");
    expect(creation.graphic.width).toBe(.01);
    expect(() => assertMotionPresetVariantBinding(creation.graphic, "reel_native_panel", variant)).not.toThrow();
  });
});
