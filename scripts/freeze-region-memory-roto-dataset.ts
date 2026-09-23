import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetRoot = join(root, ".rd", "experiments", "self-authored-region-memory-roto-dataset");
const manifestPath = join(datasetRoot, "manifest.json");
const inputPath = join(datasetRoot, "inputs.rgb24");
const truthPath = join(datasetRoot, "annotations.alpha8");
const distractorPath = join(datasetRoot, "distractors.alpha8");
const WIDTH = 96;
const HEIGHT = 64;
const SUBJECT_WIDTH = 20;
const SUBJECT_HEIGHT = 26;

type Frame = { rgb: Buffer; truth: Buffer; distractor: Buffer };
type Scenario = {
  name: string;
  frames: Frame[];
  occlusionFrames: number[];
  reappearanceFrames: number[];
  lightingDriftFrames: number[];
  sceneCutFrames: number[];
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function subjectAlpha(localX: number, localY: number): number {
  const normalizedX = (localX + 0.5 - SUBJECT_WIDTH * 0.5) / (SUBJECT_WIDTH * 0.5);
  const normalizedY = (localY + 0.5 - SUBJECT_HEIGHT * 0.5) / (SUBJECT_HEIGHT * 0.5);
  const radius = normalizedX * normalizedX + normalizedY * normalizedY;
  if (radius <= 0.84) return 1;
  if (radius >= 1.08) return 0;
  const value = Math.max(0, Math.min(1, (1.08 - radius) / 0.24));
  return value * value * (3 - 2 * value);
}

function backgroundPixel(x: number, y: number, shift: [number, number, number]): [number, number, number] {
  const texture = (x * 17 + y * 11 + x * y * 3) % 13 - 6;
  const base = [28, 92, 154] as const;
  return [
    Math.max(0, Math.min(255, base[0] + shift[0] + texture)),
    Math.max(0, Math.min(255, base[1] + shift[1] + Math.trunc(texture / 2))),
    Math.max(0, Math.min(255, base[2] + shift[2] - Math.trunc(texture / 3))),
  ].map(Math.round) as [number, number, number];
}

function renderFrame(options: {
  subjectLeft: number;
  subjectTop: number;
  subjectColor: [number, number, number];
  visible: boolean;
  distractor?: { left: number; top: number; color?: [number, number, number] };
  backgroundShift: [number, number, number];
}): Frame {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  const truth = Buffer.alloc(WIDTH * HEIGHT);
  const distractor = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = y * WIDTH + x;
      const background = backgroundPixel(x, y, options.backgroundShift);
      rgb.set(background, index * 3);
      if (options.visible) {
        const alpha = subjectAlpha(x - options.subjectLeft, y - options.subjectTop);
        truth[index] = Math.round(alpha * 255);
        for (let channel = 0; channel < 3; channel += 1) {
          rgb[index * 3 + channel] = Math.round(alpha * options.subjectColor[channel]! + (1 - alpha) * background[channel]!);
        }
      }
      if (options.distractor) {
        const alpha = subjectAlpha(x - options.distractor.left, y - options.distractor.top);
        if (alpha > 0) {
          distractor[index] = Math.round(alpha * 255);
          const color = options.distractor.color ?? options.subjectColor;
          for (let channel = 0; channel < 3; channel += 1) {
            rgb[index * 3 + channel] = Math.round(alpha * color[channel]! + (1 - alpha) * rgb[index * 3 + channel]!);
          }
        }
      }
    }
  }
  return { rgb, truth, distractor };
}

function scenarios(): Scenario[] {
  const lightingFrames = Array.from({ length: 14 }, (_, frame) => {
    const ratio = frame / 13;
    return renderFrame({
      subjectLeft: 20 + frame,
      subjectTop: 20,
      subjectColor: [
        Math.round(224 * (1 - ratio) + 90 * ratio),
        Math.round(54 * (1 - ratio) + 150 * ratio),
        Math.round(42 * (1 - ratio) + 120 * ratio),
      ],
      visible: true,
      backgroundShift: [Math.round(42 * ratio), Math.round(-52 * ratio), Math.round(56 * ratio)],
    });
  });
  const distractorFrames = Array.from({ length: 10 }, (_, frame) => renderFrame({
    subjectLeft: 20 + frame,
    subjectTop: 20,
    subjectColor: [224, 54, 42],
    visible: true,
    distractor: frame >= 3 ? { left: 70, top: 20 } : undefined,
    backgroundShift: [0, 0, 0],
  }));
  const occlusionFrames = Array.from({ length: 15 }, (_, frame) => renderFrame({
    subjectLeft: frame < 5 ? 20 + frame : 25 + Math.max(0, frame - 10),
    subjectTop: 20,
    subjectColor: [224, 54, 42],
    visible: frame < 5 || frame > 9,
    backgroundShift: [0, 0, 0],
  }));
  const jitter = [[0, 0, 0], [4, -3, 2], [-3, 2, -2], [2, 4, -3], [-2, -2, 3]] as const;
  const temporalFrames = Array.from({ length: 16 }, (_, frame) => {
    const colorJitter = jitter[frame % jitter.length]!;
    return renderFrame({
      subjectLeft: 20 + Math.floor(frame / 2),
      subjectTop: 20 + frame % 2,
      subjectColor: [210 + colorJitter[0], 66 + colorJitter[1], 48 + colorJitter[2]],
      visible: true,
      backgroundShift: [colorJitter[2], colorJitter[0], colorJitter[1]],
    });
  });
  const cutFrames = Array.from({ length: 8 }, (_, frame) => frame < 4
    ? renderFrame({ subjectLeft: 20 + frame, subjectTop: 20, subjectColor: [224, 54, 42], visible: true, backgroundShift: [0, 0, 0] })
    : renderFrame({ subjectLeft: 22 + frame - 4, subjectTop: 20, subjectColor: [38, 205, 126], visible: true, backgroundShift: [150, 80, -105] }));
  return [
    { name: "lighting_color_drift", frames: lightingFrames, occlusionFrames: [], reappearanceFrames: [], lightingDriftFrames: [7, 8, 9, 10, 11, 12, 13], sceneCutFrames: [] },
    { name: "same_color_distractor", frames: distractorFrames, occlusionFrames: [], reappearanceFrames: [], lightingDriftFrames: [], sceneCutFrames: [] },
    { name: "full_occlusion_reappearance", frames: occlusionFrames, occlusionFrames: [5, 6, 7, 8, 9], reappearanceFrames: [10, 11, 12, 13, 14], lightingDriftFrames: [], sceneCutFrames: [] },
    { name: "temporal_stability", frames: temporalFrames, occlusionFrames: [], reappearanceFrames: [], lightingDriftFrames: [], sceneCutFrames: [] },
    { name: "scene_cut_reseed", frames: cutFrames, occlusionFrames: [], reappearanceFrames: [], lightingDriftFrames: [], sceneCutFrames: [4] },
  ];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  if (await exists(manifestPath) && !process.argv.includes("--force")) {
    throw new Error("Frozen region-memory dataset already exists; pass --force only for an explicitly new dataset revision");
  }
  const generated = scenarios();
  const rgb = Buffer.concat(generated.flatMap((scenario) => scenario.frames.map((frame) => frame.rgb)));
  const truth = Buffer.concat(generated.flatMap((scenario) => scenario.frames.map((frame) => frame.truth)));
  const distractors = Buffer.concat(generated.flatMap((scenario) => scenario.frames.map((frame) => frame.distractor)));
  await mkdir(datasetRoot, { recursive: true });
  await Promise.all([writeFile(inputPath, rgb), writeFile(truthPath, truth), writeFile(distractorPath, distractors)]);
  let offsetFrames = 0;
  const scenarioReceipts = generated.map((scenario) => {
    const receipt = {
      name: scenario.name,
      frameOffset: offsetFrames,
      frameCount: scenario.frames.length,
      seed: { x: 16 / WIDTH, y: 17 / HEIGHT, width: 28 / WIDTH, height: 32 / HEIGHT },
      occlusionFrames: scenario.occlusionFrames,
      reappearanceFrames: scenario.reappearanceFrames,
      lightingDriftFrames: scenario.lightingDriftFrames,
      sceneCutFrames: scenario.sceneCutFrames,
    };
    offsetFrames += scenario.frames.length;
    return receipt;
  });
  const generatorBytes = await readFile(fileURLToPath(import.meta.url));
  const files = await Promise.all([
    ["inputs", inputPath, rgb] as const,
    ["annotations", truthPath, truth] as const,
    ["distractors", distractorPath, distractors] as const,
  ].map(async ([role, path, bytes]) => ({
    role,
    path: path.slice(root.length + 1).replaceAll("\\", "/"),
    bytes: (await stat(path)).size,
    sha256: sha256(bytes),
  })));
  const manifest = {
    schema: "editkin.region-memory-roto-dataset/v1",
    datasetId: "editkin-owned-synthetic-region-memory-v2",
    evidenceState: "diagnostic_controlled_synthetic",
    truthAuthority: "independent_parametric_oracle_not_visible_to_candidate",
    width: WIDTH,
    height: HEIGHT,
    pixelFormat: "rgb24",
    annotationFormat: "alpha8",
    frameCount: offsetFrames,
    scenarios: scenarioReceipts,
    files,
    generator: {
      path: fileURLToPath(import.meta.url).slice(root.length + 1).replaceAll("\\", "/"),
      bytes: generatorBytes.length,
      sha256: sha256(generatorBytes),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Frozen region-memory diagnostic dataset ${manifest.datasetId} (${offsetFrames} frames)`);
}

await main();
