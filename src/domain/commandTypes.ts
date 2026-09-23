import type { SmartCutKeepRange } from "./smartCut";
import type {
  CaptionCue,
  CaptionStyle,
  AestheticReview,
  AestheticSystem,
  ColorManagementSettings,
  ClipLayout,
  ClipMask,
  ChromaKeySettings,
  ClipKeyframe,
  ColorAdjustments,
  CreativeTransition,
  DirectorMarker,
  DirectorReviewState,
  EditorialProfileId,
  InputColorSpace,
  ClipExpressionProperty,
  HaoExpressionSource,
  LayerBlendMode,
  ClipLayerState,
  MediaAsset,
  NativeEffectInstance,
  MotionGraphic,
  MotionTrack,
  MotionTrackPoint,
  TimelineClip,
  TimelineTrack,
  Transform2D,
  Transform3D,
  Scene25dSettings,
  ParticleSimulationSettings,
  TemplateApplicationState,
} from "./types";

export type CaptionPatch = Partial<Pick<CaptionCue, "text" | "start" | "duration">> & { translation?: CaptionCue["translation"] | null };

export type EditorCommand =
  | { type: "import_asset"; asset: MediaAsset }
  | { type: "delete_asset"; assetId: string }
  | { type: "add_clip"; clip: TimelineClip }
  | { type: "add_track"; track: TimelineTrack }
  | { type: "precompose_clips"; compositionId: string; assetId: string; replacementClipId: string; targetTrackId: string; name: string; clipIds: string[] }
  | { type: "delete_track"; trackId: string }
  | { type: "rename_track"; trackId: string; name: string }
  | { type: "toggle_track_lock"; trackId: string }
  | { type: "toggle_track_mute"; trackId: string }
  | { type: "move_clip_to_track"; clipId: string; trackId: string; timelineStart: number }
  | { type: "split_clip"; clipId: string; at: number; newClipId: string }
  | { type: "delete_clip"; clipId: string }
  | { type: "ripple_delete_clip"; clipId: string }
  | { type: "move_clip"; clipId: string; timelineStart: number }
  | { type: "trim_clip_start"; clipId: string; seconds: number }
  | { type: "trim_clip_end"; clipId: string; seconds: number }
  | { type: "set_clip_volume"; clipId: string; volume: number }
  | { type: "compact_track"; trackId: string }
  | { type: "smart_cut_clip"; clipId: string; keepRanges: SmartCutKeepRange[]; segmentIds: string[] }
  | { type: "update_clip_transform"; clipId: string; patch: Partial<Transform2D> }
  | { type: "configure_scene_25d"; enabled: boolean }
  | { type: "set_scene_25d_settings"; settings: Scene25dSettings }
  | { type: "update_clip_transform_3d"; clipId: string; patch: Partial<Transform3D> }
  | { type: "configure_particle_simulation"; enabled: boolean }
  | { type: "set_particle_simulation_settings"; settings: ParticleSimulationSettings }
  | { type: "set_clip_color"; clipId: string; patch: Partial<ColorAdjustments> }
  | { type: "set_clip_creative"; clipId: string; patch: { lookPresetId?: string | null; effectPresetIds?: string[]; transitionIn?: CreativeTransition | null; transitionOut?: CreativeTransition | null } }
  | { type: "add_native_effect"; clipId: string; instance: NativeEffectInstance }
  | { type: "update_native_effect"; clipId: string; instanceId: string; patch: Partial<Pick<NativeEffectInstance, "enabled" | "parameters">> }
  | { type: "reorder_native_effect"; clipId: string; instanceId: string; toIndex: number }
  | { type: "remove_native_effect"; clipId: string; instanceId: string }
  | { type: "set_clip_layout"; clipId: string; layout?: ClipLayout }
  | { type: "add_clip_mask"; clipId: string; mask: ClipMask }
  | { type: "update_clip_mask"; clipId: string; maskId: string; patch: Partial<Omit<ClipMask, "id">> }
  | { type: "delete_clip_mask"; clipId: string; maskId: string }
  | { type: "set_clip_mask_track"; clipId: string; maskId: string; trackId?: string }
  | { type: "set_clip_mask_keyframe"; clipId: string; maskId: string; keyframe: ClipMask["keyframes"][number] }
  | { type: "freeze_clip_mask_range"; clipId: string; maskId: string; fromFrame: number; toFrame: number }
  | { type: "set_clip_chroma_key"; clipId: string; settings?: ChromaKeySettings }
  | { type: "set_clip_layer"; clipId: string; patch: Partial<ClipLayerState> }
  | { type: "set_clip_expression"; clipId: string; property: ClipExpressionProperty; expression: HaoExpressionSource | null }
  | { type: "add_keyframe"; clipId: string; keyframe: ClipKeyframe }
  | { type: "update_keyframe"; clipId: string; keyframeId: string; patch: Partial<Pick<ClipKeyframe, "time" | "transform" | "color" | "easing">> }
  | { type: "delete_keyframe"; clipId: string; keyframeId: string }
  | { type: "add_motion_track"; track: MotionTrack }
  | { type: "delete_motion_track"; trackId: string }
  | { type: "set_motion_track_point"; trackId: string; point: MotionTrackPoint }
  | { type: "add_motion_graphic"; graphic: MotionGraphic }
  | { type: "update_motion_graphic"; graphicId: string; patch: Partial<Omit<MotionGraphic, "schema" | "id">> }
  | { type: "delete_motion_graphic"; graphicId: string }
  | { type: "set_asset_derivatives"; assetId: string; derivatives?: MediaAsset["derivatives"] }
  | { type: "set_asset_color_interpretation"; assetId: string; interpretation: InputColorSpace }
  | { type: "set_asset_alpha_mode"; assetId: string; alphaMode: NonNullable<MediaAsset["alphaMode"]> }
  | { type: "set_project_color_management"; patch: Partial<Pick<ColorManagementSettings, "mode" | "outputTransform">> }
  | { type: "add_caption"; caption: CaptionCue }
  | { type: "update_caption"; captionId: string; patch: CaptionPatch }
  | { type: "delete_caption"; captionId: string }
  | { type: "set_caption_style"; patch: Partial<CaptionStyle> }
  | { type: "add_director_marker"; marker: DirectorMarker }
  | { type: "update_director_marker"; markerId: string; patch: Partial<Pick<DirectorMarker, "time" | "title" | "note" | "kind" | "status">> }
  | { type: "delete_director_marker"; markerId: string }
  | { type: "set_director_review_state"; reviewState: DirectorReviewState }
  | { type: "set_editorial_profile"; profile: EditorialProfileId }
  | { type: "set_aesthetic_system"; aestheticSystem: AestheticSystem }
  | { type: "set_aesthetic_review"; review: AestheticReview }
  | { type: "set_project_resolution"; width: number; height: number }
  | { type: "set_template_application"; application: TemplateApplicationState }
  | { type: "clear_template_application" }
  | { type: "rename_project"; name: string }
  | { type: "batch"; commands: EditorCommand[] };
