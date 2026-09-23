import { useLayoutEffect, useState } from "react";
import { normalizeEditorTheme, THEME_STORAGE_KEY, type EditorTheme } from "./theme";

function readStoredTheme(): EditorTheme {
  try {
    return normalizeEditorTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "sky";
  }
}

export function useEditorTheme() {
  const [theme, setTheme] = useState<EditorTheme>(readStoredTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A blocked storage backend must not prevent editing or theme changes.
    }
  }, [theme]);

  return { theme, setTheme };
}
