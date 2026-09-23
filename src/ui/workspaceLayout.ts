import { useCallback, useEffect, useState } from "react";

export type WorkspacePreset = "simple" | "edit" | "color" | "focus" | "custom";
export type WorkspaceTextSize = "comfortable" | "large";

export interface WorkspaceLayoutState {
  preset: WorkspacePreset;
  mediaVisible: boolean;
  inspectorVisible: boolean;
  automationVisible: boolean;
  timelineVisible: boolean;
  mediaWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
  textSize: WorkspaceTextSize;
}

const STORAGE_KEY = "editkin.workspace-layout.v1";
const dimension = (value: unknown, fallback: number, minimum: number, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
const visibility = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;

export const WORKSPACE_PRESETS: Record<Exclude<WorkspacePreset, "custom">, WorkspaceLayoutState> = {
  simple: { preset: "simple", mediaVisible: true, inspectorVisible: false, automationVisible: false, timelineVisible: true, mediaWidth: 360, inspectorWidth: 340, timelineHeight: 200, textSize: "large" },
  edit: { preset: "edit", mediaVisible: true, inspectorVisible: true, automationVisible: false, timelineVisible: true, mediaWidth: 300, inspectorWidth: 400, timelineHeight: 326, textSize: "large" },
  color: { preset: "color", mediaVisible: false, inspectorVisible: true, automationVisible: false, timelineVisible: true, mediaWidth: 300, inspectorWidth: 420, timelineHeight: 246, textSize: "large" },
  focus: { preset: "focus", mediaVisible: false, inspectorVisible: false, automationVisible: false, timelineVisible: true, mediaWidth: 280, inspectorWidth: 350, timelineHeight: 210, textSize: "large" },
};

export function normalizeWorkspaceLayout(value: Partial<WorkspaceLayoutState> | undefined): WorkspaceLayoutState {
  const fallback = WORKSPACE_PRESETS.simple;
  return {
    preset: value?.preset && ["simple", "edit", "color", "focus", "custom"].includes(value.preset) ? value.preset : fallback.preset,
    mediaVisible: visibility(value?.mediaVisible, fallback.mediaVisible),
    inspectorVisible: visibility(value?.inspectorVisible, fallback.inspectorVisible),
    automationVisible: visibility(value?.automationVisible, fallback.automationVisible),
    timelineVisible: visibility(value?.timelineVisible, fallback.timelineVisible),
    mediaWidth: dimension(value?.mediaWidth, fallback.mediaWidth, 220, 520),
    inspectorWidth: dimension(value?.inspectorWidth, fallback.inspectorWidth, 286, 560),
    timelineHeight: dimension(value?.timelineHeight, fallback.timelineHeight, 170, 520),
    textSize: value?.textSize === "comfortable" ? "comfortable" : "large",
  };
}

function readWorkspaceLayout(): WorkspaceLayoutState {
  if (typeof window === "undefined") return WORKSPACE_PRESETS.simple;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<WorkspaceLayoutState> | null;
    return saved?.preset === "simple" ? WORKSPACE_PRESETS.simple : normalizeWorkspaceLayout(saved ?? undefined);
  } catch {
    return WORKSPACE_PRESETS.simple;
  }
}

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<WorkspaceLayoutState>(readWorkspaceLayout);
  useEffect(() => { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); }, [layout]);
  const choosePreset = useCallback((preset: Exclude<WorkspacePreset, "custom">) => setLayout(WORKSPACE_PRESETS[preset]), []);
  const patch = useCallback((value: Partial<WorkspaceLayoutState>) => setLayout((current) => normalizeWorkspaceLayout({ ...current, ...value, preset: "custom" })), []);
  const resize = useCallback((panel: "media" | "inspector" | "timeline", delta: number) => setLayout((current) => normalizeWorkspaceLayout({
    ...current,
    preset: "custom",
    mediaWidth: panel === "media" ? current.mediaWidth + delta : current.mediaWidth,
    inspectorWidth: panel === "inspector" ? current.inspectorWidth - delta : current.inspectorWidth,
    timelineHeight: panel === "timeline" ? current.timelineHeight - delta : current.timelineHeight,
  })), []);
  return { layout, choosePreset, patch, resize, reset: () => setLayout(WORKSPACE_PRESETS.simple) };
}
