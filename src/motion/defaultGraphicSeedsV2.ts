import type {
  MotionGraphicKind,
  MotionGraphicPresetSeed,
  MotionGraphicV2Layout,
  MotionGraphicV2Motion,
} from "../domain/types";
import type { MotionGraphicPreset } from "../creative/motionGraphicPresetTypes";

type DefaultV2Seed = MotionGraphicPresetSeed & {
  schema: "hao.motion-composition/v2";
  kind: MotionGraphicKind;
  fontFamily: "Noto Sans TC";
  fontWeight: 700 | 900;
  motionV2: MotionGraphicV2Motion;
  layoutV2: MotionGraphicV2Layout;
};

// Original generic source recipes. Physical glyph preparation supplies metrics;
// these seeds do not certify the appearance of the eventual rendered artwork.
const COMMON = {
  schema: "hao.motion-composition/v2" as const,
  fontFamily: "Noto Sans TC" as const,
  letterSpacing: 0,
  outlineWidth: 0,
  shadowDepth: 0,
  visualStyle: "solid_panel" as const,
  animation: "fade" as const,
};

function gentleMotion(
  entranceX: number,
  entranceY: number,
  exitX: number,
  exitY: number,
): MotionGraphicV2Motion {
  return {
    sequence: {
      unit: "all",
      order: "forward",
      exitOrder: "forward",
      staggerFrames: 0,
    },
    entrance: {
      durationFrames: 7,
      offsetXPixels: entranceX,
      offsetYPixels: entranceY,
      scale: 1,
      opacity: 0,
      easing: { type: "ease_out" },
    },
    exit: {
      durationFrames: 4,
      offsetXPixels: exitX,
      offsetYPixels: exitY,
      scale: 1,
      opacity: 0,
      easing: { type: "ease_in" },
    },
  };
}

function safeLayout(
  maxLines: number,
  minFontSize: number,
  lineGap: number,
  align: MotionGraphicV2Layout["align"],
): MotionGraphicV2Layout {
  return {
    safeArea: { top: 0.06, right: 0.05, bottom: 0.08, left: 0.05 },
    maxLines,
    minFontSize,
    lineGap,
    align,
    widthMode: "fixed",
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

// Keep the established title/card/tag/counter placement roles. Caller text and
// timeline and text remain caller-owned; no placeholder text or offsets are seeded.
const SEEDS: Readonly<Record<MotionGraphicKind, DefaultV2Seed>> = deepFreeze({
  title: {
    ...COMMON,
    presetId: "generic-title-v2",
    name: "動態主標題",
    kind: "title",
    x: 0.08,
    y: 0.12,
    width: 0.7,
    fontSize: 72,
    fontWeight: 900,
    cornerRadius: 14,
    textColor: "#FFFFFF",
    backgroundColor: "#071021F2",
    accentColor: "#246BFD",
    motionV2: gentleMotion(0, 16, 0, -8),
    layoutV2: safeLayout(2, 32, 6, "left"),
  },
  card: {
    ...COMMON,
    presetId: "generic-card-v2",
    name: "資訊重點卡",
    kind: "card",
    x: 0.08,
    y: 0.68,
    width: 0.56,
    fontSize: 46,
    fontWeight: 700,
    cornerRadius: 12,
    textColor: "#071021",
    backgroundColor: "#FFFFFFF2",
    accentColor: "#246BFD",
    motionV2: gentleMotion(12, 0, -8, 0),
    layoutV2: safeLayout(3, 24, 6, "left"),
  },
  tag: {
    ...COMMON,
    presetId: "generic-tag-v2",
    name: "重點標籤",
    kind: "tag",
    x: 0.65,
    y: 0.22,
    width: 0.25,
    fontSize: 38,
    fontWeight: 700,
    cornerRadius: 8,
    textColor: "#FFFFFF",
    backgroundColor: "#246BFDF2",
    accentColor: "#071021",
    motionV2: gentleMotion(6, 0, -4, 0),
    layoutV2: safeLayout(2, 22, 4, "left"),
  },
  counter: {
    ...COMMON,
    presetId: "generic-counter-v2",
    name: "數字重點",
    kind: "counter",
    x: 0.72,
    y: 0.12,
    width: 0.2,
    fontSize: 80,
    fontWeight: 900,
    cornerRadius: 12,
    textColor: "#071021",
    backgroundColor: "#FFFFFFF2",
    accentColor: "#246BFD",
    motionV2: gentleMotion(0, 12, 0, -6),
    layoutV2: safeLayout(1, 28, 0, "center"),
  },
});

/** A fresh complete v2 seed; the shared creator supplies text and timeline. */
export function defaultMotionGraphicV2Seed(kind: MotionGraphicKind): DefaultV2Seed {
  if (!Object.prototype.hasOwnProperty.call(SEEDS, kind)) {
    throw new Error("Unknown generic Motion kind: " + kind);
  }
  return structuredClone(SEEDS[kind]);
}

const KINDS: readonly MotionGraphicKind[] = ["title", "card", "tag", "counter"];

/** Original authoring defaults; output artwork still requires art review. */
export const DEFAULT_MOTION_V2_PRESETS: readonly MotionGraphicPreset[] = deepFreeze(
  KINDS.map((kind): MotionGraphicPreset => ({
    id: SEEDS[kind].presetId,
    name: SEEDS[kind].name + " v2",
    family: "通用藍白圖卡 v2",
    license: "MIT",
    provenance:
      "Editkin original generic v2 authoring seed; output artwork review required; no prerecorded assets or aesthetic certification",
    renderer: "hao-motion-composition/v2",
    seed: defaultMotionGraphicV2Seed(kind),
    routing: {
      semanticRoles:
        kind === "title"
          ? ["title", "hook", "chapter"]
          : kind === "card"
            ? ["information", "steps", "proof"]
            : kind === "tag"
              ? ["subject_label", "source_label", "context"]
              : ["verified_metric", "number"],
      formats: ["9:16", "16:9", "1:1"],
      requires: ["none"],
      avoidWhen: ["dense_caption_region"],
      intensity: "low",
    },
  })),
);
