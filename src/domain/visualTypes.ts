import type { ProductAutoRotoRouteReceipt } from "./autoRotoProductReceipt";

export type AssetKind = "video" | "audio" | "image";
export type TrackKind = "video" | "audio" | "caption";
export type HaoExpressionSource = `hao.expression/v1:${string}`;
export type SourceAlphaMode = "auto" | "opaque" | "straight" | "premultiplied";

export interface OpenExrImageSequence {
  schema: "editkin.openexr-sequence/v1";
  format: "openexr";
  frameCount: number;
  startFrame: number;
  lastFrame: number;
  timebase: { numerator: number; denominator: number };
  sequenceSha256: string;
  manifestSha256: string;
  previewUri: string;
}

export type ChromaKeyScreen = "green" | "blue";

/**
 * A deliberately closed, self-authored screen-key contract. It is separate from Auto Roto:
 * this path assumes a photographed green/blue backing and produces fractional alpha directly
 * from source pixels. The fixed engine id keeps saved projects reproducible as later keyers ship.
 */
export interface ChromaKeySettings {
  schema: "editkin.chroma-key/v1";
  engine: "editkin-chroma-distance-keyer/v1";
  enabled: boolean;
  screen: ChromaKeyScreen;
  screenColor: string;
  similarity: number;
  softness: number;
  edgeBias: number;
  despill: number;
}

export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  timelineStart: number;
  sourceStart: number;
  duration: number;
  volume: number;
  transform: Transform2D;
  /** Present only when the containing project/composition enables the bounded 2.5D scene. */
  transform3d?: Transform3D;
  color: ColorAdjustments;
  keyframes: ClipKeyframe[];
  creative?: ClipCreativeState;
  layout?: ClipLayout;
  masks?: ClipMask[];
  chromaKey?: ChromaKeySettings;
  layer?: ClipLayerState;
  expressions?: ClipExpressionBindings;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TrackKind;
  locked: boolean;
  muted: boolean;
  clips: TimelineClip[];
}

export interface CaptionCue {
  id: string;
  text: string;
  start: number;
  duration: number;
  templateOwner?: TemplateElementOwner;
  translation?: {
    text: string;
    language: string;
  };
}

/**
 * Explicit, persisted ownership for elements created by a movie template.
 * IDs and visible copy are intentionally not ownership signals: users may
 * legitimately use the same words or ID prefixes in their own work.
 */
export interface TemplateElementOwner {
  schema: "editkin.template-element-owner/v1";
  sessionId: string;
  templateId: string;
  format: "short" | "long";
  role: string;
}

export interface CaptionStyle {
  presetId: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  alignment: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  marginV: number;
  bold: boolean;
  italic: boolean;
  shadow: number;
  backgroundColor: string;
  letterSpacing: number;
  translationFontFamily: string;
  translationFontSize: number;
  translationColor: string;
  translationBold: boolean;
  translationItalic: boolean;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MotionTrackPoint {
  frame: number;
  time: number;
  rect: NormalizedRect;
  confidence: number;
  status: "tracked" | "held" | "lost" | "manual";
  activity?: number;
  rotationDegrees?: number;
  scale?: number;
  quad?: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export type SpeakerRole = "subject" | "host" | "guest";

export interface MotionTrack {
  id: string;
  clipId: string;
  name: string;
  engine: string;
  analysisFps: number;
  initialRect: NormalizedRect;
  points: MotionTrackPoint[];
  lostRatio: number;
  createdAt: string;
  role?: SpeakerRole;
}

export interface MediaAsset {
  id: string;
  name: string;
  kind: AssetKind;
  uri: string;
  duration: number;
  width?: number;
  height?: number;
  role?: string;
  bpm?: number;
  license?: string;
  provenance?: string;
  redistributable?: boolean;
  rightsBasis?: string;
  distributionScope?: string;
  /** Declares how RGB is encoded relative to alpha at the imported source boundary. */
  alphaMode?: SourceAlphaMode;
  /** A verified frame-sequence manifest. `uri` points at the manifest, not a single frame. */
  imageSequence?: OpenExrImageSequence;
  color?: MediaColorMetadata;
  derivatives?: MediaDerivatives;
  /** Points at an in-project composition. Its URI remains a stable virtual URI
   * until the render pipeline materializes the composition. */
  compositionId?: string;
}

export type InputColorSpace = "auto" | "rec709" | "linear_rec709" | "srgb" | "hlg" | "pq" | "acescct" | "apple_log" | "arri_logc3" | "arri_logc4" | "bmd_film_gen5" | "canon_log2" | "canon_log3" | "dji_dlog" | "panasonic_vlog" | "red_log3g10" | "sony_slog3_cine" | "log_unresolved";
export type ColorPipelineMode = "rec709" | "aces2";
export type AcesOutputTransform = "rec709_sdr" | "p3d65_sdr" | "rec2100_hlg_1000" | "rec2100_pq_1000";

export interface ColorManagementSettings {
  mode: ColorPipelineMode;
  workingSpace: "ACEScct";
  outputTransform: AcesOutputTransform;
  configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5";
}

export interface MediaColorMetadata {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  range?: string;
  interpretation: InputColorSpace;
}

export interface MediaDerivatives {
  sourceSha256: string;
  proxyUri?: string;
  proxyWidth?: number;
  proxyHeight?: number;
  /** Actual display-proxy encoding; never replaces the original asset colour. */
  proxyColor?: MediaColorMetadata;
  proxyColorContract?: "editkin.browser-display-proxy/v1";
  /** Generation freshness, separate from the encoding interpretation above. */
  previewRecipe?: string;
  overlayProxyUri?: string;
  overlayProxyWidth?: number;
  overlayProxyHeight?: number;
  overlayProxyFrameRateNumerator?: number;
  overlayProxyFrameRateDenominator?: number;
  overlayProxyProfile?: "editkin-small-overlay-performance/v1";
  thumbnailUri?: string;
  waveformUri?: string;
  generatedAt: string;
}

export interface Transform2D {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface Transform3D {
  /** Native 2.5D world units; the default camera frames a 16:9 plane around z=0. */
  position: [number, number, number];
  rotationDegrees: [number, number, number];
  scale: [number, number, number];
}

export interface Scene25dSettings {
  schema: "editkin.scene-25d/v1";
  enabled: boolean;
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    verticalFovDegrees: number;
    near: number;
    far: number;
    /** Project-time camera animation sampled before native projection. */
    keyframes: Scene25dCameraKeyframe[];
  };
  depthOfField: {
    enabled: boolean;
    /** Camera-space world distance; must remain strictly between the near and far planes. */
    focusDistance: number;
    /** Bounded circle-of-confusion gain used by the native gather kernel. */
    aperture: number;
    /** Maximum full-resolution gather radius in output pixels. */
    maxBlurRadius: number;
    /** Project-time camera-lens animation sampled by the native graph at every frame. */
    keyframes: Scene25dDepthOfFieldKeyframe[];
  };
  ambientLight: {
    color: [number, number, number];
    intensity: number;
    /** Neutral ambient intensity sampled before native per-plane lighting. */
    keyframes: Scene25dAmbientLightKeyframe[];
  };
  directionalLight: {
    color: [number, number, number];
    intensity: number;
    direction: [number, number, number];
    /** Project-time directional-light animation sampled before native shading. */
    keyframes: Scene25dDirectionalLightKeyframe[];
  };
}

export interface ParticleEmitterParameters {
  /** Omitted for legacy/full-project coverage; present for a beat-bounded VFX interval. */
  timeline?: { start: number; duration: number };
  seed: number;
  ratePerSecond: number;
  lifetimeSeconds: number;
  maxParticles: number;
  emitterPosition: [number, number];
  initialVelocity: [number, number];
  gravity: [number, number];
  radiusPixels: number;
  color: [number, number, number, number];
}

export interface ParticleEmitterSettings extends ParticleEmitterParameters {
  /** Stable project identity. `primary` is reserved for the legacy top-level emitter. */
  id: string;
}

export interface ParticleSimulationSettings extends ParticleEmitterParameters {
  schema: "editkin.particle-simulation/v1";
  enabled: boolean;
  /** Backward-compatible multi-emitter extension; the top-level fields remain emitter one. */
  additionalEmitters?: ParticleEmitterSettings[];
}

export function particleSimulationEmitters(settings: ParticleSimulationSettings): ParticleEmitterSettings[] {
  const { schema: _schema, enabled: _enabled, additionalEmitters, ...primary } = settings;
  return [{ id: "primary", ...primary }, ...(additionalEmitters ?? [])];
}

export interface ColorAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  exposure: number;
  temperature: number;
  tint: number;
  /** Absolute log2 channel gains in straight linear Rec.709, separate from artistic temperature/tint. */
  whiteBalanceRed: number;
  whiteBalanceGreen: number;
  whiteBalanceBlue: number;
  pivot: number;
  shadows: number;
  highlights: number;
  blacks: number;
  whites: number;
}

export type KeyframeEasing = "linear" | "hold" | "ease_in" | "ease_out" | "ease_in_out" | "spring_soft";

export interface Scene25dCameraKeyframe {
  id: string;
  time: number;
  position: [number, number, number];
  target: [number, number, number];
  verticalFovDegrees: number;
  easing: KeyframeEasing;
}

export interface Scene25dDepthOfFieldKeyframe {
  id: string;
  time: number;
  focusDistance: number;
  aperture: number;
  maxBlurRadius: number;
  easing: KeyframeEasing;
}

export interface Scene25dAmbientLightKeyframe {
  id: string;
  time: number;
  intensity: number;
  easing: KeyframeEasing;
}

export interface Scene25dDirectionalLightKeyframe {
  id: string;
  time: number;
  color: [number, number, number];
  intensity: number;
  direction: [number, number, number];
  easing: KeyframeEasing;
}

export interface ClipKeyframe {
  id: string;
  time: number;
  transform: Transform2D;
  color: ColorAdjustments;
  easing: KeyframeEasing;
}

export interface CreativeTransition {
  presetId: string;
  duration: number;
}

export type NativeEffectParameterValue = string | number | boolean;

export interface NativeEffectInstance {
  id: string;
  pluginId: string;
  capabilityId: string;
  pluginVersion: string;
  manifestSha256: string;
  /** Missing on schema-v8 projects created before GPU effect graphs existed. */
  runtimeType?: "native_effect" | "gpu_effect_graph";
  enabled: boolean;
  parameters: Record<string, NativeEffectParameterValue>;
}

export interface ClipCreativeState {
  lookPresetId?: string;
  effectPresetIds: string[];
  nativeEffectInstances?: NativeEffectInstance[];
  transitionIn?: CreativeTransition;
  transitionOut?: CreativeTransition;
}

export type LayerBlendMode = "normal" | "add" | "screen" | "multiply" | "overlay" | "soft_light" | "hard_light" | "difference" | "darken" | "lighten" | "color_dodge" | "color_burn";
export type LayerRole = "content" | "adjustment" | "controller";
export type TrackMatteMode = "alpha" | "alpha_inverted" | "luma" | "luma_inverted";

export interface ClipTrackMatte {
  sourceClipId: string;
  mode: TrackMatteMode;
}

export interface ClipLayerState {
  enabled: boolean;
  blendMode: LayerBlendMode;
  role?: LayerRole;
  parentClipId?: string;
  trackMatte?: ClipTrackMatte;
}

export type ClipExpressionProperty = keyof Transform2D;
export type ClipExpressionBindings = Partial<Record<ClipExpressionProperty, HaoExpressionSource>>;

export interface ClipLayout {
  crop: NormalizedRect;
  viewport: NormalizedRect;
}

export type MaskShapeKind = "rectangle" | "ellipse" | "polygon" | "subject";
export type MaskCombineMode = "add" | "subtract" | "intersect";
export type MaskPointStatus = "tracked" | "held" | "lost" | "manual";

export interface MaskPathPoint {
  id: string;
  x: number;
  y: number;
}

export interface MaskKeyframe {
  frame: number;
  time: number;
  points: MaskPathPoint[];
  confidence: number;
  status: MaskPointStatus;
}

export interface MaskRefineSettings {
  edgeShift: number;
  contrast: number;
  chatterReduction: number;
}

export interface RotoCorrectionStroke {
  id: string;
  frame: number;
  mode: "foreground" | "background";
  radius: number;
  points: Array<{ x: number; y: number }>;
}

export interface OpticalAlphaRefinementAggregate {
  schema: "editkin.optical-alpha-refinement-aggregate/v1";
  engine: "editkin-self-authored-optical-alpha-refiner/v1";
  appliedFrames: number;
  radius: number;
  backgroundThreshold: number;
  foregroundThreshold: number;
  coarseWeight: number;
  temporalStability: number;
  temporalGate: number;
  changedPixels: number;
  fractionalPixels: number;
  solvedPixels: number;
  meanSolveConfidence: number;
}

export interface RotoMatteSequence {
  schema: "editkin.auto-roto-matte/v1";
  engine: "editkin-native-color-temporal-roto/v1";
  width: number;
  height: number;
  analysisFps: number;
  frameCount: number;
  sequenceUri: string;
  sequenceSha256?: string;
  sequenceBytes?: number;
  manifestUri: string;
  framePreviewUris?: string[];
  frameArtifactUris?: string[];
  meanBoundaryChatter: number;
  correctionStrokesApplied?: number;
  correctedFrames?: number[];
  alphaRefinement?: OpticalAlphaRefinementAggregate;
  regionMemoryRouting?: {
    schema: "editkin.region-memory-routing/v1";
    requested: "fixed_baseline";
    executed: "fixed_baseline";
    candidateAttempted: false;
    deterministicFallback: false;
  };
  routeReceipt?: ProductAutoRotoRouteReceipt;
  stale?: boolean;
  /** The old artifact remains attested, but its frame clock no longer matches this clip. */
  staleReason?: "clip-time-range-changed";
  frozen: true;
  qualityState: "diagnostic";
}

export interface RetiredAutoRotoRecord {
  schema: "editkin.retired-auto-roto-record/v1";
  reason: "non-product-engine" | "unattested-product-artifact";
  originalEngine: string;
  originalManifestUri?: string;
  originalSequenceSha256?: string;
  originalQualityState?: string;
}

export interface ClipMask {
  id: string;
  name: string;
  kind: MaskShapeKind;
  mode: MaskCombineMode;
  enabled: boolean;
  inverted: boolean;
  opacity: number;
  feather: number;
  expansion: number;
  path: MaskPathPoint[];
  keyframes: MaskKeyframe[];
  trackId?: string;
  refine: MaskRefineSettings;
  frozenRange?: { fromFrame: number; toFrame: number };
  matteSequence?: RotoMatteSequence;
  retiredAutoRotoRecord?: RetiredAutoRotoRecord;
  rotoCorrections?: RotoCorrectionStroke[];
}
