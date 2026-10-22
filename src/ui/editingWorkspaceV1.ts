/** Editing tasks share one project/selection/Undo history; changing rooms never edits the graph. */
export const EDITING_WORKSPACES_V1 = [
  { id: "edit", label: "剪輯" },
  { id: "effects", label: "特效" },
  { id: "color", label: "調色" },
  { id: "tracking", label: "追蹤" },
] as const;
export type EditingWorkspaceV1 = typeof EDITING_WORKSPACES_V1[number]["id"];
export type EditingLayerSelectionV1 = { kind: "clip" | "caption" | "graphic"; id: string };
export const INSPECTOR_WORKSPACE_TOOLS_V1 = {
  edit: ["adjust", "text", "transition", "pip"],
  effects: ["effect", "text", "transition", "pip"],
  color: ["look"],
  tracking: ["mask"],
} as const;
