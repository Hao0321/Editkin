import type { CSSProperties } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { LayerBlendMode } from "../domain/types";

/** Every domain blend mode, its plain name (CapCut/Premiere wording) and the browser mode its swatch is drawn with. */
const BLEND_MODES = {
  normal: { label: "一般", css: "normal" },
  darken: { label: "變暗", css: "darken" },
  multiply: { label: "色彩增值", css: "multiply" },
  color_burn: { label: "顏色加深", css: "color-burn" },
  lighten: { label: "變亮", css: "lighten" },
  screen: { label: "濾色", css: "screen" },
  color_dodge: { label: "顏色加亮", css: "color-dodge" },
  add: { label: "發光疊加", css: "plus-lighter" },
  overlay: { label: "覆蓋", css: "overlay" },
  soft_light: { label: "柔光", css: "soft-light" },
  hard_light: { label: "實光", css: "hard-light" },
  difference: { label: "差值", css: "difference" },
} as const satisfies Record<LayerBlendMode, { label: string; css: CSSProperties["mixBlendMode"] }>;

/** The 混合模式 list, grouped like Premiere and CapCut: what each group does to the picture below. */
export const CLIP_BLEND_MODE_GROUPS_V1: ReadonlyArray<{ label: string; modes: readonly LayerBlendMode[] }> = [
  { label: "一般", modes: ["normal"] },
  { label: "變暗", modes: ["darken", "multiply", "color_burn"] },
  { label: "變亮", modes: ["lighten", "screen", "color_dodge", "add"] },
  { label: "對比", modes: ["overlay", "soft_light", "hard_light"] },
  { label: "差異", modes: ["difference"] },
];
export const CLIP_BLEND_MODES_V1: readonly LayerBlendMode[] = CLIP_BLEND_MODE_GROUPS_V1.flatMap(group => group.modes);
export const clipBlendModeLabelV1 = (mode: LayerBlendMode): string => BLEND_MODES[mode].label;
export const clipBlendModeCssV1 = (mode: LayerBlendMode): CSSProperties["mixBlendMode"] => BLEND_MODES[mode].css;

/**
 * The hover preview behind the 混合模式 list. Hovering (or arrowing to) a mode previews it through one transient gesture
 * lease, so nothing reaches the history; leaving the list or Esc restores the committed mode; choosing one commits it
 * once. Without a lease (a locked track, a stale selection) hovering previews nothing and choosing falls back to the
 * plain command.
 */
export function createBlendHoverPreviewV1() {
  let lease: ParameterGestureLeaseV1<LayerBlendMode> | null | undefined;
  const drop = () => { const held = lease; lease = undefined; held?.cancel(); };
  return {
    hover(mode: LayerBlendMode, begin?: () => ParameterGestureLeaseV1<LayerBlendMode> | undefined): boolean {
      if (lease === undefined) { try { lease = begin?.() ?? null; } catch { lease = null; } }
      if (!lease) return false;
      try { if (lease.update(mode) !== false) return true; } catch { /* refused below */ }
      drop(); lease = null; return false;
    },
    /** Back to the committed mode (Esc, leaving the list, closing it). */
    restore: drop,
    /** Commits the mode once; a refused or missing lease falls back to the ordinary command. */
    choose(mode: LayerBlendMode, commit: (mode: LayerBlendMode) => boolean | void): boolean {
      const held = lease; lease = undefined;
      if (held) {
        // A lease that was still current ran (or refused) the one command itself; never send it a second time.
        const current = held.isCurrent?.() ?? true;
        try { if (held.update(mode) !== false && held.commit()) return true; } catch { /* handled below */ }
        held.cancel();
        if (current) return false;
      }
      return commit(mode) !== false;
    },
    get previewing() { return Boolean(lease); },
  };
}
