import { escapeExpression } from "./ffmpegExpressions";
import { blendKernelColourGraphV1, isBlendModeV1, type NonNormalBlendModeV1 } from "./blendKernelV1";

function label(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) throw Error("Invalid internal16-bit alpha label");
  return value;
}

/** Straight-alpha source-over, rounded once into the16-bit working surface. A blend mode's colour comes from the blend kernel. */
export function aces16AlphaOverGraphV1(base: string, foreground: string, output: string, mode: string = "normal"): string[] {
  label(base); label(foreground); label(output);
  if (!isBlendModeV1(mode)) throw Error("Invalid internal16-bit blend mode");
  const prefix = `${output}straight16`, planes = `${prefix}planes`, chains: string[] = [];
  const columns = mode === "normal" ? 2 : 3;
  if (columns === 2) {
    chains.push(`[${base}][${foreground}]hstack=inputs=2[${planes}]`);
  } else {
    const background = `${prefix}background`, backgroundBlend = `${prefix}backgroundBlend`;
    const layer = `${prefix}layer`, layerBlend = `${prefix}layerBlend`, blended = `${prefix}blended`;
    chains.push(`[${base}]split[${background}][${backgroundBlend}]`, `[${foreground}]split[${layer}][${layerBlend}]`);
    chains.push(...blendKernelColourGraphV1(backgroundBlend, layerBlend, blended, mode as NonNormalBlendModeV1, 16));
    chains.push(`[${background}][${layer}][${blended}]hstack=inputs=3[${planes}]`);
  }
  const setup = `st(0,alpha(X+W/${columns},Y)/65535);st(1,alpha(X,Y)/65535);st(2,ld(0)+ld(1)*(1-ld(0)));`;
  const rgb = (channel: string) => {
    const source = `${channel}(X+W/${columns},Y)`;
    // Blend colour applies only where the background has coverage. A fully
    // transparent background must retain the foreground's original colour.
    const blended = columns === 2 ? source : `((1-ld(1))*${source}+ld(1)*${channel}(X+2*W/${columns},Y))`;
    return setup + `if(eq(ld(2),0),0,floor(clip((${blended}*ld(0)+${channel}(X,Y)*ld(1)*(1-ld(0)))/ld(2),0,65535)+0.5))`;
  };
  const alpha = setup + "floor(clip(ld(2)*65535,0,65535)+0.5)";
  const quote = (expression: string) => `'${escapeExpression(expression)}'`;
  chains.push(`[${planes}]geq=r=${quote(rgb("r"))}:g=${quote(rgb("g"))}:b=${quote(rgb("b"))}:a=${quote(alpha)}:interpolation=nearest,crop=w=iw/${columns}:h=ih:x=0:y=0,format=gbrap16le[${output}]`);
  return chains;
}
