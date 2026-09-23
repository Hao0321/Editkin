export * from "./visualTypes";
import type {
  CaptionCue, CaptionStyle, ClipLayerState, ColorAdjustments, ColorManagementSettings, CreativeTransition, MediaAsset, MotionTrack,
  ParticleSimulationSettings, Scene25dSettings, TemplateElementOwner, TimelineTrack, Transform2D, Transform3D,
} from "./visualTypes";


export type EditorialProfileId = "auto" | "gaming" | "food" | "travel" | "podcast_on_camera" | "podcast_no_face";

export type AestheticReviewStatus = "REVIEW" | "BLOCKED" | "PASSED";
export type AestheticBenchmarkAxis = "mrbeast_information_energy" | "yingshi_hurricane_cinematic_craft";
export interface AestheticArtifactBinding { outputSha256: string; fps: number; durationFrames: number }
export interface AestheticBenchmarkItemReview {
  rating?: number;
  evidence: { fromFrame: number; toFrame: number; observation: string }[];
}
export interface AestheticBenchmarkReview {
  schema: "editkin.aesthetic-benchmark-review/v1";
  artifact?: AestheticArtifactBinding;
  axes: Partial<Record<AestheticBenchmarkAxis, Record<string, AestheticBenchmarkItemReview>>>;
}

export interface AestheticDimension {
  id: string;
  labelZh: string;
  question: string;
  weight: number;
}

export interface AestheticReview {
  status: AestheticReviewStatus;
  score: number;
  ratings: Record<string, number>;
  machineBlockers: string[];
  completedAt?: string;
  benchmarkReview?: AestheticBenchmarkReview;
}

export interface AestheticSystem {
  schema: "editkin.aesthetic-system/v1";
  standardId: "editkin-community-aesthetic-standard";
  standardVersion: string;
  sourceSha256: string;
  format: "shorts" | "longform";
  domain: string;
  primaryFamily: string;
  primaryLabel: string;
  supportFamilies: string[];
  avoid: string[];
  sharedDnaSha256: string;
  dimensions: AestheticDimension[];
  scoreContract: { passScore: number; blockBelow: number; minimumDimensionRating: number; humanReviewRequired: true };
  review: AestheticReview;
}

export type MotionGraphicKind = "title" | "card" | "tag" | "counter";
export type MotionGraphicAnimation = "fade" | "slide_up" | "pop" | "spring_soft";
export type MotionGraphicTrackingMode = "anchor" | "surface";
export type MotionGraphicVisualStyle =
  | "solid_panel"
  | "holo_scan_cyan"
  | "holo_grid_lime"
  | "target_lock_red"
  | "spectral_wire_violet"
  | "depth_glass_blue"
  | "telemetry_beam_amber"
  | "neon_extrude_white"
  | "quantum_label_magenta";
export type MotionCompositionSchema = "hao.motion-composition/v1" | "hao.motion-composition/v2";
export type MotionGraphicV2SequenceUnit = "all" | "word" | "character";
export type MotionGraphicV2SequenceOrder = "forward" | "reverse" | "center_out";

export type MotionGraphicV2Easing =
  | { type: "linear" }
  | { type: "ease_in" }
  | { type: "ease_out" }
  | { type: "ease_in_out" }
  | { type: "cubic_bezier"; x1: number; y1: number; x2: number; y2: number }
  | { type: "spring"; stiffness: number; damping: number; mass: number; initialVelocity: number };

export interface MotionGraphicV2Phase {
  durationFrames: number;
  offsetXPixels: number;
  offsetYPixels: number;
  scale: number;
  opacity: number;
  easing: MotionGraphicV2Easing;
}

export interface MotionGraphicV2Motion {
  sequence: {
    unit: MotionGraphicV2SequenceUnit;
    order: MotionGraphicV2SequenceOrder;
    exitOrder: MotionGraphicV2SequenceOrder;
    staggerFrames: number;
  };
  entrance: MotionGraphicV2Phase;
  exit: MotionGraphicV2Phase;
}

export interface MotionGraphicV2Layout {
  safeArea: { top: number; right: number; bottom: number; left: number };
  maxLines: number;
  minFontSize: number;
  lineGap: number;
  align: "left" | "center" | "right";
  /** Omitted preserves the authored fixed-width slot in existing projects. */
  widthMode?: "fixed" | "fit_content";
}

export interface MotionGraphic {
  schema: MotionCompositionSchema;
  id: string;
  presetId?: string;
  name: string;
  kind: MotionGraphicKind;
  text: string;
  timelineStart: number;
  duration: number;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily?: string;
  fontWeight?: number;
  letterSpacing?: number;
  outlineWidth?: number;
  shadowDepth?: number;
  cornerRadius?: number;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
  /** Procedural renderer material. Text remains project data and is never baked into the preset. */
  visualStyle?: MotionGraphicVisualStyle;
  animation: MotionGraphicAnimation;
  trackId?: string;
  trackingMode?: MotionGraphicTrackingMode;
  offsetX: number;
  offsetY: number;
  motionV2?: MotionGraphicV2Motion;
  layoutV2?: MotionGraphicV2Layout;
  templateOwner?: TemplateElementOwner;
}

export type MotionGraphicPresetSeed = Partial<Omit<MotionGraphic, "id" | "timelineStart" | "duration" | "trackId">> & { presetId: string };

export type DirectorMarkerKind = "beat" | "note" | "risk" | "pickup";
export type DirectorMarkerStatus = "open" | "resolved";
export type DirectorReviewState = "draft" | "reviewing" | "changes_requested" | "ready_for_hao_review";

export interface DirectorMarker {
  id: string;
  time: number;
  title: string;
  note: string;
  kind: DirectorMarkerKind;
  status: DirectorMarkerStatus;
  createdAt: string;
  templateOwner?: TemplateElementOwner;
}

export interface TemplateCreativeSnapshot {
  clipId: string;
  creativePresent: boolean;
  lookPresetId: string | null;
  effectPresetIds: string[];
  transitionIn: CreativeTransition | null;
  transitionOut: CreativeTransition | null;
}

export interface TemplateApplicationSnapshot {
  editorialProfile: EditorialProfileId;
  aestheticSystem: AestheticSystem | null;
  captionStyle: CaptionStyle;
  clips: TemplateCreativeSnapshot[];
}

/** Reversible ownership receipt for the one active movie template. */
export interface TemplateApplicationState {
  schema: "editkin.template-application/v1";
  sessionId: string;
  templateId: string;
  templateName: string;
  format: "short" | "long";
  createdAt: string;
  before: TemplateApplicationSnapshot;
  applied: TemplateApplicationSnapshot;
}

export interface DirectorState {
  schema: "editkin.director-console/v1";
  reviewState: DirectorReviewState;
  markers: DirectorMarker[];
  updatedAt: string;
}

export interface EditComposition {
  schema: "editkin.composition/v1";
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  tracks: TimelineTrack[];
  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  motionTracks: MotionTrack[];
  motionGraphics: MotionGraphic[];
  director: DirectorState;
  colorManagement?: ColorManagementSettings;
  scene25d?: Scene25dSettings;
  particleSimulation?: ParticleSimulationSettings;
  updatedAt: string;
}

export interface EditProject {
  schemaVersion: 8;
  revision: number;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  editorialProfile: EditorialProfileId;
  aestheticSystem?: AestheticSystem;
  colorManagement?: ColorManagementSettings;
  scene25d?: Scene25dSettings;
  particleSimulation?: ParticleSimulationSettings;
  assets: MediaAsset[];
  compositions: EditComposition[];
  tracks: TimelineTrack[];
  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  motionTracks: MotionTrack[];
  motionGraphics: MotionGraphic[];
  director: DirectorState;
  templateApplication?: TemplateApplicationState;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  resolution: string;
  fps: number;
  duration: number;
  assetCount: number;
  trackCount: number;
  clipCount: number;
  captionCount: number;
}

export const DEFAULT_TRANSFORM: Transform2D = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
};

export const DEFAULT_TRANSFORM_3D: Transform3D = {
  position: [0, 0, 0],
  rotationDegrees: [0, 0, 0],
  scale: [1, 1, 1],
};

export const DEFAULT_SCENE_25D: Scene25dSettings = {
  schema: "editkin.scene-25d/v1",
  enabled: true,
  camera: {
    position: [0, 0, 4],
    target: [0, 0, 0],
    up: [0, 1, 0],
    verticalFovDegrees: 60,
    near: 0.1,
    far: 20,
    keyframes: [],
  },
  depthOfField: { enabled: false, focusDistance: 4, aperture: 2.8, maxBlurRadius: 12, keyframes: [] },
  ambientLight: { color: [1, 1, 1], intensity: 0.28, keyframes: [] },
  directionalLight: { color: [1, 0.92, 0.78], intensity: 0.92, direction: [0.2, -0.25, 1], keyframes: [] },
};

export const DEFAULT_PARTICLE_SIMULATION: ParticleSimulationSettings = {
  schema: "editkin.particle-simulation/v1",
  enabled: true,
  seed: 32021,
  ratePerSecond: 48,
  lifetimeSeconds: 1.25,
  maxParticles: 64,
  emitterPosition: [0.5, 0.72],
  initialVelocity: [18, -76],
  gravity: [0, 82],
  radiusPixels: 3.25,
  color: [1, 0.42, 0.06, 0.92],
};

export const DEFAULT_CLIP_LAYER: ClipLayerState = {
  enabled: true,
  blendMode: "normal",
  role: "content",
};

export const DEFAULT_COLOR: ColorAdjustments = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  hue: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  whiteBalanceRed: 0,
  whiteBalanceGreen: 0,
  whiteBalanceBlue: 0,
  pivot: 0.5,
  shadows: 0,
  highlights: 0,
  blacks: 0,
  whites: 0,
};

export const DEFAULT_COLOR_MANAGEMENT: ColorManagementSettings = {
  mode: "rec709",
  workingSpace: "ACEScct",
  outputTransform: "rec709_sdr",
  configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5",
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  presetId: "clean_caption",
  fontFamily: "Noto Sans TC",
  fontSize: 54,
  color: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 4,
  alignment: 2,
  marginV: 72,
  bold: true,
  italic: false,
  shadow: 1,
  backgroundColor: "#00000000",
  letterSpacing: 0,
  translationFontFamily: "Noto Sans TC",
  translationFontSize: 36,
  translationColor: "#DCE8FF",
  translationBold: true,
  translationItalic: false,
};
