import { describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "../domain/types";
import { desktopStyleTemplateRenderHostV1, STYLE_TEMPLATE_CANCELLED_V1, type StyleTemplateRenderRequestV1 } from "../styleTemplates/slots/renderHost";
import { createEngineTaskHostV1 } from "./engineTaskHostV1";
import { createStyleTemplateDesktopApiV1, styleTemplateEngineInputV1 } from "./styleTemplateDesktopV1";

/**
 * The 「模板片段」 inspector's desktop path without Tauri: renderHost → desktop API → typed engine task host → (fake) native
 * invoke. The native side and the service are tested in engine_tasks_v1.rs and engineTaskRegistryV1.styleTemplate*.test.ts.
 */
const PICTURE: MediaAsset = { id: "split", name: "split", kind: "image", uri: "D:\\media\\split.png", duration: 5, width: 1600, height: 900, redistributable: true,
  license: "own", provenance: "camera roll", alphaMode: "opaque", color: { interpretation: "rec709" }, derivatives: { proxyPath: "D:\\cache\\poison.mp4" } } as unknown as MediaAsset;
const request = (extra: Partial<StyleTemplateRenderRequestV1> = {}): StyleTemplateRenderRequestV1 & { operationId: string } => ({ operationId: "style-template-host-1",
  templateId: "S1_explainer_ui", slots: { text: { keyword: "角色立繪" }, color: {}, image: { card: { source: { kind: "asset", assetId: "split" } } } },
  width: 1080, height: 1920, fps: 30, durationSeconds: 2, assets: [PICTURE], ...extra });
const KEY = "f".repeat(64);
const clipAsset = { id: `styletpl-S1_explainer_ui-${KEY.slice(0, 16)}`, name: "產品教學（模板）", kind: "video", uri: `C:\\cache\\styletpl-clip\\S1_explainer_ui\\${KEY}.mov`,
  duration: 2, width: 1080, height: 1920, alphaMode: "opaque" };

function harness() {
  let receive: (event: unknown) => void = () => undefined;
  let resolve!: (reply: unknown) => void;
  const pending = new Promise(done => { resolve = done; });
  const invoke = vi.fn((command: string, _args: Record<string, unknown>) => command === "run_engine_task_v1" ? pending : Promise.resolve({ known: true, cancelRequested: true }));
  const engineTasks = createEngineTaskHostV1(invoke as never, fn => { receive = fn; return { channel: true }; });
  const picked: Array<{ asset: MediaAsset; previewPath: string }> = [];
  const api = createStyleTemplateDesktopApiV1(engineTasks, { convertFileSrc: path => `asset://localhost/${encodeURIComponent(path)}`, pickImageFiles: async () => picked });
  const sent = () => (invoke.mock.calls[0][1] as { request: { kind: string; input: Record<string, unknown> } }).request;
  const reply = (templateId = "S1_explainer_ui", operationId = sent().input.operationId as string) => ({ schema: "editkin.engine-task-reply/v1", kind: "style_template_render_v1", operationId,
    result: { schema: "editkin.style-template-render-reply/v1", request: structuredClone(sent().input), field: { template: { id: templateId, revision: 2 }, key: KEY }, asset: clipAsset,
      cacheHit: false, frameCount: 60, durationSeconds: 2 } });
  const progress = (stage: string, fraction?: number) => receive({ schema: "editkin.engine-task-progress/v1", kind: "style_template_render_v1", operationId: sent().input.operationId,
    progress: { stage, completed: 1, total: 2, ...(fraction === undefined ? {} : { fraction }) } });
  return { invoke, api, picked, sent, reply, resolve, progress, ack: () => receive({ schema: "editkin.engine-task-host/v1", kind: "style_template_render_v1", operationId: sent().input.operationId, stage: "registered" }) };
}

describe("style template engine input (what crosses IPC)", () => {
  it("projects a project picture to the render's minimal record", () => {
    const input = styleTemplateEngineInputV1(request({ assets: [{ ...PICTURE, name: "長".repeat(500) }] }));
    expect(input.assets).toEqual([{ id: "split", name: "長".repeat(400), kind: "image", uri: "D:\\media\\split.png", duration: 5, width: 1600, height: 900, license: "own", redistributable: true }]);
    expect(JSON.stringify(input)).not.toMatch(/poison|camera roll|interpretation/);
  });
  it("refuses a composition, an image sequence or an audio asset as a picture, and an invalid request", () => {
    expect(() => styleTemplateEngineInputV1(request({ assets: [{ ...PICTURE, kind: "video", compositionId: "comp" }] }))).toThrow("STYLE_JOB_SLOT_ASSET_KIND");
    expect(() => styleTemplateEngineInputV1(request({ assets: [{ ...PICTURE, imageSequence: {} as never }] }))).toThrow("STYLE_JOB_SLOT_ASSET_KIND");
    expect(() => styleTemplateEngineInputV1(request({ assets: [{ ...PICTURE, kind: "audio" }] }))).toThrow("STYLE_JOB_SLOT_ASSET_KIND");
    expect(() => styleTemplateEngineInputV1(request({ templateId: "S1_../x" }))).toThrow();
    expect(() => styleTemplateEngineInputV1(request({ durationSeconds: 0.1 }))).toThrow();
    expect(() => styleTemplateEngineInputV1({ ...request(), operationId: "Style_1" })).toThrow();
  });
});

describe("desktop style template render (inspector → engine task)", () => {
  it("sends one typed task, maps progress and answers the field, the clip asset and its webview URL", async () => {
    const h = harness(), onProgress = vi.fn();
    const host = desktopStyleTemplateRenderHostV1(h.api)!;
    const done = host.render(request(), { signal: new AbortController().signal, onProgress });
    await Promise.resolve();
    expect(h.invoke).toHaveBeenCalledOnce();
    expect(h.invoke.mock.calls[0][0]).toBe("run_engine_task_v1");
    expect(h.sent()).toMatchObject({ schema: "editkin.engine-task/v1", kind: "style_template_render_v1", input: { templateId: "S1_explainer_ui", width: 1080, height: 1920 } });
    expect(h.sent().input.operationId).toMatch(/^style-template-[0-9a-f-]{36}$/);
    expect(Object.keys((h.sent().input.assets as object[])[0])).not.toContain("derivatives");
    h.progress("images", 0.04); h.progress("encode"); h.progress("render", 0.5); h.progress("encode", 1.4); h.progress("encode", 0.7);
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([{ phase: "images", fraction: 0.04 }, { phase: "encode", fraction: 0.7 }]);
    h.resolve(h.reply());
    await expect(done).resolves.toEqual({ field: { template: { id: "S1_explainer_ui", revision: 2 }, key: KEY }, asset: clipAsset,
      previewUrls: { [clipAsset.id]: `asset://localhost/${encodeURIComponent(clipAsset.uri)}` } });
  });

  it("refuses a reply for another template or operation", async () => {
    for (const [templateId, operationId] of [["S5_vox_collage", undefined], ["S1_explainer_ui", "style-template-foreign"]] as const) {
      const h = harness(), done = h.api.renderStyleTemplateV1(request(), { signal: new AbortController().signal });
      await Promise.resolve(); h.resolve(h.reply(templateId, operationId));
      await expect(done).rejects.toThrow("ENGINE_TASK_REPLY_BINDING_CHANGED");
    }
  });

  it("cancels the native task once registered and reports the inspector's cancel code", async () => {
    const h = harness(), controller = new AbortController();
    const done = desktopStyleTemplateRenderHostV1(h.api)!.render(request(), { signal: controller.signal, onProgress: () => undefined });
    await Promise.resolve();
    controller.abort(); h.ack();
    expect(h.invoke.mock.calls[1]).toEqual(["cancel_engine_task_v1", { operationId: h.sent().input.operationId }]);
    h.resolve(h.reply());
    await expect(done).rejects.toThrow(STYLE_TEMPLATE_CANCELLED_V1);
  });
});

describe("desktop picture chooser and picture URLs", () => {
  it("answers one picked picture, nothing for a cancel, and refuses anything but one picture", async () => {
    const h = harness();
    await expect(h.api.pickStyleTemplateImageV1()).resolves.toBeUndefined();
    h.picked.push({ asset: PICTURE, previewPath: PICTURE.uri });
    await expect(h.api.pickStyleTemplateImageV1()).resolves.toBe(PICTURE);
    h.picked.push({ asset: PICTURE, previewPath: PICTURE.uri });
    await expect(h.api.pickStyleTemplateImageV1()).rejects.toThrow("STYLE_TEMPLATE_IMAGE_REQUIRED");
    h.picked.splice(0, 2, { asset: { ...PICTURE, kind: "video" }, previewPath: PICTURE.uri });
    await expect(h.api.pickStyleTemplateImageV1()).rejects.toThrow("STYLE_TEMPLATE_IMAGE_REQUIRED");
  });
  it("gives a webview URL only for a local picture file", () => {
    const { api } = harness();
    expect(api.styleTemplateAssetUrlV1(PICTURE)).toBe(`asset://localhost/${encodeURIComponent(PICTURE.uri)}`);
    expect(api.styleTemplateAssetUrlV1({ ...PICTURE, uri: "/Users/hao/split.png" })).toMatch(/^asset:/);
    for (const uri of ["split.png", "\\\\attacker\\share\\split.png", "//attacker/share/split.png", "creative:pic", "https://example.com/a.png"]) {
      expect(api.styleTemplateAssetUrlV1({ ...PICTURE, uri }), uri).toBeUndefined();
    }
    expect(api.styleTemplateAssetUrlV1({ ...PICTURE, kind: "video" })).toBeUndefined();
  });
});
