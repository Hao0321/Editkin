import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { PARITY_FIXTURES_V1, parityImagesV1, paritySamplePointsV1, type ParityColourV1, type ParityFixtureV1, type ParityImageNameV1, type ParityImageV1 } from "./blendParityFixturesV1";
import { parityReferenceRgba8V1, parityReferenceV1, parityReferenceWorkingRgba16V1, type ParityAcesReferenceV1, type ParityReferenceV1 } from "./blendParityReferenceV1";

/**
 * Parity harness v1 (P4): one fixture set, pluggable renderers, explicit tolerances.
 *
 * A renderer returns decoded 8-bit RGB at the fixture's sample points, plus the reference it must be compared with
 * (the export compares against the reference pushed through its own delivery stage; preview routes compare against
 * the reference picture directly). A renderer may decline a fixture (the route does not admit it and falls back) or
 * report itself unavailable (the route cannot run headlessly here); both are recorded, never counted as passes.
 */
export type ParityRgb8V1 = readonly [number, number, number];

export interface ParityRenderContextV1 {
  workDirectory: string;
  images: Record<ParityImageNameV1, ParityImageV1>;
  imagePaths: Record<ParityImageNameV1, string>;
  aces?: ParityAcesReferenceV1;
  /** The fixture's reference picture (undefined when the fixture has none). */
  reference?: ParityReferenceV1;
  referencePngPath?: string;
  /** ACES 2 only: the reference composite in ACEScct as a 16-bit PNG. */
  referenceWorkingPngPath?: string;
}

export type ParityRenderOutcomeV1 =
  | { kind: "measured"; samples: ParityRgb8V1[]; expected?: ParityRgb8V1[]; note?: string;
      /** When present the verdict compares these instead of RGB (the export compares its delivered Y'CbCr codes). */
      compare?: { space: "ycbcr"; samples: ParityRgb8V1[]; expected: ParityRgb8V1[] } }
  | { kind: "declined"; reason: string };

export interface ParityRendererV1 {
  id: "export" | "native" | "css" | string;
  route: string;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  render(fixture: ParityFixtureV1, context: ParityRenderContextV1): Promise<ParityRenderOutcomeV1>;
  dispose?(): Promise<void>;
}

/**
 * Tolerances, per channel, on decoded 8-bit output.
 * - SDR (Rec.709 8-bit): ≤ 2 codes.
 * - ACES 2: ≤ 1 % of full scale (2.55 codes) on the decoded display output.
 */
export const PARITY_TOLERANCE_V1: Readonly<Record<ParityColourV1, number>> = Object.freeze({ rec709: 2, "aces2-phone": 0.01 * 255 });

export interface ParitySampleResultV1 {
  label: string; expected: ParityRgb8V1; actual: ParityRgb8V1; delta: number;
  /** Decoded RGB of both sides when the verdict was taken in another space. */
  expectedRgb?: ParityRgb8V1; actualRgb?: ParityRgb8V1;
}
export interface ParityCellV1 {
  route: string;
  renderer: string;
  fixture: string;
  status: "pass" | "fail" | "declined" | "unavailable" | "informational";
  tolerance?: number;
  /** Space of `maxDelta`/`worst`: decoded RGB (default) or the delivered Y'CbCr codes. */
  space?: "rgb" | "ycbcr";
  maxDelta?: number;
  worst?: ParitySampleResultV1;
  reason?: string;
  samples?: ParitySampleResultV1[];
}

export interface ParityMatrixV1 {
  schema: "editkin.blend-parity-matrix/v1";
  generatedAt: string;
  canvas: { width: number; height: number };
  tolerances: Record<ParityColourV1, number>;
  cells: ParityCellV1[];
  summary: Record<string, { pass: number; fail: number; declined: number; unavailable: number; informational: number }>;
}

/** pngjs's packer also takes encoder options (the local typings declare only the 8-bit form). */
const writePngBytes = PNG.sync.write as (image: { width: number; height: number; data: Buffer }, options?: Record<string, unknown>) => Buffer;

export function writePngV1(path: string, width: number, height: number, rgba: Uint8Array): Promise<void> {
  return writeFile(path, writePngBytes({ width, height, data: Buffer.from(rgba) }));
}

/** 16-bit RGBA PNG; `rgba` holds host-order (little-endian) 16-bit samples, which pngjs writes big-endian. */
export function writePng16V1(path: string, width: number, height: number, rgba: Uint16Array): Promise<void> {
  const data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return writeFile(path, writePngBytes({ width, height, data }, { colorType: 6, inputColorType: 6, bitDepth: 16, inputHasAlpha: true }));
}

export async function prepareParityImagesV1(directory: string): Promise<{ images: Record<ParityImageNameV1, ParityImageV1>; paths: Record<ParityImageNameV1, string> }> {
  await mkdir(directory, { recursive: true });
  const images = parityImagesV1();
  const paths = {} as Record<ParityImageNameV1, string>;
  for (const image of Object.values(images)) {
    paths[image.name] = join(directory, `${image.name}.png`);
    await writePngV1(paths[image.name], image.width, image.height, image.data);
  }
  return { images, paths };
}

/** RGB of a row-major RGB/RGBA buffer at the fixture's sample points. */
export function sampleParityPixelsV1(data: Uint8Array | Buffer, width: number, channels: 3 | 4): ParityRgb8V1[] {
  return paritySamplePointsV1().map(({ x, y }) => {
    const index = (y * width + x) * channels;
    return [data[index], data[index + 1], data[index + 2]] as const;
  });
}

/** RGBA samples displayed over black (a preview surface shows straight colour × alpha on its black canvas). */
export function sampleParityPixelsOverBlackV1(data: Uint8Array | Buffer, width: number): ParityRgb8V1[] {
  return paritySamplePointsV1().map(({ x, y }) => {
    const index = (y * width + x) * 4, alpha = data[index + 3] / 255;
    return [Math.round(data[index] * alpha), Math.round(data[index + 1] * alpha), Math.round(data[index + 2] * alpha)] as const;
  });
}

export function referenceSamplesV1(reference: ParityReferenceV1): ParityRgb8V1[] {
  return sampleParityPixelsV1(parityReferenceRgba8V1(reference), reference.width, 4);
}

export function compareParitySamplesV1(expected: readonly ParityRgb8V1[], actual: readonly ParityRgb8V1[]): { maxDelta: number; worst: ParitySampleResultV1; samples: ParitySampleResultV1[] } {
  const labels = paritySamplePointsV1().map(point => point.label);
  const samples = expected.map((value, index) => ({
    label: labels[index], expected: value, actual: actual[index],
    delta: Math.max(...value.map((channel, c) => Math.abs(channel - actual[index][c]))),
  }));
  const worst = samples.reduce((a, b) => (b.delta > a.delta ? b : a));
  return { maxDelta: worst.delta, worst, samples };
}

/** Merge per-renderer matrices into one (cells concatenated, summary recomputed). */
export function mergeParityMatricesV1(matrices: readonly ParityMatrixV1[]): ParityMatrixV1 {
  const cells = matrices.flatMap(matrix => matrix.cells);
  const summary: ParityMatrixV1["summary"] = {};
  for (const cell of cells) {
    summary[cell.renderer] ??= { pass: 0, fail: 0, declined: 0, unavailable: 0, informational: 0 };
    summary[cell.renderer][cell.status] += 1;
  }
  return { schema: "editkin.blend-parity-matrix/v1", generatedAt: new Date().toISOString(), canvas: matrices[0]?.canvas ?? { width: 0, height: 0 },
    tolerances: { ...PARITY_TOLERANCE_V1 }, cells, summary };
}

/** Short Markdown report: per-renderer totals, then one row per fixture with each route's verdict and worst sample. */
export function parityReportMarkdownV1(matrix: ParityMatrixV1, gaps: ReadonlyMap<string, string> = new Map()): string {
  const renderers = [...new Set(matrix.cells.map(cell => cell.renderer))];
  const fixtures = [...new Set(matrix.cells.map(cell => cell.fixture))];
  const lines = ["# Blend parity matrix", "",
    `Generated ${matrix.generatedAt}. Canvas ${matrix.canvas.width}×${matrix.canvas.height}. Tolerance per channel on decoded 8-bit output: Rec.709 ≤ ${matrix.tolerances.rec709} codes; ACES 2 ≤ ${matrix.tolerances["aces2-phone"]} codes (1 % of full scale). The export route compares its delivered 8-bit Y'CbCr codes (yuv420p, patch centres) with the reference pushed through the same delivery; preview routes compare RGB.`, "",
    "| Renderer | route | pass | fail | declined | unavailable | informational |", "|---|---|---|---|---|---|---|",
    ...Object.entries(matrix.summary).map(([renderer, s]) => `| ${renderer} | ${matrix.cells.find(cell => cell.renderer === renderer)?.route ?? ""} | ${s.pass} | ${s.fail} | ${s.declined} | ${s.unavailable} | ${s.informational} |`), "",
    `| Fixture | ${renderers.join(" | ")} |`, `|---|${renderers.map(() => "---").join("|")}|`];
  for (const fixture of fixtures) {
    lines.push(`| ${fixture} | ${renderers.map(renderer => {
      const cell = matrix.cells.find(candidate => candidate.renderer === renderer && candidate.fixture === fixture);
      if (!cell) return "";
      const gap = gaps.get(`${renderer}:${fixture}`);
      if (cell.status === "pass") return `ok Δ${cell.maxDelta}`;
      const rgb = cell.worst?.expectedRgb ? ` (RGB exp ${cell.worst.expectedRgb.join(",")} got ${cell.worst.actualRgb!.join(",")})` : "";
      if (cell.status === "fail") return `**FAIL** Δ${cell.maxDelta ?? "?"}${cell.worst ? ` ${cell.worst.label} ${cell.space === "ycbcr" ? "YCbCr " : ""}exp ${cell.worst.expected.join(",")} got ${cell.worst.actual.join(",")}${rgb}` : ` ${cell.reason ?? ""}`}${gap ? ` — known gap: ${gap}` : ""}`;
      return cell.status;
    }).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runParityHarnessV1(options: {
  renderers: ParityRendererV1[];
  workDirectory: string;
  fixtures?: readonly ParityFixtureV1[];
  aces?: ParityAcesReferenceV1;
  includeSamples?: boolean;
  onCell?: (cell: ParityCellV1) => void;
}): Promise<ParityMatrixV1> {
  const fixtures = options.fixtures ?? PARITY_FIXTURES_V1;
  const { images, paths } = await prepareParityImagesV1(join(options.workDirectory, "images"));
  const cells: ParityCellV1[] = [];
  const push = (cell: ParityCellV1) => { cells.push(cell); options.onCell?.(cell); };
  for (const renderer of options.renderers) {
    const availability = await renderer.available();
    if (!availability.ok) {
      for (const fixture of fixtures) push({ route: renderer.route, renderer: renderer.id, fixture: fixture.id, status: "unavailable", reason: availability.reason });
      continue;
    }
    try {
      for (const fixture of fixtures) {
        const reference = fixture.colour === "aces2-phone" && !options.aces ? undefined : parityReferenceV1(fixture, images, options.aces);
        let referencePngPath: string | undefined, referenceWorkingPngPath: string | undefined;
        if (reference) {
          const stem = join(options.workDirectory, "references", fixture.id.replaceAll("/", "__"));
          await mkdir(join(options.workDirectory, "references"), { recursive: true });
          referencePngPath = `${stem}.png`;
          await writePngV1(referencePngPath, reference.width, reference.height, parityReferenceRgba8V1(reference));
          if (reference.working) {
            referenceWorkingPngPath = `${stem}.acescct16.png`;
            await writePng16V1(referenceWorkingPngPath, reference.width, reference.height, parityReferenceWorkingRgba16V1(reference));
          }
        }
        const base = { route: renderer.route, renderer: renderer.id, fixture: fixture.id };
        let outcome: ParityRenderOutcomeV1;
        try {
          outcome = await renderer.render(fixture, { workDirectory: options.workDirectory, images, imagePaths: paths, aces: options.aces, reference, referencePngPath, referenceWorkingPngPath });
        } catch (error) {
          push({ ...base, status: "fail", reason: `render error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) });
          continue;
        }
        if (outcome.kind === "declined") { push({ ...base, status: "declined", reason: outcome.reason }); continue; }
        const expected = outcome.expected ?? (reference ? referenceSamplesV1(reference) : undefined);
        if (!expected) {
          push({ ...base, status: "informational", reason: "no defined reference; measured values recorded",
            samples: outcome.samples.map((actual, index) => ({ label: paritySamplePointsV1()[index].label, expected: actual, actual, delta: 0 })) });
          continue;
        }
        const tolerance = PARITY_TOLERANCE_V1[fixture.colour];
        const compared = outcome.compare ? compareParitySamplesV1(outcome.compare.expected, outcome.compare.samples) : compareParitySamplesV1(expected, outcome.samples);
        if (outcome.compare) compared.samples.forEach((sample, index) => { sample.expectedRgb = expected[index]; sample.actualRgb = outcome.samples[index]; });
        push({ ...base, status: compared.maxDelta <= tolerance ? "pass" : "fail", tolerance, space: outcome.compare ? "ycbcr" : "rgb", maxDelta: compared.maxDelta, worst: compared.worst,
          ...(outcome.note ? { reason: outcome.note } : {}), ...(options.includeSamples ? { samples: compared.samples } : {}) });
      }
    } finally {
      await renderer.dispose?.();
    }
  }
  const summary: ParityMatrixV1["summary"] = {};
  for (const cell of cells) {
    summary[cell.renderer] ??= { pass: 0, fail: 0, declined: 0, unavailable: 0, informational: 0 };
    summary[cell.renderer][cell.status] += 1;
  }
  return { schema: "editkin.blend-parity-matrix/v1", generatedAt: new Date().toISOString(), canvas: { width: images.backdrop.width, height: images.backdrop.height },
    tolerances: { ...PARITY_TOLERANCE_V1 }, cells, summary };
}
