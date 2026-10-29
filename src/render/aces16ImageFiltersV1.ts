import type { ResolvedFinishingV2 } from "../color/gradeV2";
import type { GradeWorkingSpace } from "../color/gradeV2Color";
import { gradeV2SpatialChains } from "../color/gradeV2Ffmpeg";
import { escapeExpression } from "./ffmpegExpressions";
import { aces16FilterOptionsV1, aces16PerspectiveFilterV1 } from "./aces16PerspectiveV1";

const projectTime = (value: string) => value.replace(/\bt\b/g, "T").replace(/\bn\b/g, "N");
const q = (value: string) => `'${escapeExpression(value)}'`;

/** Keep the photographic plane and its alpha at16 bits, including float LUT ingress. */
export function aces16SurfaceFilterV1(filter: string): string {
  const converted = filter.replace(/format=(?:rgba|argb|bgra|abgr|rgb24|bgr24|gbrp|gbrap)(?=[,;\[]|$)/g, "format=gbrap16le")
    .replace(/format=gbrpf32le(?=[,;\[]|$)/g, "format=gbrapf32le")
    .replaceAll("alpha(X,Y)/255", "alpha(X,Y)/65535")
    .replaceAll("a='255*", "a='65535*");
  // The bundled scaler corrupts part of GBR16→GBRA16 with automatic slice
  // threading. Limit this conversion/resize only; other filters stay parallel.
  const adapt = (token: string) => {
    const input = /^(?:\[[^\]]+\])*/.exec(token)![0], output = /(?:\[[^\]]+\])*$/.exec(token)![0];
    if (input.length === token.length) return token;
    let filter = token.slice(input.length, output ? -output.length : undefined);
    // Only declared opaque media generates this source LUT, before padding,
    // keying, masks and geometry introduce transparency. The bundled LUT
    // maps full alpha to65280; GEQ preserves the16-bit photographic plane.
    if (filter === "lut=a=65535") filter = "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a=65535:interpolation=nearest";
    if (filter.startsWith("scale=")) filter = /:threads=\d+(?=:|$)/.test(filter)
      ? filter.replace(/:threads=\d+(?=:|$)/, ":threads=1") : filter + ":threads=1";
    return input + filter + output;
  };
  let result = "", begin = 0, quote = "", escaped = false;
  for (let i = 0; i < converted.length; i += 1) {
    const character = converted[i];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "," || character === ";") { result += adapt(converted.slice(begin, i)) + character; begin = i + 1; }
  }
  return result + adapt(converted.slice(begin));
}

/** Same full-range integer colour operations, with a16-bit YUV surface instead of eq/hue's8/10-bit admission. */
export function aces16ColourFiltersV1(filter: string): string[] {
  const eq = filter.startsWith("eq="), hue = filter.startsWith("hue=");
  if (!eq && !hue) throw Error("Expected an internal eq or hue filter");
  const o = aces16FilterOptionsV1(filter.slice(eq ? 3 : 4));
  const allowed = new Set(eq ? ["brightness", "contrast", "saturation", "eval", "enable"] : ["h", "H", "s", "b", "enable"]);
  if (Object.keys(o).some(k => !allowed.has(k))) throw Error("Unsupported internal16-bit colour operation");
  if (eq && o.eval && !["init", "frame", "0", "1"].includes(o.eval)) throw Error("Invalid internal colour evaluation clock");
  const expression = (v: string) => eq && o.eval !== "frame" && o.eval !== "1"
    ? projectTime(v).replace(/\b(?:T|N)\b/g, "0") : projectTime(v);
  const y = "lum(X,Y)", u = "(cb(X,Y)-32768)", v = "(cr(X,Y)-32768)";
  let luminance: string, blue: string, red: string;
  if (eq) {
    luminance = `clip((${y}-32768)*(${expression(o.contrast ?? "1")})+32768+65535*(${expression(o.brightness ?? "0")}),0,65535)`;
    const saturation = expression(o.saturation ?? "1");
    blue = `clip(${u}*(${saturation})+32768,0,65535)`;
    red = `clip(${v}*(${saturation})+32768,0,65535)`;
  } else {
    const angle = o.H ? `(${expression(o.H)})` : `((${expression(o.h ?? "0")})*PI/180)`;
    const saturation = expression(o.s ?? "1");
    luminance = `clip(${y}+65535*(${expression(o.b ?? "0")}),0,65535)`;
    blue = `clip((${u}*cos(${angle})-${v}*sin(${angle}))*(${saturation})+32768,0,65535)`;
    red = `clip((${v}*cos(${angle})+${u}*sin(${angle}))*(${saturation})+32768,0,65535)`;
  }
  return ["format=yuva444p16le", `geq=lum=${q(luminance)}:cb=${q(blue)}:cr=${q(red)}:a='alpha(X,Y)':interpolation=nearest`, "format=gbrap16le"];
}

function internalLabel(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) throw Error("Invalid internal16-bit image label");
  return value;
}

/** Compile split image operations without ever sending the photographic branch through an8-bit drawing filter. */
export function aces16ImageFilterChainsV1(input: string, output: string, filters: readonly string[], prefix: string): string[] {
  internalLabel(input); internalLabel(output); internalLabel(prefix);
  const chains: string[] = [];
  let current = input, pending: string[] = [], index = 0, associated = false;
  const next = () => `${prefix}${index++}`;
  const flush = () => {
    if (!pending.length) return;
    const result = next(); chains.push(`[${current}]${pending.join(",")}[${result}]`); current = result; pending = [];
  };
  for (const raw of filters) {
    const filter = aces16SurfaceFilterV1(raw);
    if (filter.startsWith("drawbox=")) {
      flush();
      const o = aces16FilterOptionsV1(filter.slice("drawbox=".length));
      const replace = ["1", "true", "yes"].includes(o.replace ?? "0");
      const colour = o.color ?? o.c ?? "black";
      const base = next(), template = next(), graphic = next(), rgb = next(), alpha = next(), mask = next(), result = next();
      chains.push(`[${current}]split[${base}][${template}]`);
      const encode = (options: Record<string, string>) => Object.entries(options).map(([key, value]) => `${key}=${q(value)}`).join(":");
      const box: Record<string, string> = { ...o, replace: "1" };
      const invert = colour === "invert";
      if (invert) { delete box.c; box.color = "white"; }
      // This branch contains only authored solid-colour artwork. Its8-bit
      // palette cannot quantize the separate16-bit photographic base.
      chains.push(`[${template}]geq=r=0:g=0:b=0:a=0,format=rgba,drawbox=${encode(box)},format=gbrap16le,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*65535/65280,0,65535)'[${graphic}]`);
      chains.push(`[${graphic}]split[${rgb}][${alpha}]`);
      if (replace) {
        const coverageTemplate = next(), coverage = next();
        // Replacement is coverage-weighted, not colour-alpha-weighted.
        chains.pop();
        chains.push(`[${graphic}]null[${rgb}]`);
        chains.push(`[${base}]split[${alpha}][${coverageTemplate}]`);
        const white: Record<string, string> = { ...box, color: "white", replace: "1" }; delete white.c;
        const covered = "if(gt(alpha(X,Y),0),65535,0)";
        chains.push(`[${coverageTemplate}]geq=r=0:g=0:b=0:a=0,format=rgba,drawbox=${encode(white)},format=gbrap16le,geq=r='${covered}':g='${covered}':b='${covered}':a='${covered}'[${coverage}]`);
        chains.push(`[${alpha}][${rgb}][${coverage}]maskedmerge=planes=15[${result}]`);
      } else {
        chains.push(`[${alpha}]geq=r='alpha(X,Y)':g='alpha(X,Y)':b='alpha(X,Y)':a=65535[${mask}]`);
        if (invert) {
          const inverse = next();
          chains.pop(); chains.pop();
          chains.push(`[${graphic}]geq=r='alpha(X,Y)':g='alpha(X,Y)':b='alpha(X,Y)':a=65535[${mask}]`);
          chains.push(`[${base}]split[${rgb}][${alpha}]`);
          chains.push(`[${alpha}]geq=r='65535-r(X,Y)':g='65535-g(X,Y)':b='65535-b(X,Y)':a='alpha(X,Y)'[${inverse}]`);
          chains.push(`[${rgb}][${inverse}][${mask}]maskedmerge=planes=7[${result}]`);
        } else chains.push(`[${base}][${rgb}][${mask}]maskedmerge=planes=7[${result}]`);
      }
      current = result;
    } else if (filter.startsWith("eq=") || filter.startsWith("hue=")) {
      const o = aces16FilterOptionsV1(filter.slice(filter.startsWith("eq=") ? 3 : 4));
      if (o.enable) {
        flush(); const base = next(), branch = next(), adjusted = next(), maskTemplate = next(), mask = next(), result = next();
        chains.push(`[${current}]split=3[${base}][${branch}][${maskTemplate}]`);
        chains.push(`[${branch}]${aces16ColourFiltersV1(filter).join(",")}[${adjusted}]`);
        const enabled = `65535*(${projectTime(o.enable)})`;
        chains.push(`[${maskTemplate}]geq=r=${q(enabled)}:g=${q(enabled)}:b=${q(enabled)}:a=65535[${mask}]`);
        chains.push(`[${base}][${adjusted}][${mask}]maskedmerge=planes=7[${result}]`);
        current = result;
      } else pending.push(...aces16ColourFiltersV1(filter));
    } else if (filter.startsWith("perspective=")) {
      if (!associated) pending.push("format=gbrap16le", "premultiply=inplace=1");
      pending.push(aces16PerspectiveFilterV1(filter));
      if (!associated) pending.push("unpremultiply=inplace=1");
    } else {
      pending.push(filter);
      if (filter === "premultiply=inplace=1") associated = true;
      if (filter === "unpremultiply=inplace=1") associated = false;
    }
  }
  chains.push(`[${current}]${pending.length ? pending.join(",") : "null"}[${output}]`);
  return chains;
}

/** The full source → primary → v2 LUT → finishing → geometry → project-time image lane. */
export function aces16ClipImageGraphV1(options: {
  head: string; output: string; preImage: string[]; gradeLut: string[]; postImage: string[];
  finishTail: string[]; finishing?: ResolvedFinishingV2; space: GradeWorkingSpace; canvasHeight: number;
}): string[] {
  const { output } = options; internalLabel(output);
  const input = `${output}aces16image`, before = `${output}aces16graded`, after = `${output}aces16finished`;
  const head = aces16SurfaceFilterV1(options.head);
  const chains = [`${head}${head.endsWith("]") ? "null" : ""}[${input}]`];
  const tail = options.finishTail.map((filter, index) => index === options.finishTail.length - 1 ? filter.replace(new RegExp(`\\[${output}\\]$`), "") : filter);
  if (!options.finishing) return [...chains, ...aces16ImageFilterChainsV1(input, output,
    [...options.preImage, ...options.gradeLut, ...options.postImage, ...tail], `${output}aces16op`)];
  return [...chains,
    ...aces16ImageFilterChainsV1(input, before, [...options.preImage, ...options.gradeLut], `${output}aces16pre`),
    ...gradeV2SpatialChains(before, after, options.finishing, { space: options.space, canvasHeight: options.canvasHeight, labelPrefix: `${output}aces16fx`, highBitDepth: true }),
    ...aces16ImageFilterChainsV1(after, output, [...options.postImage, ...tail], `${output}aces16post`),
  ];
}
