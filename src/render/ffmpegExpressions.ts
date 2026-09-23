import { haoExpressionToFfmpeg } from "../domain/expression";
import { ANIMATION_TIME_EPSILON, clipAnimationPoints } from "../domain/clipAnimation";
import type { ColorAdjustments, EditProject, KeyframeEasing, MediaAsset, TimelineClip, Transform2D } from "../domain/types";

export function finite(value: number): string {
  if (!Number.isFinite(value)) throw new Error("render value 必須是有限數字");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Time values cannot use six-decimal display rounding: 2/30 rounded upward
 * would postpone an exact Hold boundary by one output frame. */
export function animationTimeValue(value: number): string {
  if (!Number.isFinite(value)) throw new Error("animation time 必須是有限數字");
  return String(value);
}

export function escapeExpression(expression: string): string {
  return expression.replaceAll(",", "\\,");
}

function easingExpression(variable: string, easing: KeyframeEasing): string {
  if (easing === "hold") return "0";
  if (easing === "ease_in") return `(${variable})*(${variable})`;
  if (easing === "ease_out") return `1-(1-(${variable}))*(1-(${variable}))`;
  if (easing === "ease_in_out") return `if(lt(${variable},0.5),2*(${variable})*(${variable}),1-pow(-2*(${variable})+2,2)/2)`;
  if (easing === "spring_soft") return `min(1.08,max(0,1-exp(-6*(${variable}))*cos(8*(${variable}))))`;
  return variable;
}

function transformExpression(
  clip: TimelineClip,
  property: keyof Transform2D,
  variable: string,
  timeOffset = 0,
  fps = 30,
): string {
  // A controller can start after or end before its child. Preview holds its
  // endpoint state outside that local interval; export must not extrapolate.
  const local = `min(${animationTimeValue(clip.duration)},max(0,(${variable})-${animationTimeValue(timeOffset)}))`;
  let expression = finite(clip.transform[property]);
  if (clip.keyframes.length === 0) {
    expression = finite(clip.transform[property]);
  } else {
    const points = clipAnimationPoints(clip).map(point => ({ time: point.time, value: point.transform[property], easing: point.easing }));
    expression = finite(points.at(-1)!.value);
    // Keyframes contain complete transforms even when only color/x/y changed.
    // Fold each unchanged channel independently before composing the hierarchy.
    const constant = points.every(point => point.value === points[0].value);
    for (let index = constant ? -1 : points.length - 2; index >= 0; index -= 1) {
      const current = points[index];
      const next = points[index + 1];
      const start = animationTimeValue(current.time);
      const end = animationTimeValue(next.time);
      const unit = `max(0,min(1,(${local}-${start})/${animationTimeValue(next.time - current.time)}))`;
      const value = current.easing === "hold"
        ? finite(current.value)
        : `${finite(current.value)}+(${finite(next.value - current.value)})*(${easingExpression(unit, current.easing)})`;
      expression = `if(lt((${local})+${ANIMATION_TIME_EPSILON},${end}),${value},${expression})`;
    }
  }
  const source = clip.expressions?.[property];
  if (!source) return expression;
  const ramp = Math.min(0.28, Math.max(1 / fps, clip.duration / 3));
  return haoExpressionToFfmpeg(source, {
    frame: `floor((${local})*${animationTimeValue(fps)}+0.5)`, fps: animationTimeValue(fps), time: local, inPoint: "0", outPoint: animationTimeValue(clip.duration),
    duration: animationTimeValue(clip.duration), value: expression,
    entrance: `min(1,max(0,(${local})/${animationTimeValue(ramp)}))`, exit: `min(1,max(0,(${animationTimeValue(clip.duration)}-(${local}))/${animationTimeValue(ramp)}))`,
  });
}

interface TransformExpressions {
  x: string;
  y: string;
  scale: string;
  rotation: string;
  opacity: string;
}

// Only fold finite numeric literals; never evaluate user expressions as JS.
function numericLiteral(expression: string): number | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(expression)) return undefined;
  const value = Number(expression);
  return Number.isFinite(value) ? value : undefined;
}

function combineExpression(a: string, b: string, operator: "+" | "*"): string {
  const left = numericLiteral(a), right = numericLiteral(b);
  if (left !== undefined && right !== undefined) return finite(operator === "+" ? left + right : left * right);
  if (operator === "+") { if (a === "0") return b; if (b === "0") return a; }
  else { if (a === "1") return b; if (b === "1") return a; }
  return `(${a})${operator}(${b})`;
}

export function composedTransformExpressions(
  project: EditProject,
  clip: TimelineClip,
  projectTime: string,
  fps: number,
  visiting = new Set<string>(),
): TransformExpressions {
  if (visiting.has(clip.id)) throw new Error(`圖層 parenting 循環：${clip.id}`);
  const local: TransformExpressions = {
    x: transformExpression(clip, "x", projectTime, clip.timelineStart, fps),
    y: transformExpression(clip, "y", projectTime, clip.timelineStart, fps),
    scale: transformExpression(clip, "scale", projectTime, clip.timelineStart, fps),
    rotation: transformExpression(clip, "rotation", projectTime, clip.timelineStart, fps),
    opacity: transformExpression(clip, "opacity", projectTime, clip.timelineStart, fps),
  };
  const parentId = clip.layer?.parentClipId;
  if (!parentId) return local;
  const parent = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === parentId);
  if (!parent) throw new Error(`找不到父圖層：${parentId}`);
  const next = new Set(visiting);
  next.add(clip.id);
  const parentTransform = composedTransformExpressions(project, parent, projectTime, fps, next);
  const radians = `((${parentTransform.rotation})*PI/180)`;
  return {
    x: `(${parentTransform.x})+((${local.x})*(${parentTransform.scale})*cos(${radians}))-((${local.y})*(${parentTransform.scale})*sin(${radians}))`,
    y: `(${parentTransform.y})+((${local.x})*(${parentTransform.scale})*sin(${radians}))+((${local.y})*(${parentTransform.scale})*cos(${radians}))`,
    scale: combineExpression(parentTransform.scale, local.scale, "*"),
    rotation: combineExpression(parentTransform.rotation, local.rotation, "+"),
    opacity: combineExpression(parentTransform.opacity, local.opacity, "*"),
  };
}

export function colorExpression(clip: TimelineClip, property: keyof ColorAdjustments, variable = "t"): string {
  if (clip.keyframes.length === 0) return finite(clip.color[property]);
  const local = `min(${animationTimeValue(clip.duration)},max(0,(${variable})))`;
  const points = clipAnimationPoints(clip).map(point => ({ time: point.time, value: point.color[property], easing: point.easing }));
  if (points.every(point => point.value === points[0].value)) return finite(points[0].value);
  let expression = finite(points.at(-1)!.value);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const current = points[index];
    const next = points[index + 1];
    const start = animationTimeValue(current.time);
    const end = animationTimeValue(next.time);
    const unit = `max(0,min(1,(${local}-${start})/${animationTimeValue(next.time - current.time)}))`;
    const value = current.easing === "hold"
      ? finite(current.value)
      : `${finite(current.value)}+(${finite(next.value - current.value)})*(${easingExpression(unit, current.easing)})`;
    expression = `if(lt((${local})+${ANIMATION_TIME_EPSILON},${end}),${value},${expression})`;
  }
  return expression;
}

export function hasPrimaryToneAdjustment(color: ColorAdjustments): boolean {
  return color.temperature !== 0
    || color.tint !== 0
    || color.pivot !== 0.5
    || color.shadows !== 0
    || color.highlights !== 0
    || color.blacks !== 0
    || color.whites !== 0;
}

export function ffmpegBlendMode(mode: Exclude<NonNullable<TimelineClip["layer"]>["blendMode"], "normal">): string {
  const modes: Record<typeof mode, string> = {
    add: "addition", screen: "screen", multiply: "multiply", overlay: "overlay", soft_light: "softlight", hard_light: "hardlight",
    difference: "difference", darken: "darken", lighten: "lighten", color_dodge: "dodge", color_burn: "burn",
  };
  return modes[mode];
}

export function ffmpegBlendNeutral(mode: Exclude<NonNullable<TimelineClip["layer"]>["blendMode"], "normal">): string {
  if (["multiply", "darken", "color_burn"].includes(mode)) return "white";
  if (["overlay", "soft_light", "hard_light"].includes(mode)) return "gray";
  return "black";
}

export function sourceAlphaNormalizationFilters(asset: MediaAsset, opaqueMaximum = 255): string[] {
  if (asset.alphaMode === "premultiplied") return ["unpremultiply=inplace=1"];
  if (asset.alphaMode === "opaque") return [`lut=a=${opaqueMaximum}`];
  return [];
}
