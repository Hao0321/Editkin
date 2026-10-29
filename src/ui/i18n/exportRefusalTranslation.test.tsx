import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../../domain/types";
import { PRIMARY_FIELD_LABELS_V1 } from "../../render/animatedPrimaryColorV1";
import { assertExportFeaturesRenderableV1 } from "../../render/exportFeatureGuardV1";
import { EXPORT_REFUSAL_MESSAGES_V1, ExportFeatureRefusalErrorV1, exportRefusalMessageKeysV1, isExportFeatureRefusalV1 } from "../../render/exportFeatureRefusalV1";
import { translateExportRefusalTextV1, translateExportRefusalV1 } from "./exportRefusalTranslationV1";
import { interfacePreferences, translateUi, useI18n } from "./interfacePreferences";
import en from "./locales/en";
import es from "./locales/es";
import ja from "./locales/ja";
import ko from "./locales/ko";

const catalogues = { en, es, ja, ko } as const;
const PARAM_KEYS = ["2.5D 立體場景", "粒子特效", ...Object.values(PRIMARY_FIELD_LABELS_V1), "透明預合成", "Scene-linear EXR", "30 分鐘以上的長片輸出", "ACES 2 {transform}"];
const placeholders = (text: string) => [...text.matchAll(/\{[A-Za-z]+\}/g)].map(match => match[0]).sort();
const han = /[\u3400-\u9fff]/;

function project(kind: "image" | "video" = "image"): EditProject {
  const p = createEmptyProject("Refusals", { id: "refusals", width: 320, height: 180, fps: 30 });
  p.assets.push({ id: "media", name: "beach.mp4", uri: "C:/fixture/media.mp4", kind, duration: 80, width: 320, height: 180 });
  p.tracks[0].clips.push(clip("clip-1"));
  return p;
}
function clip(id: string, patch: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId: "media", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 2, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...patch };
}
function refusal(run: () => void): ExportFeatureRefusalErrorV1 {
  try { run(); } catch (error) { if (isExportFeatureRefusalV1(error)) return error; throw error; }
  throw new Error("expected an export refusal");
}

/** Refusals raised by the real export preflight, plus the parameter values only other routes produce. */
function refusals(): ExportFeatureRefusalErrorV1[] {
  const adjustment = project();
  adjustment.tracks[0].clips[0].keyframes = [{ id: "k", time: 1, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 1, temperature: .4 } }];
  adjustment.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "adjustment" };
  const long = project();
  long.tracks[0].clips[0] = clip("long", { duration: 70, keyframes: [{ id: "k", time: 69, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 2, shadows: .2 } }] });
  const scene = project();
  scene.tracks[0].clips[0] = clip("plane", { volume: 0, transform3d: { position: [0, 0, 0], rotationDegrees: [0, 40, 0], scale: [1, 1, 1] } });
  scene.scene25d = structuredClone(DEFAULT_SCENE_25D);
  scene.colorManagement = { ...scene.colorManagement!, mode: "aces2", outputTransform: "rec2100_pq_1000" };
  const nested = project();
  nested.compositions.push({ id: "nest", name: "Depth part", width: 320, height: 180, fps: 30, duration: 2, tracks: [], scene25d: structuredClone(DEFAULT_SCENE_25D) } as unknown as EditProject["compositions"][number]);
  nested.assets.push({ id: "nest-asset", name: "Depth part", uri: "composition://nest", kind: "video", duration: 2, compositionId: "nest" });
  nested.tracks[0].clips.push(clip("nested", { assetId: "nest-asset", timelineStart: 2 }));
  const particles = project();
  particles.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
  return [
    refusal(() => assertExportFeaturesRenderableV1(adjustment)),
    refusal(() => assertExportFeaturesRenderableV1(long)),
    refusal(() => assertExportFeaturesRenderableV1(scene, { gpuCompositorPath: "C:/fixture/editkin-gpu-compositor.exe" })),
    refusal(() => assertExportFeaturesRenderableV1(nested)),
    refusal(() => assertExportFeaturesRenderableV1(particles)),
    new ExportFeatureRefusalErrorV1("nestedScene", "nestedScene", { composition: "Sparks", feature: "粒子特效" }),
    new ExportFeatureRefusalErrorV1("scene25d", "scene25dColorRoute", { clip: "beach.mp4", count: 3, route: "透明預合成" }, "clip-1"),
    new ExportFeatureRefusalErrorV1("particleSimulation", "particlesColorRoute", { count: 2, route: "Scene-linear EXR" }),
    new ExportFeatureRefusalErrorV1("scene25d", "scene25dColorRoute", { clip: "beach.mp4", count: 3, route: "30 分鐘以上的長片輸出" }, "clip-1"),
    new ExportFeatureRefusalErrorV1("colorKeyframes", "colorKeyframesTooLong",
      { clip: "beach.mp4", fields: Object.values(PRIMARY_FIELD_LABELS_V1).join("、"), frames: 2400, limit: 1800 }, "clip-1"),
  ];
}

afterAll(async () => { await interfacePreferences.setLocale("zh-TW"); });

describe("export refusals in the interface languages", () => {
  it("every refusal template and interface-text parameter value is translated in en, es, ja and ko with the same placeholders", () => {
    expect(exportRefusalMessageKeysV1()).toHaveLength(Object.keys(EXPORT_REFUSAL_MESSAGES_V1).length);
    for (const [locale, messages] of Object.entries(catalogues)) {
      for (const key of [...exportRefusalMessageKeysV1(), ...PARAM_KEYS]) {
        expect(messages[key], `${locale}: ${key}`).toBeTruthy();
        expect(placeholders(messages[key]), `${locale}: ${key}`).toEqual(placeholders(key));
        if (locale !== "ja") expect(han.test(messages[key]), `${locale}: ${key}`).toBe(false);
      }
    }
  });

  it("t() fills the parameters of a translated template", async () => {
    await interfacePreferences.setLocale("en");
    expect(translateUi(EXPORT_REFUSAL_MESSAGES_V1.particlesColorRoute, { count: 2, route: "scene-linear EXR" }))
      .toBe(en[EXPORT_REFUSAL_MESSAGES_V1.particlesColorRoute].replace("{count}", "2").replace("{route}", "scene-linear EXR"));
    expect(translateUi("ACES 2 {transform}", { transform: "rec2100_pq_1000" })).toBe("ACES 2 rec2100_pq_1000");
  });

  it("renders real refusals in each language: template, feature, field names and route translated; names, numbers and the code kept", async () => {
    const errors = refusals();
    expect(errors.map(error => error.messageId)).toEqual(["colorKeyframesAdjustment", "colorKeyframesTooLong", "scene25dColorRoute", "nestedScene", "particlesNoRuntime",
      "nestedScene", "scene25dColorRoute", "particlesColorRoute", "scene25dColorRoute", "colorKeyframesTooLong"]);
    function Refusal({ message }: { message: string }) { useI18n(); return <p role="alert">{translateExportRefusalTextV1(message)}</p>; }
    const rendered: Record<string, string[]> = {};
    for (const locale of ["zh-TW", "en", "es", "ja", "ko"] as const) {
      await interfacePreferences.setLocale(locale);
      rendered[locale] = [];
      for (const error of errors) {
        const code = error.message.slice(error.message.lastIndexOf("（") + 1, -1);
        const text = translateExportRefusalTextV1(error.message), direct = translateExportRefusalV1(error);
        expect(text).toBe(locale === "zh-TW" || locale === "ja" ? `${direct}（${code}）` : `${direct} (${code})`);
        expect(renderToStaticMarkup(<Refusal message={error.message} />)).toBe(renderToStaticMarkup(<p role="alert">{text}</p>));
        expect(text, text).not.toMatch(/\{[A-Za-z]+\}/);
        expect(code).toMatch(/^EXPORT_FEATURE_REFUSED\//);
        if (locale === "zh-TW") expect(text).toBe(error.message);
        else expect(han.test(direct) && locale !== "ja", `${locale}: ${direct}`).toBe(false);
        // The user's names, the numbers and the ACES transform ID pass through unchanged.
        for (const [name, value] of Object.entries(error.params)) if (error.messageKey.includes(`{${name}}`) && (typeof value === "number" || (!han.test(value) && value !== "Scene-linear EXR"))) {
          expect(direct, `${locale}: ${value}`).toContain(String(value));
        }
        rendered[locale].push(direct);
      }
    }
    expect(rendered.en[0]).toBe("Adjustment layer “beach.mp4” has keyframe animation on Exposure, Temperature, which can't be exported yet; exporting anyway would look different from the preview, so the export was stopped. Move the animation to the clips below, or remove these keyframes, then export again.");
    expect(rendered.es[0]).toContain("en Exposición, Temperatura,");
    expect(rendered.ja[0]).toBe("調整レイヤー「beach.mp4」の露出、色温度にキーフレームアニメーションがあり、まだ書き出しに対応していません。そのまま書き出すとプレビューと違ってしまうため、書き出しを停止しました。アニメーションを下のクリップに移すか、これらのキーフレームを削除してから書き出してください。");
    expect(rendered.ko[0]).toContain("‘beach.mp4’의 노출, 색온도에");
    expect(rendered.en[2]).toContain("current colour setting (ACES 2 rec2100_pq_1000)");
    expect(rendered.en[3]).toBe("“2.5D scene” inside the nested composition “Depth part” can't be exported yet; exporting anyway would flatten the picture, so the export was stopped. Move this content to the main project, or turn off “2.5D scene” inside the composition, then export again.");
    expect(rendered.ko[5]).toContain("중첩 컴포지션 ‘Sparks’ 안의 입자 효과은(는)");
    expect(rendered.es[6]).toContain("(precomposición con transparencia)");
    expect(rendered.ja[7]).toContain("（シーンリニア EXR）");
    expect(rendered.en[8]).toContain("(exports of 30 minutes or longer)");
    expect(rendered.en[9]).toContain("Exposure, Temperature, Tint, Contrast pivot, Shadows, Highlights, Blacks, Whites on clip “beach.mp4” changes over 2400 frames");
    expect(rendered.ja[9]).toContain("露出、色温度、色かぶり補正、コントラストの基準点、シャドウ、ハイライト、黒レベル、白レベル");
  });

  it("text that is not a refusal keeps the ordinary status translation", async () => {
    await interfacePreferences.setLocale("en");
    expect(translateExportRefusalTextV1("FFmpeg exit 1: something else")).toBe("FFmpeg exit 1: something else");
  });
});
