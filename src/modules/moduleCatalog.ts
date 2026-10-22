import type { ModuleAdapter, ModuleRuntimeAdapterV2 } from "./moduleTypes";
import { moduleManifestCatalogSourceV2 } from "./moduleManifestCatalogSourceV2";
export { creatableMotionPresets } from "./moduleMotionPresetSourceV2";
import { moduleRuntimeAdapterV2 as adapter0 } from "./adaptersV2/graphic_motion_preset";
import { moduleRuntimeAdapterV2 as adapter1 } from "./adaptersV2/graphic_motion_design_v3";
import { moduleRuntimeAdapterV2 as adapter2 } from "./adaptersV2/graphic_original_element";
import { moduleRuntimeAdapterV2 as adapter3 } from "./adaptersV2/graphic_motion_kit";
import { moduleRuntimeAdapterV2 as adapter4 } from "./adaptersV2/clip_motion_camera";
import { moduleRuntimeAdapterV2 as adapter5 } from "./adaptersV2/scene_floating_frame";
import { moduleRuntimeAdapterV2 as adapter6 } from "./adaptersV2/scene_native_reel";
import { moduleRuntimeAdapterV2 as adapter7 } from "./adaptersV2/overlay_native_motion_sequence";
import { moduleRuntimeAdapterV2 as adapter8 } from "./adaptersV2/scene_reference_motion";
import { moduleRuntimeAdapterV2 as adapter9 } from "./adaptersV2/look_color";
import { moduleRuntimeAdapterV2 as adapter10 } from "./adaptersV2/effect_clip";
import { moduleRuntimeAdapterV2 as adapter11 } from "./adaptersV2/transition_clip";
import { moduleRuntimeAdapterV2 as adapter12 } from "./adaptersV2/text_style_caption";
import { moduleRuntimeAdapterV2 as adapter13 } from "./adaptersV2/music_video_illustrated";
import { moduleRuntimeAdapterV2 as adapter14 } from "./adaptersV2/music_video_footage";
import { moduleRuntimeAdapterV2 as adapter15 } from "./adaptersV2/edit_recipe_beat_montage";
import { moduleRuntimeAdapterV2 as adapter16 } from "./adaptersV2/template_short_form";
import { moduleRuntimeAdapterV2 as adapter17 } from "./adaptersV2/template_long_form";
import { moduleRuntimeAdapterV2 as adapter18 } from "./adaptersV2/graphic_text_motion";
import { moduleRuntimeAdapterV2 as adapter19 } from "./adaptersV2/transition_motion_pair";
import { moduleRuntimeAdapterV2 as adapter20 } from "./adaptersV2/background_motion_loop";
const adapters: Readonly<Record<string, ModuleRuntimeAdapterV2>> = {
  "graphic.motion_preset": adapter0,
  "graphic.motion_design_v3": adapter1,
  "graphic.original_element": adapter2,
  "graphic.motion_kit": adapter3,
  "clip_motion.camera": adapter4,
  "scene.floating_frame": adapter5,
  "scene.native_reel": adapter6,
  "overlay.native_motion_sequence": adapter7,
  "scene.reference_motion": adapter8,
  "look.color": adapter9,
  "effect.clip": adapter10,
  "transition.clip": adapter11,
  "text_style.caption": adapter12,
  "music_video.illustrated": adapter13,
  "music_video.footage": adapter14,
  "edit_recipe.beat_montage": adapter15,
  "template.short_form": adapter16,
  "template.long_form": adapter17,
  "graphic.text_motion": adapter18,
  "transition.motion_pair": adapter19,
  "background.motion_loop": adapter20,
};
/** Synchronous compatibility API; V2 discovery never imports this eager catalog. */
export function moduleCatalog(): ModuleAdapter[] {
  return moduleManifestCatalogSourceV2().map(({ manifest }) => ({ manifest, ...adapters[manifest.id] }));
}
