import * as z from "zod/v4";

export const subjectSheenStyleV1Schema = z.strictObject({ schema: z.literal("editkin.subject-sheen-style/v1"),
  angleDegrees: z.number().finite().min(-80).max(80), bandWidthRatio: z.number().finite().min(.02).max(.5), intensity: z.number().finite().min(0).max(1) });
export type SubjectSheenStyleV1 = z.infer<typeof subjectSheenStyleV1Schema>;
function configuration(width: number, height: number, totalFrames: number, style: SubjectSheenStyleV1) {
  const s = subjectSheenStyleV1Schema.parse(style);
  if (![width, height].every(v => Number.isSafeInteger(v) && v >= 16 && v <= 8192) || width * height > 2073600
    || !Number.isSafeInteger(totalFrames) || totalFrames < 3 || totalFrames > 240) throw Error("SHEEN_RASTER_OR_FRAME_BUDGET");
  const angle = s.angleDegrees * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle), radius = .5 * (Math.abs(dx) + Math.abs(dy));
  return { width, height, totalFrames, style: s, dx, dy, radius, halfBand: radius * s.bandWidthRatio };
}
/** Independent CPU reference and bounded production decode verifier. Constant-white
 * straight RGB plus this alpha brightens only within the source-space confirmed matte. */
export function createSubjectSheenKernelV1(width: number, height: number, totalFrames: number, style: SubjectSheenStyleV1) {
  const c = configuration(width, height, totalFrames, style);
  const frame = (index: number) => { if (!Number.isSafeInteger(index) || index < 0 || index >= totalFrames) throw Error("SHEEN_FRAME_OUTSIDE_INTERVAL");
    const progress = index / (totalFrames - 1), centre = -(c.radius + c.halfBand) + 2 * (c.radius + c.halfBand) * progress;
    return (x: number, y: number, alpha: number) => {
      if (!alpha || !c.style.intensity) return 0;
      const u = (x / (width - 1) - .5) * c.dx + (y / (height - 1) - .5) * c.dy;
      const support = Math.max(0, Math.min(1, 1 - Math.abs(u - centre) / c.halfBand));
      return Math.round(alpha * c.style.intensity * support * support * (3 - 2 * support));
    };
  };
  return Object.freeze({ width, height, totalFrames, frame,
    renderAlpha(input: Uint16Array, index: number, check: () => void = () => {}) {
      if (input.length !== width * height) throw Error("SHEEN_ALPHA_PLANE_SIZE");
      const sample = frame(index), output = new Uint16Array(input.length);
      for (let y = 0; y < height; y++) { if (y % 32 === 0) check();
        for (let x = 0; x < width; x++) { const p = y * width + x; output[p] = sample(x, y, input[p]); }
      }
      check(); return output;
    },
    alphaContract: "source-space confirmed matte times bounded sweep; authored clip masks/pose remain placement-owned" as const,
    qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const });
}
const label = /^(?:\d+:v(?::\d+)?|[A-Za-z][A-Za-z0-9_]{0,63})$/u;
const number = (value: number) => value.toPrecision(17);
/** Input must already be project-rate gray16le. No FPS or scene composition owner here. */
export function buildSubjectSheenFiltersV1(input: { alphaLabel: string; outputLabel: string; width: number; height: number; totalFrames: number; frameOffset: number; style: SubjectSheenStyleV1 }) {
  const { alphaLabel, outputLabel: out, frameOffset } = input, c = configuration(input.width, input.height, input.totalFrames, input.style), prefix = out + "H";
  if (!label.test(alphaLabel) || !/^[A-Za-z][A-Za-z0-9_]{0,32}$/u.test(out) || alphaLabel === out || alphaLabel.startsWith(prefix)
    || !Number.isSafeInteger(frameOffset) || frameOffset < 0 || frameOffset >= c.totalFrames) throw Error("SHEEN_FILTER_LABEL_OR_FRAME");
  const u = `((X/${c.width - 1}-.5)*${number(c.dx)}+(Y/${c.height - 1}-.5)*${number(c.dy)})`;
  const centre = `(-${number(c.radius + c.halfBand)}+${number(2 * (c.radius + c.halfBand))}*(N+${frameOffset})/${c.totalFrames - 1})`;
  const support = `max(0,min(1,1-abs(${u}-${centre})/${number(c.halfBand)}))`;
  const factor = `${number(c.style.intensity)}*pow(${support},2)*(3-2*${support})`;
  return { schema: "editkin.subject-sheen-filter/v1" as const, filters: [
    `[${alphaLabel}]format=gray16le,split=2[${prefix}seed][${prefix}input]`,
    `[${prefix}seed]geq=lum=65535,format=gray16le[${prefix}white]`,
    `[${prefix}input]geq=lum='floor(lum(X,Y)*(${factor})+0.5)',format=gray16le[${prefix}alpha]`,
    `[${prefix}white][${prefix}alpha]mergeplanes=0x00000010:format=gbrap16le,setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=0[${out}]`,
  ], outputLabel: out, width: c.width, height: c.height, totalFrames: c.totalFrames, frameOffset, pixelFormat: "gbrap16le" as const,
  alphaContract: "source-space confirmed matte times bounded sweep; authored clip masks/pose remain placement-owned" as const,
  rgbContract: "constant full-white straight RGB; alpha zero outside the matte/sweep" as const,
  rasterReserveBytes: c.width * c.height * 40, reserveBasis: "conservative filter-plane estimate, not measured RSS" as const,
  qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const };
}
