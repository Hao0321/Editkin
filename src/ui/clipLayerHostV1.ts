import { createContext, useContext } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { ClipLayerState, EditProject, LayerBlendMode } from "../domain/types";

/**
 * The editor shell's handlers for the selected clip's layer settings (混合模式, 不透明度, ◆) and the project the layer
 * pickers name clips from. Provided by EditorShell around the Inspector, so controls inside the Inspector reach the
 * shell's command, history and preview owners without new Inspector props. It owns no project copy or history.
 */
export interface ClipLayerHostV1 {
  project: EditProject;
  /** The selected clip; controls for any other clip stay inert. */
  clipId?: string;
  playhead: number;
  fps: number;
  /** The selected clip's opacity at the playhead (keyframes and expressions applied), as the Inspector shows it. */
  opacity?: number;
  /** While an opacity drag previews a value, that value (the slider follows it); otherwise undefined. */
  opacityPreview?: number;
  /** While a hovered blend mode previews, that mode; otherwise undefined. */
  blendPreview?: LayerBlendMode;
  /** Changes when the selection changes, so a pending number draft is dropped (with `editScopeSignal`, the playhead too). */
  editScope?: unknown;
  /** Fires when the playhead or a seek moved (PF1: without re-rendering the Inspector); drafts and previews drop as above. */
  editScopeSignal?: { subscribe: (listener: () => void) => () => void };
  /** `opacity` / `opacityPreview` at another playhead, for the live host (LiveClipLayerHostV1). */
  opacityAt?: (time: number) => number | undefined;
  opacityPreviewAt?: (time: number) => number | undefined;
  onLayerChange: (patch: Partial<ClipLayerState>) => boolean | void;
  onOpacityChange: (opacity: number) => boolean | void;
  /** One drag of the opacity slider: previews without history, then one command (one Undo) on release. */
  beginOpacityGesture?: () => ParameterGestureLeaseV1 | undefined;
  /** Hovering blend modes: previews without history; commit runs one set_clip_layer, cancel restores. */
  beginBlendGesture?: () => ParameterGestureLeaseV1<LayerBlendMode> | undefined;
  onAddKeyframe: () => void;
  onDeleteKeyframe: (keyframeId: string) => void;
}

export const ClipLayerHostContextV1 = createContext<ClipLayerHostV1 | undefined>(undefined);
export const useClipLayerHostV1 = () => useContext(ClipLayerHostContextV1);
