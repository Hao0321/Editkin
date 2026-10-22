import type { ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import type { ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";
import type { DesignContext, DesignMotion } from "./referenceMotionDesignThemes";
import { graphicPosterRangeV3Schema } from "../domain/graphicPosterRangeV3";
import type { MotionGraphic } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";

interface PosterScope { throughFrame: number; operations: Set<string>; authored: Map<string, MotionGraphic> }
const scopes = new WeakMap<object, PosterScope>();

/** A private compiler scope, mirroring the existing poster primitives without changing their default output. */
export function graphicPosterContextV3(context: DesignContext, options: ReferenceMotionTemplateCompileOptions): DesignContext {
  const scope = scopes.get(options);
  if (!scope) return context;
  const active = (role: string, start = 0) => {
    if (start > scope.throughFrame || /(?:^|:)return(?:$|:)/.test(role)) return false;
    scope.operations.add(role); return true;
  };
  const held = (motion?: DesignMotion): DesignMotion => {
    const base = motion ?? context.still(), entrance = base.entrance;
    // An already visible settle remains alive, including the pose a looping card returns to.
    const visible = entrance.opacity === 1 && entrance.scale === 1 && !(entrance.rotationDegrees || entrance.blurPixels || entrance.spreadPixels);
    return { ...base, sequence: { ...base.sequence, staggerFrames: 0 },
      entrance: visible ? entrance : context.still().entrance };
  };
  // The kit uses returned graphics to schedule later counts, accents and cards. Preserve those authored planning
  // clocks while the actual commands/layouts emitted by context are complete on frame zero.
  const planned = (role: string, graphic: MotionGraphic): MotionGraphic => {
    const original = scope.authored.get(role);
    return original ? { ...graphic, timelineStart: original.timelineStart, motionV2: original.motionV2 } : graphic;
  };
  return { ...context,
    add: (role, preset, text, overrides, start, end) => active(role, start)
      ? planned(role, context.add(role, preset, text, { ...overrides, motionV2: held(overrides.motionV2),
        ...(overrides.vectorV2 ? { vectorV2: { ...overrides.vectorV2, revealFrames: 1 } } : {}) }, 0, end))
      : context.add(role, preset, text, overrides, start, end),
    line: (role, text, spec, x, width, inkTop, motion, start, end, extra) => active(role, start)
      ? planned(role, context.line(role, text, spec, x, width, inkTop, held(motion), 0, end, extra))
      : context.line(role, text, spec, x, width, inkTop, motion, start, end, extra),
    panel: (role, x, y, width, height, radius, color, layer, start, end, extra = {}) => active(role, start)
      ? planned(role, context.panel(role, x, y, width, height, radius, color, layer, 0, end, { ...extra, motionV2: held(extra.motionV2) }))
      : context.panel(role, x, y, width, height, radius, color, layer, start, end, extra),
    shape: (role, commands, color, layer, start, end, extra = {}) => active(role, start)
      ? planned(role, context.shape(role, commands, color, layer, 0, end, { ...extra, revealFrames: 1, motionV2: held(extra.motionV2) }))
      : context.shape(role, commands, color, layer, start, end, extra),
    stroke: (role, commands, color, start, end, extra) => active(role, start)
      ? planned(role, context.stroke(role, commands, color, 0, end, { ...extra, revealFrames: 1, motionV2: held(extra.motionV2) }))
      : context.stroke(role, commands, color, start, end, extra),
    inline: (role, runs, spec, x, width, inkTop, motionFor, start, end, extra) => {
      if (!active(role, start)) return context.inline(role, runs, spec, x, width, inkTop, motionFor, start, end, extra);
      const { heldFrom: _held, ...rest } = extra ?? {};
      return context.inline(role, runs, spec, x, width, inkTop, text => held(motionFor(text)), 0, end,
        { ...rest, runStarts: runs.map(() => 0) }).map((graphic, index) => planned(`${role}:${index}`, graphic));
    },
    count: (role, text, spec, x, width, inkTop, motion, start, end, steps, from) => active(role, start)
      ? [planned(role, context.line(role, text, spec, x, width, inkTop, held(motion), 0, end))]
      : context.count(role, text, spec, x, width, inkTop, motion, start, end, steps, from),
    animate: (role, clip, points) => {
      const appear = points.find(point => point.key === "appear"), settled = points.find(point => point.key === "settled");
      if (!appear || !settled || !active(role, appear.frame)) return context.animate(role, clip, points);
      context.animate(role, clip, points.map(point => point.frame <= settled.frame
        ? { ...point, transform: { ...settled.transform } } : point));
    },
  };
}

interface Packet { phases: Array<{ role: string; startFrame: number; endFrame: number }>;
  commands: EditorCommand[]; layouts: MotionGraphicV2LayoutReceipt[];
  bindings: Array<{ graphic: MotionGraphic; startFrame: number; endFrame: number }>; roles?: Array<{ id: string; key: string }>;
  beats?: Array<{ roleKeys: string[] }> }
export interface GraphicPosterRangeReceiptV3 {
  schema: "editkin.graphic-poster-range-receipt/v3";
  applied: boolean;
  throughFrame?: number;
  omittedPreludeRoles?: string[];
  operations: string[];
  certification: "ART_PENDING_CLAUDE";
}

/** The first authored hold determines the finished card; preludes that already left do not share its poster. */
export function compileGraphicPosterPacketV3<T extends Packet>(input: ReferenceMotionTemplateInput,
  options: ReferenceMotionTemplateCompileOptions, compile: () => T): T & { graphicPosterV3Receipt: GraphicPosterRangeReceiptV3 } {
  graphicPosterRangeV3Schema.parse(input.posterV3);
  const original = compile();
  if (input.startFrame !== 0) return { ...original, graphicPosterV3Receipt: {
    schema: "editkin.graphic-poster-range-receipt/v3", applied: false, operations: [], certification: "ART_PENDING_CLAUDE" } };
  const first = [...original.phases].filter(phase => phase.endFrame > phase.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)[0];
  if (!first) throw Object.assign(new Error("首幀卡片需要既有的第一段揭示或停留範圍。"), { code: "GRAPHIC_POSTER_RANGE" });
  const firstHold = [...original.phases].filter(phase => phase.role === "hold" && phase.endFrame > phase.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame)[0];
  const throughFrame = firstHold?.startFrame ?? first.endFrame - 1;
  const ids = new Map(original.roles?.map(role => [role.id, role.key]));
  const omitted = new Set(original.bindings.filter(binding =>
    binding.startFrame <= throughFrame && binding.endFrame <= throughFrame)
    .map(binding => ids.get(binding.graphic.id)!).filter(Boolean));
  const scope = { throughFrame, operations: new Set<string>(),
    authored: new Map(original.bindings.map(binding => [ids.get(binding.graphic.id)!, binding.graphic])) }, previous = scopes.get(options);
  scopes.set(options, scope);
  try {
    const packet = compile();
    const hidden = new Set(packet.roles?.filter(role => omitted.has(role.key)).map(role => role.id));
    return Object.assign(packet, {
      commands: packet.commands.filter(command => command.type !== "add_motion_graphic" || !hidden.has(command.graphic.id)),
      bindings: packet.bindings.filter(binding => !hidden.has(binding.graphic.id)),
      layouts: packet.layouts.filter(layout => !hidden.has(layout.graphicId)),
      ...(packet.roles ? { roles: packet.roles.filter(role => !hidden.has(role.id)) } : {}),
      ...(packet.beats ? { beats: packet.beats.map(beat => ({ ...beat, roleKeys: beat.roleKeys.filter(key => !omitted.has(key)) })) } : {}),
      graphicPosterV3Receipt: { schema: "editkin.graphic-poster-range-receipt/v3" as const, applied: true,
        throughFrame: scope.throughFrame, omittedPreludeRoles: [...omitted].sort(),
        operations: [...scope.operations].filter(role => !omitted.has(role)).sort(), certification: "ART_PENDING_CLAUDE" as const } });
  } finally {
    if (previous) scopes.set(options, previous); else scopes.delete(options);
  }
}
