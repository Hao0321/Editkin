import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "./Toolbar";
import { PlaybackControls } from "./PlaybackControls";
import { interfacePreferences, UI_LOCALES } from "./i18n/interfacePreferences";
import { CaptionPresetGallery } from "./PresetPreviewGallery";
import { TEXT_STYLE_PRESETS } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { initializeWave2Registry } from "../creative/wave2Registry";

initializeStudioCreativeAssets();
initializeWave2Registry();

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); interfacePreferences.setMode("simple"); });

describe("real React interface localization", () => {
  it.each(UI_LOCALES)("localizes built-in caption choices and known status in %s without rewriting author data", async locale => {
    await interfacePreferences.setLocale(locale);
    const original = JSON.stringify(TEXT_STYLE_PRESETS);
    const html = renderToStaticMarkup(<CaptionPresetGallery selected={TEXT_STYLE_PRESETS[0].id} onSelect={() => undefined}/>);
    expect(html).toContain(interfacePreferences.translate("乾淨字幕"));
    expect(html).toContain(interfacePreferences.translate("講者乾淨字幕"));
    if (locale !== "zh-TW") expect(html).not.toContain("乾淨字幕");
    const filename = "原文 日本語 한국어 {count}.editkin.json";
    const status = `已送出專案下載：${filename}；請確認瀏覽器下載完成。此操作不會標記已儲存，也沒有 Autosave。`;
    const translated = interfacePreferences.translateStatus(status);
    expect(translated).toContain(filename);
    if (locale !== "zh-TW") expect(translated).not.toContain("請確認瀏覽器");
    expect(interfacePreferences.translateStatus("未知引擎診斷：原文 {count}")).toBe("未知引擎診斷：原文 {count}");
    expect(JSON.stringify(TEXT_STYLE_PRESETS)).toBe(original);
  });
  it.each(UI_LOCALES)("renders the actual toolbar and transport in %s while preserving the project name", async locale => {
    expect(await interfacePreferences.setLocale(locale)).toBe(true);
    const noop = () => undefined;
    const projectName = "中文 日本語 한국어 Original";
    const props: Parameters<typeof Toolbar>[0] = { projectName, hasUserMedia: true, workspaceMode: "editor", theme: "sky", onThemeChange: noop, dirty: true, recoveryState: "idle", playhead: 2, canUndo: true, canRedo: false, isDesktop: false, onNew: noop, onOpen: noop, onSave: noop, onUndo: noop, onRedo: noop, onExport: noop, onOpenAgentConnect: noop, onCheckUpdates: noop, onDirectorConsole: noop, onHelp: noop, onAddMedia: noop, onEdit: noop, onReview: noop };
    // The four-step bar is advanced mode's since 2026-10-11 (simple mode's one-row top bar is checked after it).
    interfacePreferences.setMode("advanced");
    const html = renderToStaticMarkup(<><Toolbar {...props}/><PlaybackControls playing={false} playhead={2} duration={12} fps={30} onTogglePlayback={noop} onPausePlayback={noop} onSeek={noop}/></>);
    const add = { "zh-TW": "加入影片", en: "Add video", es: "Añadir vídeo", ja: "動画を追加", ko: "영상 추가" }[locale];
    expect(html).toContain(add);
    expect(html).toContain(projectName);
    expect(html).toContain('data-testid="flow-step-4"');
    expect(html).toContain('aria-current="step"');
    if (locale !== "zh-TW") {
      expect(html).not.toContain("快速教學");
      expect(html).not.toContain("已暫停");
    }
    interfacePreferences.setMode("simple");
    const simple = renderToStaticMarkup(<><Toolbar {...props}/><PlaybackControls playing={false} playhead={2} duration={12} fps={30} onTogglePlayback={noop} onPausePlayback={noop} onSeek={noop}/></>);
    expect(simple).toContain(projectName);
    expect(simple).toContain('data-toolbar-layout="simple"');
    expect(simple).not.toContain('data-testid="flow-step-1"');
    for (const words of ["設定", "說明", "匯出專案", "復原", "重做"]) expect(simple).toContain(interfacePreferences.translate(words));
    // Japanese writes 設定 the same way, so only words whose translation differs are checked for leftovers.
    for (const words of ["設定", "說明", "匯出專案", "播放", "上一格", "下一格"]) if (interfacePreferences.translate(words) !== words) expect(simple).not.toContain(`>${words}<`);
    expect(props.projectName).toBe(projectName);
  });
});
