import type { EditProject, TimelineClip } from "../domain/types";
import type { RenderPlan } from "./planner";
import { escapeExpression } from "./ffmpegExpressions";
import { gradeWorkingSpace } from "../color/gradeV2";
import { timelineTransitionMixGraphV1 } from "./timelineTransitionMixV1";
import { timelineTransitionMatteStreamV1 } from "./timelineTransitionMatteV1";
import { timelineTransitionMatteMixGraphV1, timelineTransitionNativeAlphaOverV1, type TimelineTransitionMatteLutsV1 } from "./timelineTransitionMatteNativeV1";
import { compositeFrameClock } from "./compositeFrameClock";
import type { TimelineTransitionHandlePlanV1 } from "../domain/timelineTransitionHandlesV1";

/** FFmpeg inputs of one matte transition (ffmpegComposite adds them): the matte file, the synthetic overlay clip and the
 * kernel's LUT files for the project's working encoding. */
export interface TimelineTransitionMatteInputV1 { matteInputIndex: number; overlayClip?: TimelineClip; luts: TimelineTransitionMatteLutsV1 }

/**
 * One pair, transition window only. Every input is trimmed to the window first, so the per-pixel work scales with the
 * window, not the timeline. The from/to scenes are the native straight-alpha source-over of the layer stack. The kernel
 * is the native matte graph, or the dissolve/dip mix (timelineTransitionMixGraphV1, whose progress clock starts at the
 * first window frame). Outside the window the output is `keep` untouched: the window result is padded with transparent
 * ticks and selected by an exact 0/65535 mask.
 */
function pairWindowGraph(input: { keep: string; aBase: string; bBase: string; from: string; to: string; output: string; prefix: string;
  pair: TimelineTransitionHandlePlanV1; fps: number; duration: number; fromBlend: string; toBlend: string; space: ReturnType<typeof gradeWorkingSpace>;
  matte?: TimelineTransitionMatteInputV1; overlay?: { filters: string[]; label: string } }): string[] {
  const { prefix: p, pair: window } = input, frames = Math.ceil(input.duration * input.fps), clock = compositeFrameClock(input.fps);
  const trim = `trim=start_frame=${window.startFrame}:end_frame=${window.endFrame}`;
  const filters = [`[${input.aBase}]${trim}[${p}abasewin]`, `[${input.from}]${trim}[${p}fromwin]`, `[${input.bBase}]${trim}[${p}bbasewin]`, `[${input.to}]${trim}[${p}towin]`,
    ...timelineTransitionNativeAlphaOverV1(`${p}abasewin`, `${p}fromwin`, `${p}fromscene`, input.fromBlend),
    ...timelineTransitionNativeAlphaOverV1(`${p}bbasewin`, `${p}towin`, `${p}toscene`, input.toBlend)];
  if (window.transition.kernel === "matte") {
    if (!input.matte) throw Error("TIMELINE_TRANSITION_MATTE_SOURCE_MISSING");
    filters.push(timelineTransitionMatteStreamV1(input.matte.matteInputIndex, `${p}mattestream`, window, { fps: input.fps, duration: input.duration }));
    if (input.overlay) filters.push(...input.overlay.filters, `[${input.overlay.label}]${trim}[${p}overlaywin]`);
    filters.push(...timelineTransitionMatteMixGraphV1(`${p}fromscene`, `${p}toscene`, `${p}mattestream`, input.overlay ? `${p}overlaywin` : undefined, `${p}mixwin`, input.matte.luts));
  } else {
    filters.push(...timelineTransitionMixGraphV1(`${p}fromscene`, `${p}toscene`, `${p}mixwin`, { startFrame: 0, durationFrames: window.durationFrames },
      window.transition.kernel, input.space));
  }
  // Window frames → whole timeline: transparent ticks before and after; the mask is 65535 exactly on window frames.
  const pad = `${clock.timestampFilters},tpad=start=${window.startFrame}:stop=-1:start_mode=add:stop_mode=add:color=black@0,trim=end_frame=${frames},${clock.timestampFilters}`;
  filters.push(`[${p}mixwin]split[${p}mixcolour][${p}mixcover]`,
    `[${p}mixcover]format=rgba64le,lutrgb=r=65535:g=65535:b=65535:a=65535,format=gbrap16le,${pad}[${p}window]`,
    `[${p}mixcolour]${pad}[${p}mix]`,
    `[${input.keep}][${p}mix][${p}window]maskedmerge=planes=15,format=gbrap16le[${input.output}]`);
  return filters;
}

/**
 * The pair16 layer stack. Inputs are complete, styled straight-alpha canvases on the global frame clock. Each layer is
 * hidden outside its nominal range and inside its own pair windows by zeroing its alpha on those frames
 * (colorchannelmixer, enabled by frame number; RGB is untouched), then laid over the stack with the native 16-bit
 * source-over. Matte pairs also take their matte stream and, when the item draws one, the overlay styled through
 * `prepare` like any clip.
 */
export function timelineTransitionCompositeGraphV1(project: EditProject, plan: RenderPlan, clips: readonly TimelineClip[], prepare: (clip: TimelineClip, label: string) => string[], adjustment: (clip: TimelineClip, input: string, output: string) => string[],
  matteInputs?: ReadonlyMap<string, TimelineTransitionMatteInputV1>): { filters: string[]; compositeCount: number } {
  const pairs = plan.pairTransitions ?? [], filters: string[] = [], layers = new Map<string, string>(), endpoints = new Map<string, string>();
  const blend = (clip: TimelineClip): string => clip.layer?.blendMode ?? "normal";
  const active = new Set(clips.filter(c => (c.layer?.role ?? "content") === "content").map(c => c.id));
  for (const pair of pairs) if (!active.has(pair.from.clipId) || !active.has(pair.to.clipId)) throw Error("TIMELINE_TRANSITION_VISIBLE_SOURCE_REQUIRED");
  for (const [index, clip] of clips.entries()) {
    if ((clip.layer?.role ?? "content") !== "content") continue;
    const styled = `pairStyled${index}`, nominal = `pairNominal${index}`;
    filters.push(...prepare(clip, styled));
    const uses = pairs.flatMap((p, pairIndex) => p.from.clipId === clip.id ? [{ p, pairIndex, side: "from" }] : p.to.clipId === clip.id ? [{ p, pairIndex, side: "to" }] : []);
    const raw = `${nominal}raw`, branches = uses.map(u => `pairEndpoint${u.pairIndex}${u.side}`);
    filters.push(`[${styled}]${branches.length ? `split=${branches.length + 1}[${raw}]${branches.map(l => `[${l}]`).join("")}` : `null[${raw}]`}`);
    for (const [i, use] of uses.entries()) endpoints.set(`${use.pairIndex}:${use.side}`, branches[i]);
    const start = Math.round(clip.timelineStart * plan.fps), end = Math.round((clip.timelineStart + clip.duration) * plan.fps);
    const visible = `gte(n,${start})*lt(n,${end})${uses.map(u => `*(1-gte(n,${u.p.startFrame})*lt(n,${u.p.endFrame}))`).join("")}`;
    filters.push(`[${raw}]colorchannelmixer=aa=0:enable='${escapeExpression(`not(${visible})`)}'[${nominal}]`);
    layers.set(clip.id, nominal);
  }
  let count = 0;
  for (const clip of clips) {
    if (clip.layer?.role === "controller") continue;
    const before = `composite${count}`, after = `composite${++count}`;
    if (clip.layer?.role === "adjustment") { filters.push(...adjustment(clip, before, after)); continue; }
    const layer = layers.get(clip.id); if (!layer) throw Error("TIMELINE_TRANSITION_STYLED_SOURCE_MISSING");
    const incoming = pairs.findIndex(p => p.to.clipId === clip.id), nominalOut = incoming < 0 ? after : `${after}nominal`;
    filters.push(...timelineTransitionNativeAlphaOverV1(before, layer, nominalOut, blend(clip)));
    if (incoming < 0) continue;
    const pair = pairs[incoming], from = clips.find(c => c.id === pair.from.clipId)!;
    const keep = `${after}keep`, aBase = `${after}abase`, bBase = `${after}bbase`;
    filters.push(`[${nominalOut}]split=3[${keep}][${aBase}][${bBase}]`);
    let matte: TimelineTransitionMatteInputV1 | undefined, overlay: string | undefined;
    if (pair.transition.kernel === "matte") {
      matte = matteInputs?.get(pair.transition.id);
      if (!matte) throw Error("TIMELINE_TRANSITION_MATTE_SOURCE_MISSING");
      if (matte.luts.space !== gradeWorkingSpace(project.colorManagement)) throw Error("TIMELINE_TRANSITION_MATTE_LUT_SPACE_MISMATCH");
      overlay = matte.overlayClip ? `${after}overlaycanvas` : undefined;
    }
    filters.push(...pairWindowGraph({ keep, aBase, bBase, from: endpoints.get(`${incoming}:from`)!, to: endpoints.get(`${incoming}:to`)!, output: after,
      prefix: `${after}pair`, pair, fps: plan.fps, duration: plan.duration, fromBlend: blend(from), toBlend: blend(clip), space: gradeWorkingSpace(project.colorManagement),
      ...(matte ? { matte } : {}), ...(matte?.overlayClip && overlay ? { overlay: { filters: prepare(matte.overlayClip, overlay), label: overlay } } : {}) }));
  }
  return { filters, compositeCount: count };
}
