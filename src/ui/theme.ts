export const EDITOR_THEMES = ["sky", "candy", "volt"] as const;

export type EditorTheme = (typeof EDITOR_THEMES)[number];

export const THEME_STORAGE_KEY = "editkin.editor-theme";

export const THEME_PARITY_CONTRACT = Object.freeze({
  schema: "editkin.theme-parity/v1",
  mechanism: "root-data-theme-css-custom-properties-only",
  sharedDom: true,
  sharedFeatures: true,
  sharedLayout: true,
  sharedSpacing: true,
  sharedBreakpoints: true,
});

export const THEME_LABELS: Record<EditorTheme, string> = {
  sky: "藍白",
  candy: "粉白",
  volt: "黑綠",
};

export function normalizeEditorTheme(value: unknown): EditorTheme {
  return typeof value === "string" && EDITOR_THEMES.includes(value as EditorTheme)
    ? value as EditorTheme
    : "sky";
}
