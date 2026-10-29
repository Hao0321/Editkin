import type { EditProject, TimelineTrack } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { TimelineCut } from "../application/timelineSplitTarget";
import type { TimelineSelection } from "../application/timelineSelection";
import type { TimelineMarkRange } from "../application/timelineNavigation";
import type { TimelineViewRequest } from "./timelineViewRequests";

export type { TimelineCut };

/** Extra instructions for one edit. */
export interface TimelineEditOptions {
  /** Commands that carry the same key one right after another make ONE Undo step (a held Alt+← → nudge). */
  coalesce?: string;
}

/**
 * What the editor's one key owner (App with useEditorShortcuts) asks of the timeline about the current selection. The
 * timeline fills it in while it is shown; the keys themselves are never listened to here.
 */
export interface TimelineKeyboardActions {
  /** Alt+← →: move the selected title, clip or caption by `frames` (negative = earlier), one command per press. */
  nudge(frames: number, coalesce: string): void;
  /** Delete: a title or card picked on the 標題與圖卡 lane is deleted (true); false leaves the delete to the editor. */
  deleteSelection(): boolean;
  /** B and A: the timeline's tool, 剪刀 or 選取. */
  setTool(tool: TimelineTool): void;
  /** Esc: from 剪刀 back to 選取 (true); false when 選取 was already on, so Esc stays with whoever else uses it. */
  escapeTool(): boolean;
  /** Editor key owner clears the picked title before clearing clip/caption selection. */
  clearMotionSelection?(): boolean;
  /** Keeps a picked title's existing nudge priority; false delegates the clip/caption group to the editor. */
  nudgeMotionSelection?(frames: number, coalesce: string): boolean;
}

/**
 * The timeline's two tools (CapCut, DaVinci and Final Cut have the same pair): 選取 picks, drags and trims; 剪刀 cuts
 * the clip under the pointer where it is clicked (the same split command as 切開 and Ctrl+B), and nothing else.
 */
export type TimelineTool = "select" | "blade";

export interface TimelineProps {
  clipMediaBusy?: boolean;
  onFreezeFrame?: (clipId: string) => unknown;
  onDetachAudio?: (clipId: string) => unknown;
  onLinkClips?: (clipIds: string[], unlink?: boolean) => unknown;
  project: EditProject;
  duration: number;
  playhead: number;
  /** PF1: the editor's transport; the playhead layer, ruler time and commands read it (`playhead` without it). */
  playheadStore?: import("./playheadStore").PlayheadStore;
  playing?: boolean;
  onAddTitle?: () => void;
  selectedClipId?: string;
  selectedCaptionId?: string;
  /** S1: omitted arrays retain the existing primary-only, read-only fixture behaviour. */
  selectedClipIds?: string[];
  selectedCaptionIds?: string[];
  onSelectionChange?: (selection: TimelineSelection) => void;
  markRange?: TimelineMarkRange;
  markers?: EditProject["director"]["markers"];
  viewRequest?: TimelineViewRequest;
  runtimeUrls: Record<string, string>;
  draggingAssetId?: string;
  onInsertAsset?: (assetId: string, trackId: string, timelineStart: number, dropMode?: "insert" | "overwrite") => boolean | void;
  /** Actual editor passes pause ownership here; standalone read-only fixtures may omit it. */
  onEditStart?: () => void;
  onSeek: (time: number) => void;
  onSelect: (clipId: string) => void;
  onSelectCaption: (captionId: string) => void;
  onMoveClip: (clipId: string, timelineStart: number, trackId: string, options?: TimelineEditOptions) => boolean | void;
  onMoveCaption: (captionId: string, start: number, options?: TimelineEditOptions) => boolean | void;
  onAddCaption: () => void;
  /** Reveal the properties of a current selection without changing its content. */
  onEditSelection?: () => void;
  /** The person clicked (or pressed Enter on) a clip, caption or title to pick it, not a drag or a trim: simple mode
   * opens its panel, which replaces the 調整片段 button there. */
  onActivateSelection?: () => void;
  onAddTrack: (kind: "video" | "audio") => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onToggleTrackLock: (trackId: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onMakePictureInPicture: () => void;
  onPrecompose: () => void;
  /** ＋ 調整圖層 (advanced 更多工具): an adjustment layer over the marked I/O range or the selected clip. */
  onAddAdjustmentLayer?: () => void;
  onTrimClip: (clipId: string, edge: "start" | "end", seconds: number) => void;
  onTrimCaption: (captionId: string, edge: "start" | "end", seconds: number) => void;
  /** Dragging a clip edge outward: grow toward the real source bounds, one command per gesture (a promise while a title
   * template the extension changes is laid out again). */
  onExtendClip?: (clipId: string, edge: "start" | "end", seconds: number) => boolean | void | Promise<boolean>;
  /** Alt-drag on a clip: a new source in-point; its timeline position and duration stay (a promise while a title template
   * on the clip is laid out again). */
  onSlipClip?: (clipId: string, sourceStart: number) => boolean | void | Promise<boolean>;
  /** A gesture the editor refused before changing anything (locked track, template, media limit). */
  onEditRefused?: (message: string) => void;
  /**
   * The editor's command runner (one call = one Undo; only an explicit false means refused). With it, titles and
   * templates on the 標題與圖卡 lane can be moved, trimmed and deleted, and a clip carries the titles that follow it.
   * Without it the lane is shown read-only and clips move alone, as before.
   */
  onCommand?: (command: EditorCommand, successMessage?: string, options?: TimelineEditOptions) => boolean | void;
  onToggleMute: (trackId: string) => void;
  /** 「隱藏畫面／顯示畫面」 in a video track's ⋯ options: its picture off or on; its sound is unchanged. */
  onToggleHidden?: (trackId: string) => void;
  onSplit: () => void;
  onDelete: () => void;
  /** The 剪刀 tool cut clips (one click, or Shift+click on every track): one command, one Undo. */
  onCut?: (cuts: TimelineCut[]) => void;
  /** A plain line for the status bar that is not a refusal (the 剪刀 tool's instructions). */
  onStatus?: (message: string) => void;
  /** Filled in by the timeline while it is shown, for Alt+← →, Delete, B, A and Esc from the editor's key owner. */
  keyboardActions?: { current: TimelineKeyboardActions | undefined };
  /** Controls drawn inside each track lane in its own time scale (the Motion Library cut points and transitions). */
  renderTrackOverlay?: (track: TimelineTrack, pixelsPerSecond: number) => import("react").ReactNode;
}

export type DragKind = "clip" | "caption";

export interface CachedDragLane {
  element: HTMLElement;
  trackId: string;
  trackKind: TimelineTrack["kind"];
  locked: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface DragSession {
  kind: DragKind;
  id: string;
  trackKind: TimelineTrack["kind"];
  originTrackId: string;
  targetTrackId: string;
  originStart: number;
  targetStart: number;
  duration: number;
  originClientX: number;
  originClientY: number;
  currentClientX: number;
  currentClientY: number;
  originScrollLeft: number;
  pointerId: number;
  altKey: boolean;
  moved: boolean;
  canDrop: boolean;
  element: HTMLButtonElement;
  sourceLaneTop: number;
  lanes: CachedDragLane[];
  activeDropLane?: HTMLElement;
  /** Title blocks that follow this clip, previewed moving with it. */
  followers?: HTMLElement[];
  /** Snap owners that move with this clip (its following titles). */
  movingOwners?: ReadonlySet<string>;
  /** A clip under a title template stays on its track; only left and right. */
  lockTrack?: boolean;
  /** How many title blocks follow this clip, and which captions (for the drag readout). */
  followingTitles?: number;
  followingCaptionIds?: string[];
  /** Why the captions riding with the clip cannot land here (they would stack on others); undefined when they fit. */
  captionClash?: string;
}

/** A drag or edge trim of a block on the 標題與圖卡 lane. */
export interface MotionSession {
  blockId: string;
  mode: "move" | "start" | "end";
  pointerId: number;
  element: HTMLButtonElement;
  originClientX: number;
  currentClientX: number;
  originScrollLeft: number;
  altKey: boolean;
  originStartFrame: number;
  durationFrames: number;
  targetStartFrame: number;
  targetDurationFrames: number;
  minStartFrame: number;
  maxStartFrame: number;
  minDurationFrames: number;
  maxDurationFrames: number;
  maxEndFrame: number;
  /** Set when this block cannot do this gesture; the press still selects it and the reason is shown. */
  blocker?: string;
  moved: boolean;
  /** Elements that move with a template block: its main clip and the other titles on that clip. */
  followers: HTMLElement[];
  /** Snap owners that move with this block. */
  movingOwners: ReadonlySet<string>;
  originWidthStyle: string;
}

export interface ScrubSession {
  pointerId: number;
  currentClientX: number;
  element: HTMLDivElement;
}

export interface TrimSession {
  kind: DragKind;
  id: string;
  edge: "start" | "end";
  originStart: number;
  originDuration: number;
  originClientX: number;
  currentClientX: number;
  pointerId: number;
  altKey: boolean;
  originScrollLeft: number;
  trimSeconds: number;
  ripple?: boolean;
  moved: boolean;
  element: HTMLButtonElement;
  originWidth: number;
  originWidthStyle: string;
  /** Outward room for this gesture (0: shrink only). */
  maxExtendFrames?: number;
  /** Why the edge cannot go further outward, shown when the pointer asks for more. */
  extendLimit?: string;
  extendSeconds?: number;
  extendLimited?: boolean;
  /** Following items previewed at their pushed-later position while the edge grows. */
  pushedElements?: HTMLElement[];
  /** Titles lined up with this clip edge; they keep lining up with it when the gesture commits. */
  edgeFollowers?: number;
}

/** Alt-drag on a clip: choose a new in-point while the clip stays in place. */
export interface SlipSession {
  id: string;
  pointerId: number;
  element: HTMLButtonElement;
  originClientX: number;
  currentClientX: number;
  originScrollLeft: number;
  originSourceFrame: number;
  targetSourceFrame: number;
  maxSourceFrame: number;
  /** Set when this clip's in-point cannot change; the clip stays and the reason is shown. */
  blocker?: string;
  moved: boolean;
  limited: boolean;
}

export const TIMELINE_LABEL_WIDTH = 188;
export const MIN_PIXELS_PER_SECOND = 18;
export const MAX_PIXELS_PER_SECOND = 1920;
// ← → always step the playhead; Alt+← → move what is selected (with Shift, ten frames).
export const DRAG_HELP = "逐幀拖曳 · Alt 暫停吸附 · Alt＋← → 移動 1 幀 · Alt＋Shift 10 幀";
export const CLIP_DRAG_HELP = "逐幀拖曳 · 拖邊緣修剪或拉長 · 按住 Alt 再拖曳換入點 · Alt＋← → 移動 1 幀 · Alt＋Shift 10 幀";
export const LOCKED_HELP = "軌道已鎖定";
export const MOTION_BLOCK_HELP = "拖中間移動 · 拖邊緣改長度 · Alt＋← → 移動 1 幀 · Alt＋Shift 10 幀 · Delete 刪除";
export const TEMPLATE_BLOCK_HELP = "拖動時主片段一起移動 · 按 Enter 或點兩下改標題文字";
export const MOTION_LANE_READONLY_HELP = "目前只能查看；請在檢查器調整";
// The two timeline tools: their buttons' tooltips, and the timeline's hint while 剪刀 is on.
export const SELECT_TOOL_HELP = "選取工具（A）：拖曳移動、拉邊緣修剪";
export const BLADE_TOOL_HELP = "剪刀工具（B）：在片段上點一下就切開；Esc 回到選取";
export const BLADE_HELP = "剪刀：在片段上點一下就切開 · Shift＋點 全部軌道一起切 · Esc 回到選取";
export const SELECT_TOOL_BACK = "已回到選取工具：拖曳移動、拉邊緣修剪。";
export const PENDING_MOVE_REFUSAL = "上一個移動還在處理，請稍等一下再試。";
