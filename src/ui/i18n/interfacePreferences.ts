import { useSyncExternalStore } from "react";
import { UI_LOCALES, type UiLocale } from "../../shared/uiLocaleContract";

export { UI_LOCALES };
export type { UiLocale };
export type InterfaceMode = "simple" | "advanced";
export const UI_SCALES = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;
export const LOCALE_NAMES: Record<UiLocale, string> = {
  "zh-TW": "繁體中文", en: "English", es: "Español", ja: "日本語", ko: "한국어",
};
export const UI_PREFERENCES_KEY = "editkin.interface-preferences.v1";
type Messages = Record<string, string>;
type Values = Readonly<Record<string, string | number>>;
interface SavedPreferences { locale: UiLocale; scale: number; mode: InterfaceMode; }
export interface InterfacePreferences extends SavedPreferences {
  modeRevision: number;
  loadingLocale?: UiLocale;
  scaleBusy: boolean;
  error?: string;
}
interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }

export function normalizeInterfacePreferences(value: unknown): SavedPreferences {
  const saved = value && typeof value === "object" ? value as Partial<SavedPreferences> : {};
  return {
    locale: UI_LOCALES.includes(saved.locale as UiLocale) ? saved.locale as UiLocale : "zh-TW",
    scale: UI_SCALES.includes(saved.scale as typeof UI_SCALES[number]) ? saved.scale as number : 1,
    mode: saved.mode === "advanced" ? "advanced" : "simple",
  };
}

const loadMessages = async (locale: UiLocale): Promise<Messages> => {
  switch (locale) {
    case "en": return (await import("./locales/en")).default;
    case "es": return (await import("./locales/es")).default;
    case "ja": return (await import("./locales/ja")).default;
    case "ko": return (await import("./locales/ko")).default;
    default: return {};
  }
};

// Preferences belong to the interface, never to the project or its history.
// The store supports blocked storage, failed chunks and overlapping requests.
export function createInterfacePreferencesStore(options: {
  storage?: PreferenceStorage;
  loadMessages?: (locale: UiLocale) => Promise<Messages>;
  applyScale?: (scale: number) => Promise<void>;
  applyLocale?: (locale: UiLocale) => void;
} = {}) {
  let saved: SavedPreferences;
  try { saved = normalizeInterfacePreferences(JSON.parse(options.storage?.getItem(UI_PREFERENCES_KEY) ?? "null")); }
  catch { saved = normalizeInterfacePreferences(null); }
  let state: InterfacePreferences = { ...saved, locale: "zh-TW", modeRevision: 0, scaleBusy: false };
  let messages: Messages = {};
  let statusPatterns: Array<{ expression: RegExp; names: string[]; translated: string }> = [];
  let localeRequest = 0, scaleRequest = 0;
  let scaleQueue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const missing = new Set<string>();
  const publish = (patch: Partial<InterfacePreferences>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const persist = () => {
    try { options.storage?.setItem(UI_PREFERENCES_KEY, JSON.stringify({ locale: state.locale, scale: state.scale, mode: state.mode })); }
    catch { /* In-memory settings still work with unavailable browser storage. */ }
  };
  const setLocale = async (locale: UiLocale) => {
    if (!UI_LOCALES.includes(locale)) return false;
    const request = ++localeRequest;
    publish({ loadingLocale: locale, error: undefined });
    try {
      const next = await (options.loadMessages ?? loadMessages)(locale);
      if (request !== localeRequest) return false;
      messages = next;
      statusPatterns = Object.entries(next).filter(([source]) => source.includes("{") && source.length < 800 && /[\u3400-\u9fff]/.test(source) && source.replace(/\{[A-Za-z][\w]*\}/g, "").trim().length >= 4)
        .sort(([left], [right]) => right.replace(/\{[A-Za-z][\w]*\}/g, "").length - left.replace(/\{[A-Za-z][\w]*\}/g, "").length)
        .map(([source, translated]) => {
          const names: string[] = [];
          const parts = source.split(/(\{[A-Za-z][\w]*\})/g).map(part => {
            if (/^\{[A-Za-z][\w]*\}$/.test(part)) { names.push(part.slice(1, -1)); return "(.*?)"; }
            return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          });
          return { expression: new RegExp(`^${parts.join("")}$`, "s"), names, translated };
        });
      options.applyLocale?.(locale);
      publish({ locale, loadingLocale: undefined });
      persist();
      return true;
    } catch {
      if (request === localeRequest) publish({ loadingLocale: undefined, error: "語言載入失敗，請再試一次。" });
      return false;
    }
  };
  const setScale = (scale: number) => {
    if (!UI_SCALES.includes(scale as typeof UI_SCALES[number])) return Promise.resolve(false);
    const request = ++scaleRequest;
    publish({ scaleBusy: true, error: undefined });
    const operation = scaleQueue.then(async () => {
      if (request !== scaleRequest) return false;
      try {
        await options.applyScale?.(scale);
        // Commit the actual applied value, even if a newer request queued meanwhile.
        publish({ scale, scaleBusy: request !== scaleRequest });
        persist();
        return true;
      } catch {
        if (request === scaleRequest) publish({ scaleBusy: false, error: "無法調整介面大小，請再試一次。" });
        return false;
      }
    });
    scaleQueue = operation.then(() => undefined);
    return operation;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLocale, setScale,
    setMode: (mode: InterfaceMode) => { if ((mode !== "simple" && mode !== "advanced") || mode === state.mode) return; publish({ mode, modeRevision: state.modeRevision + 1 }); persist(); },
    initialize: async () => { await setLocale(saved.locale); await setScale(saved.scale); },
    translate: (source: string, values?: Values) => {
      let result = state.locale === "zh-TW" ? source : messages[source];
      // JSX can retain an intentional space before/after a UI label. Resolve
      // its declared trimmed key while preserving those layout spaces. Values
      // passed as placeholders are never normalized or translated.
      if (result === undefined && source.trim() !== source && messages[source.trim()] !== undefined) {
        result = source.match(/^\s*/)?.[0] + messages[source.trim()] + source.match(/\s*$/)?.[0];
      }
      if (result === undefined) {
        if (/[\u3400-\u9fff]/.test(source)) missing.add(`${state.locale}:${source}`);
        result = source;
      }
      return values ? result.replace(/\{([A-Za-z][\w]*)\}/g, (token, name: string) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token) : result;
    },
    missingKeys: () => [...missing],
    translateStatus: (source: string) => {
      if (state.locale === "zh-TW") return source;
      if (messages[source] !== undefined) return messages[source];
      if (source.length > 4096) return source;
      for (const pattern of statusPatterns) {
        const match = pattern.expression.exec(source);
        if (!match) continue;
        const values = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]]));
        return pattern.translated.replace(/\{([A-Za-z][\w]*)\}/g, (token, name: string) => values[name] ?? token);
      }
      return source; // Unknown engine diagnostics retain their original detail.
    },
  };
}

function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window !== "undefined" ? window.localStorage : undefined; }
  catch { return undefined; }
}
export const interfacePreferences = createInterfacePreferencesStore({
  storage: browserStorage(),
  applyLocale: locale => { if (typeof document !== "undefined") document.documentElement.lang = locale; },
  applyScale: async scale => {
    if (typeof document === "undefined") return;
    const native = window.haoDesktop?.setInterfaceScale;
    if (native) await native(scale);
    // Native page zoom preserves browser coordinates and physical preview bounds.
    // A regular browser adjusts only interface text and controls, never canvas math.
    document.documentElement.style.setProperty("--ui-scale", String(native ? 1 : scale));
    document.documentElement.dataset.uiScale = String(scale);
    document.documentElement.dataset.uiScaleMode = native ? "native" : "controls";
  },
});
export const translateUi = interfacePreferences.translate;
export const translateUiStatus = interfacePreferences.translateStatus;
export function useI18n() {
  const preferences = useSyncExternalStore(interfacePreferences.subscribe, interfacePreferences.getSnapshot, interfacePreferences.getSnapshot);
  return { ...preferences, t: translateUi };
}
