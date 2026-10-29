export const UI_LOCALES = ["zh-TW", "en", "es", "ja", "ko"] as const;
export type UiLocale = typeof UI_LOCALES[number];

export function normalizeUiLocale(value: unknown): UiLocale {
  return UI_LOCALES.includes(value as UiLocale) ? value as UiLocale : "zh-TW";
}
