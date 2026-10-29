import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acesDisplayInverseFor } from "../../color/acesDisplayInverse";
import { ACES_PHONE_SDR_OUTPUT_LUT_V1 } from "../../color/acesPhoneInputV1";
import { parseCubeLut, sampleCubeLut, type CubeLut } from "../../color/cubeLut";
import { linearRec709ToWorking, workingToLinearRec709 } from "../../color/gradeV2Color";
import { sceneLinearBlendV1, w3cCompositeV1, type StraightColourV1 } from "../blendKernelV1";
import type { ParityFixtureV1, ParityImageNameV1, ParityImageV1 } from "./blendParityFixturesV1";

/**
 * Independent CPU reference for the parity fixtures (P4). It implements the W3C Compositing and Blending formulas
 * (blendKernelV1) in each project's working space, in double precision, and does not call FFmpeg or any renderer.
 *
 * - Rec.709 projects blend display-encoded R'G'B' (design D2) on an opaque black canvas, as the export does.
 * - ACES 2 phone projects: display code → ACEScct through the display inverse of the shipped phone output LUT
 *   (the export's own display-reconstruction definition, evaluated here with the JS tetrahedral sampler), stored at
 *   16 bit. Each 8-bit image enters that inverse as the export's input stage delivers it (`decodedImages`, measured
 *   from its pixel-format conversion: swscale maps 255 to about 0.9962, not 1.0, with small cross-channel differences,
 *   which matters on the inverse's steep shoulder); normal layers mix ACEScct codes (unchanged legacy behaviour,
 *   D2); non-normal layers blend scene-linear Rec.709 with blendKernelV1.sceneLinearBlendV1 (D2 operand rule, see
 *   its amendment note); then ACEScct (16 bit) → output LUT.
 * - Track mattes (D3): the matte source is never drawn; coverage = BT.709 luma of the straight matte colour
 *   × matte alpha (luma modes) or the matte alpha (alpha modes), inverted for the *_inverted modes.
 * - Adjustment layers: only the identity adjustment has a defined reference (the unadjusted picture); other
 *   adjustments are reported per route without a reference (no single canonical adjustment-layer maths yet).
 */
export interface ParityReferenceV1 {
  width: number;
  height: number;
  /** Display RGB, normalized, 3 values per pixel. */
  rgb: Float64Array;
  /** ACES 2 only: the composite in the working encoding (ACEScct, 16-bit quantized), 3 values per pixel. */
  working?: Float64Array;
}

export interface ParityAcesReferenceV1 {
  output: CubeLut;
  inverse: CubeLut;
  /** Per image, per pixel R, G, B (as the display inverse receives them) and alpha (as composited); code / 255 when absent. */
  decodedImages?: Partial<Record<ParityImageNameV1, Float32Array>>;
}

export async function loadParityAcesReferenceV1(colorRoot: string, decodedImages?: Partial<Record<ParityImageNameV1, Float32Array>>): Promise<ParityAcesReferenceV1> {
  const output = parseCubeLut(await readFile(join(colorRoot, ACES_PHONE_SDR_OUTPUT_LUT_V1), "utf8"));
  return { output, inverse: acesDisplayInverseFor(output), ...(decodedImages ? { decodedImages } : {}) };
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const q16 = (value: number) => Math.round(clamp01(value) * 65535) / 65535;
const BT709 = [0.2126, 0.7152, 0.0722] as const;

const pixelAlpha = (image: ParityImageV1, index: number) => image.data[index * 4 + 3] / 255;

function pixel(image: ParityImageV1, index: number): StraightColourV1 {
  const d = image.data;
  return { r: d[index * 4] / 255, g: d[index * 4 + 1] / 255, b: d[index * 4 + 2] / 255, a: d[index * 4 + 3] / 255 };
}

/** Per-pixel stack definition: layers bottom to top over the canvas. `image` is the layer's source image. */
interface ReferenceLayer { colour: StraightColourV1; mode: Parameters<typeof w3cCompositeV1>[2]; image: ParityImageNameV1 }

function layersAt(fixture: ParityFixtureV1, images: Record<ParityImageNameV1, ParityImageV1>, index: number): ReferenceLayer[] | undefined {
  if (fixture.kind === "blend") {
    const source = pixel(images.source, index);
    const top: ReferenceLayer = { colour: { ...source, a: source.a * fixture.opacity }, mode: fixture.mode, image: "source" };
    return fixture.bottom ? [top] : [{ colour: pixel(images.backdrop, index), mode: "normal", image: "backdrop" }, top];
  }
  if (fixture.kind === "matte") {
    const matte = pixel(images.matte, index), target = pixel(images.target, index);
    const luma = BT709[0] * matte.r + BT709[1] * matte.g + BT709[2] * matte.b;
    const coverage = fixture.matte.startsWith("luma") ? luma * matte.a : matte.a;
    const m = fixture.matte.endsWith("_inverted") ? 1 - coverage : coverage;
    return [{ colour: pixel(images.backdrop, index), mode: "normal", image: "backdrop" }, { colour: { ...target, a: target.a * m }, mode: "normal", image: "target" }];
  }
  if (!fixture.gated) return undefined;
  return [{ colour: pixel(images.backdrop, index), mode: "normal", image: "backdrop" }, { colour: pixel(images.source, index), mode: "normal", image: "source" }];
}

/** The reference picture of a fixture, or undefined when the fixture has no defined reference. */
export function parityReferenceV1(fixture: ParityFixtureV1, images: Record<ParityImageNameV1, ParityImageV1>, aces?: ParityAcesReferenceV1): ParityReferenceV1 | undefined {
  const { width, height } = images.backdrop;
  const rgb = new Float64Array(width * height * 3);
  const working = fixture.colour === "aces2-phone" ? new Float64Array(width * height * 3) : undefined;
  for (let index = 0; index < width * height; index += 1) {
    const layers = layersAt(fixture, images, index);
    if (!layers) return undefined;
    let out: [number, number, number];
    if (fixture.colour === "rec709") {
      let canvas: StraightColourV1 = { r: 0, g: 0, b: 0, a: 1 };
      for (const layer of layers) canvas = w3cCompositeV1(canvas, layer.colour, layer.mode);
      out = [canvas.r, canvas.g, canvas.b];
    } else {
      if (!aces) throw Error("PARITY_ACES_REFERENCE_REQUIRED");
      // The working canvas starts at ACEScct code 0 (the export's opaque black composite in 16 bit).
      let canvas: [number, number, number] = [0, 0, 0];
      for (const layer of layers) {
        const decoded = aces.decodedImages?.[layer.image];
        const input: [number, number, number] = decoded ? [decoded[index * 4], decoded[index * 4 + 1], decoded[index * 4 + 2]] : [layer.colour.r, layer.colour.g, layer.colour.b];
        const cct = sampleCubeLut(aces.inverse, input).map(q16) as [number, number, number];
        // The layer's alpha already carries opacity (and a matte); swap in the measured 16-bit input alpha.
        const alpha = decoded ? layer.colour.a * (decoded[index * 4 + 3] / Math.max(1e-9, pixelAlpha(images[layer.image], index))) : layer.colour.a;
        if (layer.mode === "normal") canvas = canvas.map((value, channel) => (1 - alpha) * value + alpha * cct[channel]) as [number, number, number];
        else {
          const backdrop = workingToLinearRec709(canvas, "acescct"), source = workingToLinearRec709(cct, "acescct");
          const mixed = w3cCompositeV1({ r: backdrop[0], g: backdrop[1], b: backdrop[2], a: 1 }, { r: source[0], g: source[1], b: source[2], a: alpha },
            layer.mode, sceneLinearBlendV1);
          canvas = linearRec709ToWorking([mixed.r, mixed.g, mixed.b], "acescct");
        }
        canvas = canvas.map(q16) as [number, number, number];
      }
      working!.set(canvas, index * 3);
      out = sampleCubeLut(aces.output, canvas);
    }
    rgb.set(out.map(clamp01), index * 3);
  }
  return { width, height, rgb, ...(working ? { working } : {}) };
}

/** ACES reference composite → 16-bit opaque RGBA (working codes), for delivery through the export's own output stage. */
export function parityReferenceWorkingRgba16V1(reference: ParityReferenceV1): Uint16Array {
  if (!reference.working) throw Error("PARITY_REFERENCE_WORKING_MISSING");
  const data = new Uint16Array(reference.width * reference.height * 4);
  for (let index = 0; index < reference.width * reference.height; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) data[index * 4 + channel] = Math.round(clamp01(reference.working[index * 3 + channel]) * 65535);
    data[index * 4 + 3] = 65535;
  }
  return data;
}

/** Reference picture → 8-bit opaque RGBA (rounded), the form the delivery pass and the PNG writer take. */
export function parityReferenceRgba8V1(reference: ParityReferenceV1): Uint8Array {
  const data = new Uint8Array(reference.width * reference.height * 4);
  for (let index = 0; index < reference.width * reference.height; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) data[index * 4 + channel] = Math.round(clamp01(reference.rgb[index * 3 + channel]) * 255);
    data[index * 4 + 3] = 255;
  }
  return data;
}
