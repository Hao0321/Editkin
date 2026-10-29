import type { Dispatch, SetStateAction } from "react";
import type { PlayheadStore } from "./playheadStore";
import type { useAutomaticEditing } from "../desktop/useAutomaticEditing";
import type { useBatchAutoEdit } from "../desktop/useBatchAutoEdit";
import type { useCreativeLibrary } from "../desktop/useCreativeLibrary";
import type { useDesktopActions } from "../desktop/useDesktopActions";
import type { useMobileRemote } from "../desktop/useMobileRemote";
import type { useProjectRecovery } from "../desktop/useProjectRecovery";
import type { EditorCommand, EditorCommandContext } from "../domain/commands";
import type { EditorHistory } from "../domain/history";
import type { CaptionCue, ClipLayout, EditProject, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect, TimelineClip } from "../domain/types";
import type { EditorTheme } from "./theme";
import type { ProjectSession } from "../application/projectSession";
import type { LowerThirdPresetId } from "../application/lowerThirds";
import type { TimelineImportPlacement } from "./internalAssetPointerDrag";
import type { TimelineCut, TimelineEditOptions, TimelineKeyboardActions } from "./timelineContract";
import type { TimelineSelection } from "../application/timelineSelection";
import type { TimelineMarkRange } from "../application/timelineNavigation";
import type { TimelineViewRequest } from "./timelineViewRequests";

export type TrackingMode = { kind: "new" | "correct"; trackId?: string } | { kind: "podcast"; role: "host" | "guest"; hostTrack?: MotionTrack };

export interface EditorShellProps {
  clipMediaBusy?: boolean;
  onFreezeFrame?: (clipId: string) => unknown;
  onClipRetime?: (clipId: string, rate: number, reverse: boolean) => unknown;
  currentAestheticArtifact?: import("../domain/types").AestheticArtifactBinding;
  history: EditorHistory;
  project: EditProject;
  projectSession: ProjectSession;
  getTimelineSelection: () => TimelineSelection;
  subscribeTimelineSelection: (listener: () => void) => () => void;
  duration: number;
  theme: EditorTheme;
  setTheme: (theme: EditorTheme) => void;
  isDesktop: boolean;
  /** PF1: the playhead and seek revision; the shell and its panels subscribe only where they show time. */
  playheadStore: PlayheadStore;
  setPlayhead: Dispatch<SetStateAction<number>>;
  onPlaybackClock: (time: number, seekRevision: number) => void;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  togglePlayback: () => void;
  pausePlayback: () => void;
  shuttlePlayback: (direction: -1 | 1, fastForward?: boolean) => void;
  frameStepPlayback: (direction: -1 | 1) => void;
  selectedClipId?: string;
  setSelectedClipId: Dispatch<SetStateAction<string | undefined>>;
  selectedCaptionId?: string;
  selectedClipIds?: string[];
  selectedCaptionIds?: string[];
  onSelectionChange?: (selection: TimelineSelection) => void;
  markRange?: TimelineMarkRange;
  markers?: EditProject["director"]["markers"];
  viewRequest?: TimelineViewRequest;
  setSelectedCaptionId: Dispatch<SetStateAction<string | undefined>>;
  selectedClip?: TimelineClip;
  selectedCaption?: CaptionCue;
  transitionNeighbors: { before: boolean; after: boolean };
  selectedMotionTracks: EditProject["motionTracks"];
  runtimeUrls: Record<string, string>;
  /** Adds preview URLs (desktop relink of a moved file). */
  mergeRuntimeUrls?: (urls: Record<string, string>) => void;
  missingMedia: EditProject["assets"];
  relinkBrowserMedia: (assetId: string) => Promise<void>;
  status: string;
  projectDownload?: import("../application/projectDownloadLease").ProjectDownloadLease;
  cancelProjectDownload: (requestId: string) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  trackingMode?: TrackingMode;
  setTrackingMode: Dispatch<SetStateAction<TrackingMode | undefined>>;
  trackingSelection?: NormalizedRect;
  setTrackingSelection: Dispatch<SetStateAction<NormalizedRect | undefined>>;
  trackingBusy: boolean;
  trackingActionGuard: (trackId?: string) => boolean;
  recovery: ReturnType<typeof useProjectRecovery>;
  desktopActions: ReturnType<typeof useDesktopActions>;
  automatic: ReturnType<typeof useAutomaticEditing>;
  creativeLibrary: ReturnType<typeof useCreativeLibrary>;
  batchAutoEdit: ReturnType<typeof useBatchAutoEdit>;
  mobile: ReturnType<typeof useMobileRemote>;
  newProject: () => void;
  openProject: () => Promise<void>;
  /** Loads a project another flow opened (the easy flow's finished template Short). */
  loadOpenedProject?: (opened: import("../desktop/types").OpenProjectResult, options?: { dirty?: boolean }) => void;
  saveProject: (saveAs?: boolean) => Promise<void>;
  undoEdit: () => void;
  redoEdit: () => void;
  renderVideo: () => Promise<void>;
  renderOpenExrSequence: () => Promise<void>;
  renderAlphaMaster: () => Promise<void>;
  importFiles: (files: File[], placement?: TimelineImportPlacement) => Promise<void>;
  acceptTrackingSelection: (rect: NormalizedRect) => Promise<void>;
  startPodcastDirector: () => void;
  submitAgentInstruction: (instruction: string) => void;
  /** One command, one Undo step; `options.coalesce` merges a held gesture's commands into one step. */
  runCommand: (command: EditorCommand, successMessage?: string, options?: TimelineEditOptions, context?: EditorCommandContext) => boolean | void;
  addMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed) => void;
  addCaption: () => void;
  addTrack: (kind: "video" | "audio") => void;
  addAssetToTimeline: (assetId: string, mode?: "timeline" | "pip", placement?: { trackId: string; timelineStart: number; dropMode?: "insert" | "overwrite" }) => boolean | void;
  makeSelectedPictureInPicture: (layout?: ClipLayout, name?: string) => void;
  precomposeSelected: () => void;
  applyShortFormTemplate: (templateId: string, content?: import("../application/shortFormTemplates").ShortFormTemplateContent) => Promise<void>;
  applyLongFormTemplate: (templateId: string) => Promise<void>;
  addLowerThird: (presetId: LowerThirdPresetId, personName: string, organization: string) => void;
  clearTemplateApplication: () => void;
  splitSelected: () => void;
  deleteSelected: () => void;
  /** The 剪刀 tool's cuts (one click, or Shift+click on every track): one split command each, one Undo. */
  cutClipsAt: (cuts: TimelineCut[]) => void;
  /** Filled in by the timeline for the editor's key owner (Alt+← → nudges, Delete of a picked title, B, A and Esc). */
  timelineKeyboard?: { current: TimelineKeyboardActions | undefined };
  /** Filled in by the Motion Library GUI for the editor's key owner (Ctrl+T, Delete of a selected transition). */
  motionLibraryKeyboard?: { current: import("./motionLibraryControllerV1").MotionLibraryKeyboardActionsV1 | undefined };
}
