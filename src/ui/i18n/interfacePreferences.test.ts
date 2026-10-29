import { describe, expect, it, vi } from "vitest";
import { createInterfacePreferencesStore, normalizeInterfacePreferences, UI_PREFERENCES_KEY } from "./interfacePreferences";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("interface preferences remain independent of editing data", () => {
  it("rejects corrupt preferences and works when browser storage is blocked", async () => {
    expect(normalizeInterfacePreferences({ locale: "xx", scale: Infinity, mode: "unknown" })).toEqual({ locale: "zh-TW", scale: 1, mode: "simple" });
    const store = createInterfacePreferencesStore({
      storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
      loadMessages: async () => ({ "加入影片": "Add video" }),
    });
    expect(await store.setLocale("en")).toBe(true);
    expect(await store.setScale(1.5)).toBe(true);
    expect(store.translate("加入影片")).toBe("Add video");
    expect(store.getSnapshot()).toMatchObject({ locale: "en", scale: 1.5, error: undefined });
  });

  it("restores all three saved preferences without writing them into a project", async () => {
    const storage = new Map([[UI_PREFERENCES_KEY, JSON.stringify({ locale: "ja", scale: 1.75, mode: "advanced" })]]);
    const applyScale = vi.fn(async () => undefined);
    const applyLocale = vi.fn();
    const store = createInterfacePreferencesStore({ storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }, loadMessages: async () => ({ "加入影片": "動画を追加" }), applyScale, applyLocale });
    await store.initialize();
    expect(store.getSnapshot()).toMatchObject({ locale: "ja", scale: 1.75, mode: "advanced" });
    expect(applyScale).toHaveBeenCalledExactlyOnceWith(1.75);
    expect(applyLocale).toHaveBeenCalledExactlyOnceWith("ja");
    expect([...storage.keys()]).toEqual([UI_PREFERENCES_KEY]);
    expect(JSON.parse(storage.get(UI_PREFERENCES_KEY)!)).toEqual({ locale: "ja", scale: 1.75, mode: "advanced" });
  });

  it.each(["simple", "advanced"] as const)("keeps the current preference snapshot when %s is already selected", async mode => {
    const setItem = vi.fn();
    const store = createInterfacePreferencesStore({
      storage: { getItem: () => JSON.stringify({ locale: "zh-TW", scale: 1.5, mode }), setItem },
      loadMessages: async () => ({}),
    });
    await store.initialize();
    setItem.mockClear();
    const before = store.getSnapshot();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);

    store.setMode(mode);
    store.setMode(mode);

    expect(store.getSnapshot()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("publishes and persists each actual mode transition while retaining language and size", async () => {
    const setItem = vi.fn();
    const store = createInterfacePreferencesStore({
      storage: { getItem: () => JSON.stringify({ locale: "ko", scale: 1.75, mode: "simple" }), setItem },
      loadMessages: async () => ({ "加入影片": "영상 추가" }),
    });
    await store.initialize();
    setItem.mockClear();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);

    store.setMode("advanced");
    expect(store.getSnapshot()).toMatchObject({ locale: "ko", scale: 1.75, mode: "advanced", modeRevision: 1 });
    store.setMode("simple");
    expect(store.getSnapshot()).toMatchObject({ locale: "ko", scale: 1.75, mode: "simple", modeRevision: 2 });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(setItem.mock.calls.map(([, value]) => JSON.parse(value))).toEqual([
      { locale: "ko", scale: 1.75, mode: "advanced" },
      { locale: "ko", scale: 1.75, mode: "simple" },
    ]);
    unsubscribe();
  });

  it("ignores an invalid mode without notifying the workspace or overwriting preferences", () => {
    const setItem = vi.fn();
    const store = createInterfacePreferencesStore({ storage: { getItem: () => null, setItem } });
    const before = store.getSnapshot();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    store.setMode("invalid" as "simple");
    expect(store.getSnapshot()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps the latest language when lazy chunks finish in the opposite order", async () => {
    const english = deferred<Record<string, string>>(), korean = deferred<Record<string, string>>();
    const store = createInterfacePreferencesStore({ loadMessages: locale => locale === "en" ? english.promise : korean.promise });
    const first = store.setLocale("en"), last = store.setLocale("ko");
    korean.resolve({ "加入影片": "영상 추가" });
    expect(await last).toBe(true);
    english.resolve({ "加入影片": "Add video" });
    expect(await first).toBe(false);
    expect(store.getSnapshot().locale).toBe("ko");
    expect(store.translate("加入影片")).toBe("영상 추가");
  });

  it("preserves the current language when another chunk fails", async () => {
    const store = createInterfacePreferencesStore({ loadMessages: async locale => { if (locale === "es") throw new Error("offline chunk"); return { "加入影片": "Add video" }; } });
    await store.setLocale("en");
    expect(await store.setLocale("es")).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ locale: "en", loadingLocale: undefined, error: "語言載入失敗，請再試一次。" });
    expect(store.translate("加入影片")).toBe("Add video");
  });

  it("serializes native zoom, skips superseded pending requests and records what was applied", async () => {
    const firstZoom = deferred<void>();
    const applied: number[] = [];
    const store = createInterfacePreferencesStore({ applyScale: async scale => { applied.push(scale); if (scale === 1.25) await firstZoom.promise; } });
    const first = store.setScale(1.25);
    await Promise.resolve();
    const middle = store.setScale(1.5), last = store.setScale(2);
    expect(applied).toEqual([1.25]);
    firstZoom.resolve();
    expect(await first).toBe(true);
    expect(await middle).toBe(false);
    expect(await last).toBe(true);
    expect(applied).toEqual([1.25, 2]);
    expect(store.getSnapshot()).toMatchObject({ scale: 2, scaleBusy: false });
  });

  it("does not claim a failed native zoom was applied", async () => {
    const store = createInterfacePreferencesStore({ applyScale: async () => { throw new Error("webview gone"); } });
    expect(await store.setScale(2)).toBe(false);
    expect(await store.setScale(4)).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ scale: 1, scaleBusy: false, error: "無法調整介面大小，請再試一次。" });
  });

  it("preserves authored names, spaces and braces inside interpolation values", async () => {
    const authored = { name: "  中文 日本語 한국어 {count}  ", caption: "字幕不翻譯" };
    const before = JSON.stringify(authored);
    const store = createInterfacePreferencesStore({ loadMessages: async () => ({ "素材 {name}": "Media {name}", "加入影片": "Add video" }) });
    await store.setLocale("en");
    expect(store.translate("素材 {name}", { name: authored.name })).toBe(`Media ${authored.name}`);
    expect(store.translate(" 加入影片 ")).toBe(" Add video ");
    expect(store.translate(authored.caption)).toBe(authored.caption);
    expect(JSON.stringify(authored)).toBe(before);
  });

  it("translates declared status frames but retains unknown diagnostics and file names", async () => {
    const store = createInterfacePreferencesStore({ loadMessages: async () => ({ "已匯入 {name}。": "Imported {name}.", "準備完成": "Ready" }) });
    await store.setLocale("en");
    expect(store.translateStatus("已匯入 作品_日本語_한국어.mp4。")).toBe("Imported 作品_日本語_한국어.mp4.");
    expect(store.translateStatus("未知引擎錯誤：E409")).toBe("未知引擎錯誤：E409");
    expect(store.translateStatus("準備完成")).toBe("Ready");
  });

  it("prefers a complete status frame over a general one and cannot treat arbitrary text as a status template", async () => {
    const store = createInterfacePreferencesStore({ loadMessages: async () => ({
      "{name}": "Unexpected {name}",
      "已匯入 {count} 份素材{details}。": "Imported {count}{details}.",
      "已匯入 {count} 份素材，已設成 {ratio}。": "Imported {count} at {ratio}.",
    }) });
    await store.setLocale("en");
    expect(store.translateStatus("已匯入 1 份素材，已設成 16:9。")).toBe("Imported 1 at 16:9.");
    expect(store.translateStatus("作品_日本語_한국어")).toBe("作品_日本語_한국어");
  });
});
