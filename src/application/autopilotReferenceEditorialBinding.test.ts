import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { withReferenceMotionPhysicalFonts } from "../mcp/referenceMotionPhysicalFonts";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";
import { referenceMotionVisibleProjection, type ReferenceMotionPlan } from "./referenceMotionPlan";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { assertAutopilotProjectTimelineBinding, compactAutopilotContract, parseAutopilotPlan, type CurrentAutopilotPlan } from "./autopilotPlan";

type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;

function compactPlan(packet: Pick<Packet, "commands" | "editorialGraphics" | "instance">, declaration: ReferenceMotionPlan): CurrentAutopilotPlan {
  const base = parseAutopilotPlan(structuredClone(createAutopilotV4Fixture())) as CurrentAutopilotPlan;
  const commands: EditorCommand[] = [base.commands[0], ...structuredClone(packet.commands)];
  const referenceMotion = structuredClone(declaration);
  referenceMotion.instances.forEach(step => { step.commandIndexes = step.commandIndexes.map(index => index + 1); });
  const projected = referenceMotionVisibleProjection(referenceMotion, commands);
  const graphics = packet.editorialGraphics.filter(event => projected.some(command => command.type === "add_motion_graphic" && command.graphic.id === event.id)).map(event => {
    const { presetVariant: _variant, ...intent } = structuredClone(event);
    const role = packet.instance.roles.find(candidate => candidate.kind === "graphic" && candidate.id === event.id)!;
    const commandIndex = projected.findIndex(command => command.type === "add_motion_graphic" && command.graphic.id === event.id);
    return { ...intent, referenceMotionBinding: { schema: "editkin.reference-motion-editorial-binding/v1" as const,
      instanceId: packet.instance.id, roleKey: role.key, commandIndex } };
  });
  return { ...base, commands, referenceMotion, editorial: { ...base.editorial, graphics } };
}

describe("explicit compact reference editorial binding with independent physical authority", () => {
  let project: ReturnType<typeof createEmptyProject>, packet: Packet, plan: CurrentAutopilotPlan;
  let nextId = 0;
  const idFactory = (prefix: string) => `${prefix}-compact-${++nextId}`;
  beforeAll(async () => {
    project = createEmptyProject("Synthetic compact binding control", { id: "compact-control", width: 1080, height: 1920, fps: 30 });
    project.assets = [{ id: "source-asset", name: "Synthetic, no publication rights", kind: "video", uri: "D:/synthetic/compact.mp4",
      duration: 20, width: 1080, height: 1920 }];
    project.tracks[0].clips = [{ id: "source-clip", trackId: project.tracks[0].id, assetId: "source-asset", sourceStart: 2,
      timelineStart: 0, duration: 12, volume: .7, keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }];
    packet = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateInstance(project, {
      templateId: "level_bridge", clipId: "source-clip", startFrame: 0, durationFrames: 360,
      title: "FOCUS", kicker: "OWNED", subtitle: "STAY CLEAR", sources: [], purpose: "Synthetic exact compact binding control",
      evidenceRefs: ["synthetic:compact-control"], style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE),
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } },
    }, idFactory, dependencies));
    plan = compactPlan(packet, { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: packet.instance.id,
      mode: "create", commandIndexes: packet.commands.map((_, index) => index) }] });
  });

  it("keeps native commands intact, parses compact intent and independently verifies physical creation", async () => {
    const before = canonicalJson(project), commandBytes = canonicalJson(packet.commands);
    const parsed = parseAutopilotPlan(plan) as CurrentAutopilotPlan;
    expect(parsed.editorial.graphics.every(event => event.referenceMotionBinding && !event.presetVariant)).toBe(true);
    expect(parseAutopilotPlan(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(() => assertAutopilotProjectTimelineBinding(parsed, 30)).not.toThrow();
    await expect(verifyReferenceMotionPlan(parsed.referenceMotion, project, parsed.commands)).resolves.toMatchObject({ instanceCount: 1 });
    expect(canonicalJson(project)).toBe(before);
    expect(canonicalJson(parsed.commands.slice(1))).toBe(commandBytes);
  });

  it("requires the explicit current contract capability", () => {
    expect(compactAutopilotContract().motion.referenceInstances.editorialBinding).toMatchObject({
      schema: "editkin.reference-motion-editorial-binding/v1", planPath: "editorial.graphics[].referenceMotionBinding",
      requiresCompleteCompilerGroup: true, independentRecompileAt: ["audit", "apply"],
    });
  });

  it.each(["declaration", "instance", "role", "index", "preset"])("rejects an incorrect %s binding", key => {
    const changed = structuredClone(plan), event = changed.editorial.graphics[0];
    if (key === "declaration") delete changed.referenceMotion;
    else if (key === "instance") event.referenceMotionBinding!.instanceId = "unowned-instance";
    else if (key === "role") event.referenceMotionBinding!.roleKey = "unowned-role";
    else if (key === "index") event.referenceMotionBinding!.commandIndex = 0;
    else event.presetId = "unowned-preset";
    expect(() => parseAutopilotPlan(changed)).toThrow(/declaration|declared|role|preset/i);
  });

  it("does not let an outside compiler command borrow a declared role", () => {
    const changed = structuredClone(plan), event = changed.editorial.graphics[0];
    const source = changed.commands[event.referenceMotionBinding!.commandIndex];
    if (source.type !== "add_motion_graphic") throw new Error("Control requires a creation command");
    changed.commands.push({ type: "add_motion_graphic", graphic: { ...structuredClone(source.graphic), id: "outside-graphic" } });
    event.id = "outside-graphic"; event.referenceMotionBinding!.commandIndex = changed.commands.length - 1;
    expect(() => parseAutopilotPlan(changed)).toThrow(/declared/);
  });

  it("rejects duplicate graphic identity even when the declared command still exists", () => {
    const changed = structuredClone(plan), event = changed.editorial.graphics[0];
    changed.commands.push(structuredClone(changed.commands[event.referenceMotionBinding!.commandIndex]));
    expect(() => parseAutopilotPlan(changed)).toThrow(/exactly one/);
  });

  it("keeps custom stock-preset claims strict when the compact binding is absent", () => {
    const changed = structuredClone(plan);
    changed.editorial.graphics.forEach(event => { delete event.referenceMotionBinding; });
    expect(() => parseAutopilotPlan(changed)).toThrow(/preset/);
  });

  it("rejects dual bindings, unknown fields and caller approval flags", () => {
    const dual = structuredClone(plan);
    dual.editorial.graphics[0].presetVariant = structuredClone(packet.editorialGraphics[0].presetVariant);
    expect(() => parseAutopilotPlan(dual)).toThrow(/alternative/);
    const unknown = structuredClone(plan);
    Object.assign(unknown.editorial.graphics[0].referenceMotionBinding!, { approved: true });
    expect(() => parseAutopilotPlan(unknown)).toThrow();
  });

  it("still binds visible text and graphic kind", () => {
    const text = structuredClone(plan), event = text.editorial.graphics.find(row => row.kind !== "native_shape")!;
    event.message = "FORGED INTENT";
    expect(() => parseAutopilotPlan(text)).toThrow(/message/);
    const kind = structuredClone(plan);
    kind.editorial.graphics.find(row => row.kind === "title_card")!.kind = "context_card";
    expect(() => parseAutopilotPlan(kind)).toThrow(/原生 kind/);
  });

  it("checks compact event ranges against the live project fps", () => {
    const changed = structuredClone(plan);
    changed.editorial.graphics[0].range.endFrame -= 1;
    const parsed = parseAutopilotPlan(changed) as CurrentAutopilotPlan;
    expect(() => assertAutopilotProjectTimelineBinding(parsed, 30)).toThrow(/frame range/);
    expect(() => assertAutopilotProjectTimelineBinding(plan, 25)).toThrow(/frame range/);
  });

  it("retains physical v2 duration constraints without a presetVariant", () => {
    const changed = structuredClone(plan);
    const command = changed.commands[changed.editorial.graphics[0].referenceMotionBinding!.commandIndex];
    if (command.type !== "add_motion_graphic" || !command.graphic.motionV2) throw new Error("Control requires compiled v2 motion");
    command.graphic.motionV2.entrance.durationFrames = 599;
    const parsed = parseAutopilotPlan(changed) as CurrentAutopilotPlan;
    expect(() => assertAutopilotProjectTimelineBinding(parsed, 30)).toThrow(/時長|duration/);
  });

  it("treats parse success as provisional and rejects tampered visual commands at independent recompile", async () => {
    const changed = structuredClone(plan);
    const command = changed.commands[changed.editorial.graphics[0].referenceMotionBinding!.commandIndex];
    if (command.type !== "add_motion_graphic") throw new Error("Control requires compiled graphic");
    command.graphic.fontSize += 1;
    const parsed = parseAutopilotPlan(changed) as CurrentAutopilotPlan;
    await expect(verifyReferenceMotionPlan(parsed.referenceMotion, project, parsed.commands)).rejects.toThrow(/independently recompiled/);
  });

  it("rejects later external changes to the compiled result", async () => {
    const changed = structuredClone(plan), event = changed.editorial.graphics.find(row => row.kind !== "native_shape")!;
    changed.commands.push({ type: "update_motion_graphic", graphicId: event.id, patch: { text: "LATE FORGED" } });
    const parsed = parseAutopilotPlan(changed) as CurrentAutopilotPlan;
    await expect(verifyReferenceMotionPlan(parsed.referenceMotion, project, parsed.commands)).rejects.toThrow(/Later plan/);
  });

  it("physically recompiles a true revision with complete compact target commands", async () => {
    const current = applyCommand(project, { type: "batch", commands: packet.commands });
    const patch = { title: "KEEP FOCUS" };
    const revised = await withReferenceMotionPhysicalFonts(dependencies => prepareReferenceMotionTemplateRevision(current, packet.instance.id, patch,
      { ...dependencies, expectedInstanceRevision: 1, idFactory }));
    if (revised.status === "UNCHANGED") throw new Error("Control requires actual revision");
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: packet.instance.id,
      mode: "revise", expectedInstanceRevision: 1, patch, commandIndexes: revised.commands.map((_, index) => index) }] };
    const changed = compactPlan(revised, declaration), parsed = parseAutopilotPlan(changed) as CurrentAutopilotPlan;
    expect(() => assertAutopilotProjectTimelineBinding(parsed, 30)).not.toThrow();
    await expect(verifyReferenceMotionPlan(parsed.referenceMotion, current, parsed.commands)).resolves.toMatchObject({ instanceCount: 1 });
  });
});
