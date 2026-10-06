import { useId } from "react";
import type { EditProject, MotionDesignV3TemplateId, MotionGraphic } from "../domain/types";
import type { MotionGraphicV3Frame } from "../motion/compositionV3";
import { pathToSvg } from "../motion/v3/geometry";
import { baselineOffset } from "../motion/v3/textMetrics";
import type { V3Op } from "../motion/v3/types";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";

interface MotionV3GraphicProps {
  project: Pick<EditProject, "width" | "height">;
  graphic: MotionGraphic;
  template: MotionDesignV3TemplateId;
  frame: MotionGraphicV3Frame;
}

function OpElement({ op, width, height, clipId, blurId }: { op: V3Op; width: number; height: number; clipId: string; blurId: string }) {
  const filter = op.blur ? `url(#${blurId})` : undefined;
  const clipPath = op.clip ? `url(#${clipId})` : undefined;
  const defs = <>
    {op.clip && <clipPath id={clipId}><rect x={op.clip.x} y={op.clip.y} width={op.clip.width} height={op.clip.height} /></clipPath>}
    {op.blur && <filter id={blurId} filterUnits="userSpaceOnUse" x={-width} y={-height} width={width * 3} height={height * 3}><feGaussianBlur stdDeviation={op.blur} /></filter>}
  </>;
  if (op.kind === "shape") {
    return <>{defs}<path d={pathToSvg(op.path)} fill={op.color} fillOpacity={op.opacity} fillRule="nonzero" clipPath={clipPath} filter={filter} /></>;
  }
  const face = resolveBundledFontFace(op.fontFamily, op.fontWeight);
  const baseline = baselineOffset({ family: op.fontFamily, weight: op.fontWeight, size: op.fontSize, lineHeight: op.lineHeight });
  // Clip and blur stay in canvas space on the group; only the glyphs scale.
  return <>{defs}<g clipPath={clipPath} filter={filter}>
    <text x={0} y={baseline} transform={`translate(${op.x} ${op.y}) scale(${op.scale ?? 1})`} fill={op.color} fillOpacity={op.opacity}
      fontFamily={cssFontFamily(face?.fontFamily ?? op.fontFamily)} fontWeight={face?.fontWeight ?? op.fontWeight} fontSize={op.fontSize} letterSpacing={op.letterSpacing}>{op.text}</text>
  </g></>;
}

/** Draws a Motion Design v3 frame from the same draw ops the ASS export renders. */
export default function MotionV3Graphic({ project, graphic, template, frame }: MotionV3GraphicProps) {
  const scope = useId().replace(/[^A-Za-z0-9_-]/g, "");
  return <svg className="motion-graphic-v3" data-testid="motion-graphic-v3" data-motion-template={template} data-motion-preset={graphic.presetId}
    viewBox={`0 0 ${project.width} ${project.height}`} preserveAspectRatio="none" aria-hidden="true">
    {frame.ops.map((op, index) => <OpElement key={op.id} op={op} width={project.width} height={project.height} clipId={`${scope}-c${index}`} blurId={`${scope}-b${index}`} />)}
  </svg>;
}
