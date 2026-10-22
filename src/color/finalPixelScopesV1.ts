/** Counts encoded SDR output pixels. No exposure, skin detection or grading policy. */
export const FINAL_PIXEL_SCOPE_LIMITS = Object.freeze({ pixels: 8_294_400, dimension: 8192,
  histogramBins: 4096, waveformColumns: 1024, waveformLevels: 1024, vectorscopeBins: 512,
  countCells: 2_000_000, pageValues: 256 });
export interface FinalScopePixelFrame {
  width: number; height: number; format: "rgb8" | "rgb16le" | "rgba16le";
  primaries: "bt709"; transfer: "bt709"; range: "full";
  /** Packed bytes, little endian for 16-bit. RGBA must be fully opaque. */
  pixels: Uint8Array;
}
export interface FinalScopeOptions {
  histogramBins?: number; waveformColumns?: number; waveformLevels?: number; vectorscopeBins?: number;
}
export type FinalScopeName = "waveform" | "parade" | "histogram" | "vectorscope";
export type FinalScopePlane = "luma" | "red" | "green" | "blue" | "chroma";
export interface FinalScopePageRequest { scope: FinalScopeName; plane: FinalScopePlane; offset: number; limit: number }
export interface FinalPixelScopeMeasurement {
  readonly schema: "editkin.final-pixel-scopes/v1";
  readonly width: number; readonly height: number; readonly pixelCount: number;
  readonly format: FinalScopePixelFrame["format"];
  readonly interpretation: { primaries: "bt709"; transfer: "bt709"; range: "full"; values: "encoded-rgb-code"; alpha: "opaque" };
  readonly options: Required<FinalScopeOptions>;
  readonly binning: "floor-unit-times-bins-endpoint-clamped";
  readonly layout: "ascending-value-rows-column-major-within-row";
  readonly waveform: { columns: number; levels: number; samples: number };
  readonly parade: { columnsPerPlane: number; levels: number; samplesPerPlane: number };
  readonly histogram: { binsPerPlane: number; samplesPerPlane: number };
  readonly vectorscope: { binsPerAxis: number; samples: number; axes: "bt709-cb-cr"; minimum: -0.5; maximum: 0.5;
    skinReference: Readonly<{ convention: "ntsc-positive-I-mapped-to-bt709-cb-cr"; cb: number; cr: number; skinDetector: false }> };
}
type HeldCounts = Record<string, Uint32Array>;
const owners = new WeakMap<FinalPixelScopeMeasurement, HeldCounts>();
const reject = (reason: string): never => { throw new Error(`Final pixel scopes: ${reason}`); };
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) reject(label);
  return value as number;
}
/** Conventional guide: invert an NTSC U/V positive-I basis, then use BT709 Cb/Cr.
 * It is not a claim that every human skin colour follows an exact ray. */
function skinReference() {
  const radians = 33 * Math.PI / 180, r = Math.cos(radians) / .877, b = -Math.sin(radians) / .492;
  const g = -(.299 * r + .114 * b) / .587, y = .2126 * r + .7152 * g + .0722 * b;
  const cb = (b - y) / 1.8556, cr = (r - y) / 1.5748, length = Math.hypot(cb, cr);
  return Object.freeze({ convention: "ntsc-positive-I-mapped-to-bt709-cb-cr" as const, cb: cb / length, cr: cr / length, skinDetector: false as const });
}
export function measureFinalPixelScopesV1(frame: FinalScopePixelFrame, options: FinalScopeOptions = {}): FinalPixelScopeMeasurement {
  if (!frame || frame.primaries !== "bt709" || frame.transfer !== "bt709" || frame.range !== "full") reject("explicit full-range BT709 SDR pixels required");
  const width = integer(frame.width, 1, FINAL_PIXEL_SCOPE_LIMITS.dimension, "width"), height = integer(frame.height, 1, FINAL_PIXEL_SCOPE_LIMITS.dimension, "height");
  const count = integer(width * height, 1, FINAL_PIXEL_SCOPE_LIMITS.pixels, "pixel budget");
  const stride = frame.format === "rgb8" ? 3 : frame.format === "rgb16le" ? 6 : frame.format === "rgba16le" ? 8 : reject("pixel format");
  if (!(frame.pixels instanceof Uint8Array) || frame.pixels.byteLength !== count * stride) reject("packed pixel byte length");
  if (typeof SharedArrayBuffer !== "undefined" && frame.pixels.buffer instanceof SharedArrayBuffer) reject("shared pixel buffers");
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["histogramBins", "waveformColumns", "waveformLevels", "vectorscopeBins"].includes(key))) reject("scope options");
  const config = Object.freeze({
    histogramBins: integer(options.histogramBins ?? 256, 2, FINAL_PIXEL_SCOPE_LIMITS.histogramBins, "histogram bins"),
    waveformColumns: integer(options.waveformColumns ?? Math.min(width, 256), 1, FINAL_PIXEL_SCOPE_LIMITS.waveformColumns, "waveform columns"),
    waveformLevels: integer(options.waveformLevels ?? 256, 2, FINAL_PIXEL_SCOPE_LIMITS.waveformLevels, "waveform levels"),
    vectorscopeBins: integer(options.vectorscopeBins ?? 256, 2, FINAL_PIXEL_SCOPE_LIMITS.vectorscopeBins, "vectorscope bins"),
  });
  const waveCells = config.waveformColumns * config.waveformLevels;
  integer(waveCells * 4 + config.histogramBins * 4 + config.vectorscopeBins ** 2, 1, FINAL_PIXEL_SCOPE_LIMITS.countCells, "density memory budget");
  const view = new DataView(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
  if (frame.format === "rgba16le") for (let offset = 6; offset < view.byteLength; offset += 8) if (view.getUint16(offset, true) !== 65535) reject("transparent output needs an actually composited background");
  const counts: HeldCounts = { "waveform:luma": new Uint32Array(waveCells), "vectorscope:chroma": new Uint32Array(config.vectorscopeBins ** 2) };
  for (const plane of ["luma", "red", "green", "blue"] as const) {
    counts[`histogram:${plane}`] = new Uint32Array(config.histogramBins);
    if (plane !== "luma") counts[`parade:${plane}`] = new Uint32Array(waveCells);
  }
  const bin = (value: number, bins: number) => Math.max(0, Math.min(bins - 1, Math.floor(value * bins)));
  const read = frame.format === "rgb8" ? (offset: number) => frame.pixels[offset] / 255 : (offset: number) => view.getUint16(offset, true) / 65535;
  const channelBytes = frame.format === "rgb8" ? 1 : 2;
  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * stride, r = read(offset), g = read(offset + channelBytes), b = read(offset + channelBytes * 2);
    // ITU-R BT.709-6 signal equations, deliberately applied to encoded R'G'B'.
    const y = r === g && g === b ? r : .2126 * r + .7152 * g + .0722 * b;
    const cb = (b - y) / 1.8556, cr = (r - y) / 1.5748;
    const column = Math.floor((pixel % width) * config.waveformColumns / width);
    for (const [plane, value] of [["luma", y], ["red", r], ["green", g], ["blue", b]] as const) {
      counts[`histogram:${plane}`][bin(value, config.histogramBins)]++;
      counts[`${plane === "luma" ? "waveform" : "parade"}:${plane}`][bin(value, config.waveformLevels) * config.waveformColumns + column]++;
    }
    counts["vectorscope:chroma"][bin(cr + .5, config.vectorscopeBins) * config.vectorscopeBins + bin(cb + .5, config.vectorscopeBins)]++;
  }
  const result: FinalPixelScopeMeasurement = Object.freeze({ schema: "editkin.final-pixel-scopes/v1", width, height, pixelCount: count, format: frame.format,
    interpretation: Object.freeze({ primaries: "bt709", transfer: "bt709", range: "full", values: "encoded-rgb-code", alpha: "opaque" } as const),
    options: config, binning: "floor-unit-times-bins-endpoint-clamped", layout: "ascending-value-rows-column-major-within-row",
    waveform: Object.freeze({ columns: config.waveformColumns, levels: config.waveformLevels, samples: count }),
    parade: Object.freeze({ columnsPerPlane: config.waveformColumns, levels: config.waveformLevels, samplesPerPlane: count }),
    histogram: Object.freeze({ binsPerPlane: config.histogramBins, samplesPerPlane: count }),
    vectorscope: Object.freeze({ binsPerAxis: config.vectorscopeBins, samples: count, axes: "bt709-cb-cr", minimum: -.5, maximum: .5, skinReference: skinReference() }),
  });
  owners.set(result, counts); return result;
}
export function readFinalPixelScopePageV1(measurement: FinalPixelScopeMeasurement, request: FinalScopePageRequest) {
  const held = owners.get(measurement) ?? reject("foreign measurement owner");
  const values = held[`${request?.scope}:${request?.plane}`]; if (!values) reject("scope plane");
  const offset = integer(request.offset, 0, values.length, "page offset"), limit = integer(request.limit, 1, FINAL_PIXEL_SCOPE_LIMITS.pageValues, "page limit");
  const end = Math.min(values.length, offset + limit);
  return { scope: request.scope, plane: request.plane, offset, totalValues: values.length,
    values: Array.from(values.subarray(offset, end)), nextOffset: end < values.length ? end : null };
}
