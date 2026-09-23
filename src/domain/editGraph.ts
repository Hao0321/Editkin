import type {
  CaptionCue,
  ColorAdjustments,
  EditProject,
  MediaAsset,
  ProjectSummary,
  TimelineClip,
  TimelineTrack,
  Transform2D,
} from "./types";
import { DEFAULT_CAPTION_STYLE, DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, particleSimulationEmitters } from "./types";
import { assertHaoExpression, evaluateHaoExpression } from "./expression";
import { ANIMATION_TIME_EPSILON, clipAnimationPoints } from "./clipAnimation";
import { isTransformMotionBlurInstance, transformMotionBlurParameters } from "./transformMotionBlur";
export { EditGraphError } from "./editGraphError";
import { EditGraphError } from "./editGraphError";
import { PRODUCT_AUTO_ROTO_ENGINE, productAutoRotoRouteReceiptShapeSchema } from "./autoRotoProductReceipt";

const EPSILON = 1e-6;
const DIRECTOR_REVIEW_STATES = new Set(["draft", "reviewing", "changes_requested", "ready_for_hao_review"]);
const LEGACY_DIRECTOR_REVIEW_STATES: Record<string, string> = {
  rough_cut: "reviewing",
  fine_cut: "reviewing",
  review_ready: "ready_for_hao_review",
  approved: "ready_for_hao_review",
  changes: "changes_requested",
};

export function alignTime(value: number, fps: number): number {
  return Math.round(value * fps) / fps;
}

export function createEmptyProject(
  name = "未命名影片",
  options: Partial<Pick<EditProject, "id" | "width" | "height" | "fps">> = {},
): EditProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 8,
    revision: 0,
    id: options.id ?? "project-untitled",
    name,
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
    editorialProfile: "auto",
    colorManagement: { ...DEFAULT_COLOR_MANAGEMENT },
    assets: [],
    compositions: [],
    tracks: [
      { id: "video-main", name: "主畫面", kind: "video", locked: false, muted: false, clips: [] },
      { id: "audio-main", name: "聲音", kind: "audio", locked: false, muted: false, clips: [] },
      { id: "caption-main", name: "字幕", kind: "caption", locked: false, muted: false, clips: [] },
    ],
    captions: [],
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
    motionTracks: [],
    motionGraphics: [],
    director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: now },
    updatedAt: now,
  };
}

export function migrateProject(input: unknown): EditProject {
  if (!input || typeof input !== "object") throw new EditGraphError("專案內容不是有效物件");
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== 4 && raw.schemaVersion !== 5 && raw.schemaVersion !== 6 && raw.schemaVersion !== 7 && raw.schemaVersion !== 8) {
    throw new EditGraphError(`不支援的 EditGraph schema：${String(raw.schemaVersion)}`);
  }
  const source = structuredClone(input) as Record<string, unknown>;
  source.revision ??= 0;
  if (raw.schemaVersion === 1) {
    source.captions = [];
    source.captionStyle = { ...DEFAULT_CAPTION_STYLE };
  }
  source.captionStyle = { ...DEFAULT_CAPTION_STYLE, ...(source.captionStyle as object | undefined) };
  const captions = Array.isArray(source.captions) ? source.captions as Array<Record<string, unknown>> : [];
  for (const caption of captions) {
    const translation = caption.translation;
    if (translation && typeof translation === "object") {
      const value = translation as Record<string, unknown>;
      if (typeof value.text !== "string" || typeof value.language !== "string" || !value.text.trim() || !value.language.trim()) delete caption.translation;
    }
  }
  source.motionTracks ??= [];
  source.motionGraphics ??= [];
  source.editorialProfile ??= "auto";
  source.aestheticSystem ??= undefined;
  source.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, ...(source.colorManagement as object | undefined) };
  source.compositions ??= [];
  const normalizeScene25d = (owner: Record<string, unknown>) => {
    const scene = owner.scene25d;
    if (!scene || typeof scene !== "object") return;
    const value = scene as Record<string, unknown>;
    value.camera = { ...DEFAULT_SCENE_25D.camera, ...(value.camera as object | undefined) };
    const camera = value.camera as Record<string, unknown>;
    camera.keyframes = Array.isArray(camera.keyframes) ? camera.keyframes : [];
    value.depthOfField = { ...DEFAULT_SCENE_25D.depthOfField, ...(value.depthOfField as object | undefined) };
    const lens = value.depthOfField as Record<string, unknown>;
    lens.keyframes = Array.isArray(lens.keyframes) ? lens.keyframes : [];
    value.ambientLight = { ...DEFAULT_SCENE_25D.ambientLight, ...(value.ambientLight as object | undefined) };
    const ambient = value.ambientLight as Record<string, unknown>;
    ambient.keyframes = Array.isArray(ambient.keyframes) ? ambient.keyframes : [];
    value.directionalLight = { ...DEFAULT_SCENE_25D.directionalLight, ...(value.directionalLight as object | undefined) };
    const directional = value.directionalLight as Record<string, unknown>;
    directional.keyframes = Array.isArray(directional.keyframes) ? directional.keyframes : [];
  };
  normalizeScene25d(source);
  for (const composition of source.compositions as Array<Record<string, unknown>>) normalizeScene25d(composition);
  const directorFallbackTime = typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString();
  const legacyDirector = source.director && typeof source.director === "object"
    ? source.director as Record<string, unknown>
    : {};
  const legacyReviewState = typeof legacyDirector.reviewState === "string" ? legacyDirector.reviewState : "draft";
  const mappedReviewState = DIRECTOR_REVIEW_STATES.has(legacyReviewState)
    ? legacyReviewState
    : LEGACY_DIRECTOR_REVIEW_STATES[legacyReviewState] ?? "draft";
  const legacyMarkers = Array.isArray(legacyDirector.markers) ? legacyDirector.markers : [];
  source.director = {
    schema: "editkin.director-console/v1",
    reviewState: mappedReviewState,
    markers: legacyMarkers.map((marker, index) => {
      const value = marker && typeof marker === "object" ? marker as Record<string, unknown> : {};
      const kind = typeof value.kind === "string" && ["beat", "note", "risk", "pickup"].includes(value.kind) ? value.kind : "note";
      const status = typeof value.status === "string" && ["open", "resolved"].includes(value.status) ? value.status : "open";
      return {
        id: typeof value.id === "string" && value.id ? value.id : `legacy-director-marker-${index + 1}`,
        time: typeof value.time === "number" && Number.isFinite(value.time) ? value.time : 0,
        title: typeof value.title === "string" ? value.title : "未命名註記",
        note: typeof value.note === "string" ? value.note : "",
        kind,
        status,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : directorFallbackTime,
        ...(value.templateOwner && typeof value.templateOwner === "object" ? { templateOwner: value.templateOwner } : {}),
      };
    }),
    updatedAt: typeof legacyDirector.updatedAt === "string" ? legacyDirector.updatedAt : directorFallbackTime,
  };
  const tracks = Array.isArray(source.tracks) ? source.tracks as Array<Record<string, unknown>> : [];
  const compositionTracks = (Array.isArray(source.compositions) ? source.compositions : []).flatMap((composition) => {
    if (!composition || typeof composition !== "object") return [];
    const nested = (composition as Record<string, unknown>).tracks;
    return Array.isArray(nested) ? nested as Array<Record<string, unknown>> : [];
  });
  for (const track of [...tracks, ...compositionTracks]) {
    const clips = Array.isArray(track.clips) ? track.clips as Array<Record<string, unknown>> : [];
    for (const clip of clips) {
      clip.transform ??= { ...DEFAULT_TRANSFORM };
      clip.color = { ...DEFAULT_COLOR, ...(clip.color as object | undefined) };
      clip.keyframes ??= [];
      clip.layer = { ...DEFAULT_CLIP_LAYER, ...(clip.layer as object | undefined) };
      clip.expressions ??= {};
      for (const keyframe of clip.keyframes as Array<Record<string, unknown>>) {
        keyframe.color = { ...(clip.color as ColorAdjustments), ...(keyframe.color as object | undefined) };
      }
      const masks = Array.isArray(clip.masks) ? clip.masks as Array<Record<string, unknown>> : [];
      for (const mask of masks) {
        const matte = mask.matteSequence;
        if (!matte || typeof matte !== "object") continue;
        const sequence = matte as Record<string, unknown>;
        const originalEngine = typeof sequence.engine === "string" && sequence.engine.trim()
          ? sequence.engine
          : "unknown";
        const productEngine = originalEngine === PRODUCT_AUTO_ROTO_ENGINE;
        const attested = productEngine && productAutoRotoRouteReceiptShapeSchema.safeParse(sequence.routeReceipt).success;
        if (attested) continue;
        const originalManifestUri = typeof sequence.manifestUri === "string" && sequence.manifestUri.trim()
          ? sequence.manifestUri
          : undefined;
        const rawSequenceSha256 = typeof sequence.sequenceSha256 === "string" ? sequence.sequenceSha256.toLowerCase() : undefined;
        const originalSequenceSha256 = rawSequenceSha256 && /^[a-f0-9]{64}$/.test(rawSequenceSha256)
          ? rawSequenceSha256
          : undefined;
        const originalQualityState = typeof sequence.qualityState === "string" && sequence.qualityState.trim()
          ? sequence.qualityState
          : undefined;
        mask.retiredAutoRotoRecord = {
          schema: "editkin.retired-auto-roto-record/v1",
          reason: productEngine ? "unattested-product-artifact" : "non-product-engine",
          originalEngine,
          ...(originalManifestUri ? { originalManifestUri } : {}),
          ...(originalSequenceSha256 ? { originalSequenceSha256 } : {}),
          ...(originalQualityState ? { originalQualityState } : {}),
        };
        delete mask.matteSequence;
      }
    }
  }
  source.schemaVersion = 8;
  return source as unknown as EditProject;
}

export function cloneProject(project: EditProject): EditProject {
  return structuredClone(project);
}

export function projectDuration(project: EditProject): number {
  const mediaDuration = project.tracks.reduce(
    (max, track) => track.clips.reduce(
      (trackMax, clip) => Math.max(trackMax, clip.timelineStart + clip.duration),
      max,
    ),
    0,
  );
  const captionDuration = project.captions.reduce((max, caption) => Math.max(max, caption.start + caption.duration), mediaDuration);
  return project.motionGraphics.reduce((max, graphic) => Math.max(max, graphic.timelineStart + graphic.duration), captionDuration);
}

export function findAsset(project: EditProject, assetId: string): MediaAsset {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) throw new EditGraphError(`找不到素材：${assetId}`);
  return asset;
}

export function findTrack(project: EditProject, trackId: string): TimelineTrack {
  const track = project.tracks.find((item) => item.id === trackId);
  if (!track) throw new EditGraphError(`找不到軌道：${trackId}`);
  return track;
}

export function findClip(project: EditProject, clipId: string): TimelineClip {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return clip;
  }
  throw new EditGraphError(`找不到片段：${clipId}`);
}

export function findCaption(project: EditProject, captionId: string): CaptionCue {
  const caption = project.captions.find((item) => item.id === captionId);
  if (!caption) throw new EditGraphError(`找不到字幕：${captionId}`);
  return caption;
}

export function activeVideoClip(project: EditProject, time: number): TimelineClip | undefined {
  const videoTracks = project.tracks.filter((track) => track.kind === "video" && !track.muted).reverse();
  for (const track of videoTracks) {
    const clip = [...track.clips]
      .reverse()
      .find((item) => time + EPSILON >= item.timelineStart
        && time < item.timelineStart + item.duration - EPSILON);
    if (clip) return clip;
  }
  return undefined;
}

function interpolateValues<T extends Transform2D | ColorAdjustments>(previous: T, next: T, ratio: number): T {
  return Object.fromEntries(Object.keys(previous).map((key) => {
    const property = key as keyof T;
    const previousValue = Number(previous[property]);
    const nextValue = Number(next[property]);
    return [property, previousValue + (nextValue - previousValue) * ratio];
  })) as unknown as T;
}

export function easingProgress(ratio: number, easing: import("./types").KeyframeEasing): number {
  const value = Math.max(0, Math.min(1, ratio));
  if (easing === "hold") return 0;
  if (easing === "ease_in") return value * value;
  if (easing === "ease_out") return 1 - (1 - value) * (1 - value);
  if (easing === "ease_in_out") return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
  if (easing === "spring_soft") return Math.max(0, Math.min(1.08, 1 - Math.exp(-6 * value) * Math.cos(8 * value)));
  return value;
}

export function animatedClipState(clip: TimelineClip, localTime: number, fps = 30): { transform: Transform2D; color: ColorAdjustments } {
  const time = Math.max(0, Math.min(clip.duration, localTime));
  const points = clipAnimationPoints(clip);
  // Segments are [current, next): the next authored value owns its timestamp,
  // including Hold and spring endpoints. Subtraction noise must not delay it.
  const nextIndex = points.findIndex((point) => point.time > time + ANIMATION_TIME_EPSILON);
  let state: { transform: Transform2D; color: ColorAdjustments };
  if (nextIndex < 0) {
    const point = points.at(-1)!;
    state = { transform: { ...point.transform }, color: { ...point.color } };
  } else if (nextIndex === 0) {
    const point = points[0];
    state = { transform: { ...point.transform }, color: { ...point.color } };
  } else {
    const previous = points[nextIndex - 1];
    const next = points[nextIndex];
    if (previous.easing === "hold" || next.time === previous.time) state = { transform: { ...previous.transform }, color: { ...previous.color } };
    else {
      const ratio = easingProgress((time - previous.time) / (next.time - previous.time), previous.easing);
      state = {
        transform: interpolateValues(previous.transform, next.transform, ratio),
        color: interpolateValues(previous.color, next.color, ratio),
      };
    }
  }
  const entrance = Math.max(0, Math.min(1, time / Math.min(0.28, Math.max(1 / fps, clip.duration / 3))));
  const exit = Math.max(0, Math.min(1, (clip.duration - time) / Math.min(0.28, Math.max(1 / fps, clip.duration / 3))));
  for (const [property, expression] of Object.entries(clip.expressions ?? {}) as Array<[keyof Transform2D, string]>) {
    state.transform[property] = evaluateHaoExpression(expression, {
      frame: Math.round(time * fps), fps, time, inPoint: 0, outPoint: clip.duration, duration: clip.duration,
      value: state.transform[property], entrance, exit,
    });
  }
  return state;
}

export function summarizeProject(project: EditProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    resolution: `${project.width}x${project.height}`,
    fps: project.fps,
    duration: projectDuration(project),
    assetCount: project.assets.length,
    trackCount: project.tracks.length,
    clipCount: project.tracks.reduce((sum, track) => sum + track.clips.length, 0),
    captionCount: project.captions.length,
  };
}


export { projectFromComposition } from "./projectComposition";
export { validateClipForTrack, validateMediaAsset, validateProject } from "./projectValidation";
