import type { EditProject, TimelineTrack } from "../domain/types";

export interface TimelineProps {
  project: EditProject;
  duration: number;
  playhead: number;
  selectedClipId?: string;
  selectedCaptionId?: string;
  runtimeUrls: Record<string, string>;
  onSeek: (time: number) => void;
  onSelect: (clipId: string) => void;
  onSelectCaption: (captionId: string) => void;
  onMoveClip: (clipId: string, timelineStart: number, trackId: string) => void;
  onMoveCaption: (captionId: string, start: number) => void;
  onAddCaption: () => void;
  onAddTrack: (kind: "video" | "audio") => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onToggleTrackLock: (trackId: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onMakePictureInPicture: () => void;
  onPrecompose: () => void;
  onTrimClip: (clipId: string, edge: "start" | "end", seconds: number) => void;
  onTrimCaption: (captionId: string, edge: "start" | "end", seconds: number) => void;
  onToggleMute: (trackId: string) => void;
  onSplit: () => void;
  onDelete: () => void;
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
  moved: boolean;
  element: HTMLButtonElement;
  originWidth: number;
  originWidthStyle: string;
}

export const TIMELINE_LABEL_WIDTH = 188;
export const MIN_PIXELS_PER_SECOND = 18;
export const MAX_PIXELS_PER_SECOND = 480;
export const DRAG_HELP = "逐幀拖曳 · Alt 暫停吸附 · ← → 1 幀 · Shift 10 幀";
export const LOCKED_HELP = "軌道已鎖定";
