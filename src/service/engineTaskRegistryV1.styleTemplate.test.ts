import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** style_template_render_v1 on the service side, the handler stood in (real renders: engineTaskRegistryV1.styleTemplate.render.test.ts). */
const calls = vi.hoisted(() => ({ renders: [] as Array<{ raw: Record<string, unknown>; host: Record<string, unknown> & { resolveAssetPath: (uri: string) => string | Promise<string> } }>,
  templateId: "S1_explainer_ui" }));
vi.mock("../styleTemplates/slots/engineTask", () => ({
  runStyleTemplateRenderTaskV1: async (raw: Record<string, unknown>, host: Record<string, unknown> & { onProgress?: (p: unknown) => void; signal?: AbortSignal;
    resolveAssetPath: (uri: string) => string | Promise<string> }) => {
    calls.renders.push({ raw, host });
    for (const asset of raw.assets as Array<{ uri: string }>) await host.resolveAssetPath(asset.uri);
    host.onProgress?.({ phase: "images", completed: 1, total: 1, fraction: 0.08 });
    host.onProgress?.({ phase: "encode", completed: 3, total: 6, fraction: 0.75 });
    host.onProgress?.({ phase: "done", completed: 1, total: 1, fraction: 1 });
    host.signal?.throwIfAborted();
    const key = "e".repeat(64);
    return { schema: "editkin.style-template-render-reply/v1", operationId: raw.operationId,
      field: { schema: "editkin.style-job/v1", template: { id: calls.templateId, revision: 2 }, key, slots: raw.slots },
      asset: { id: `styletpl-${calls.templateId}-${key.slice(0, 16)}`, name: "產品教學（模板）", kind: "video", uri: `${host.cacheRoot}/styletpl-clip/${calls.templateId}/${key}.mov`, duration: 2 },
      path: "ignored", cacheHit: false, frameCount: 60, durationSeconds: 2 };
  },
}));
import { dispatchEngineTaskV1 } from "./engineTaskRegistryV1";

const temp = resolve(process.env.TEMP!);
let folder: string;
beforeEach(async () => { calls.renders = []; calls.templateId = "S1_explainer_ui"; folder = await mkdtemp(join(temp, "engine-task-styletpl-")); });
afterEach(async () => { if (!folder.startsWith(temp + sep)) throw Error("cleanup outside owned root"); await rm(folder, { recursive: true }); });

const picture = () => ({ id: "split", name: "split", kind: "image", uri: join(folder, "media", "split.png"), duration: 5, width: 1600, height: 900, redistributable: true });
const input = (extra: Record<string, unknown> = {}) => ({ operationId: "style-template-unit-1", templateId: "S1_explainer_ui",
  slots: { text: { keyword: "角色立繪" }, color: {}, image: { card: { source: { kind: "asset", assetId: "split" } } } },
  width: 1080, height: 1920, fps: 30, durationSeconds: 2, assets: [picture()], ...extra });
const runtime = () => ({ assetBase: folder, cacheRoot: join(folder, "cache"), ffmpeg: join(folder, "ffmpeg.exe"), ffprobe: join(folder, "ffprobe.exe") });
const hostInput = (extra: Record<string, unknown> = {}) => ({ cacheRoot: join(folder, "project-cache"), assetPaths: { [picture().uri]: join(folder, "admitted", "split.png") }, ...extra });
/** `host: null` sends no host input at all. */
const request = (inputValue: Record<string, unknown>, host: unknown = hostInput()) =>
  ({ schema: "editkin.engine-task/v1", kind: "style_template_render_v1", input: inputValue, ...(host === null ? {} : { hostInput: host }) });

describe("engine task style_template_render_v1 (service side)", () => {
  it("renders into the host cache root, reads pictures only from admitted files, and replies with the field and clip asset", async () => {
    await mkdir(join(folder, "cache"), { recursive: true });
    const progress: unknown[] = [];
    const reply = await dispatchEngineTaskV1(request(input()), runtime(), { onProgress: event => progress.push(event) });
    const [{ raw, host }] = calls.renders;
    expect(raw).toEqual(input());
    expect(host).toMatchObject({ cacheRoot: join(folder, "project-cache"), ffmpegPath: join(folder, "ffmpeg.exe"), ffprobePath: join(folder, "ffprobe.exe") });
    expect(await host.resolveAssetPath(picture().uri)).toBe(join(folder, "admitted", "split.png"));
    expect(() => host.resolveAssetPath(join(folder, "elsewhere.png"))).toThrow("ENGINE_TASK_STYLE_TEMPLATE_ASSET_NOT_ADMITTED");
    expect(reply).toMatchObject({ schema: "editkin.engine-task-reply/v1", kind: "style_template_render_v1", operationId: "style-template-unit-1",
      result: { schema: "editkin.style-template-render-reply/v1", request: input(), field: { template: { id: "S1_explainer_ui" }, key: "e".repeat(64) },
        asset: { kind: "video" }, cacheHit: false, frameCount: 60, durationSeconds: 2 } });
    expect(reply.result).not.toHaveProperty("path");
    expect(progress.map(event => (event as { progress: unknown }).progress)).toEqual([
      { stage: "images", completed: 1, total: 1, fraction: 0.08 }, { stage: "encode", completed: 3, total: 6, fraction: 0.75 }, { stage: "done", completed: 1, total: 1, fraction: 1 }]);
    expect(progress.every(event => (event as { kind: string }).kind === "style_template_render_v1")).toBe(true);
  });

  it("refuses renderer paths, foreign asset fields, a missing or relative host input and an unbound picture before rendering", async () => {
    const asset = picture();
    const refused: Array<[string, unknown]> = [
      ["renderer cache root", request(input({ cacheRoot: "C:/x" }))],
      ["renderer output path", request(input({ outputPath: "C:/x.mov" }))],
      ["asset derivatives", request(input({ assets: [{ ...asset, derivatives: { proxyPath: "poison.mp4" } }] }))],
      ["audio picture", request(input({ assets: [{ ...asset, kind: "audio" }] }))],
      ["duplicate asset ids", request(input({ assets: [asset, { ...asset, uri: join(folder, "b.png") }] }))],
      ["seven assets", request(input({ assets: Array.from({ length: 7 }, (_, i) => ({ ...asset, id: `a${i}` })) }))],
      ["template path", request(input({ templateId: "S1_../../x" }))],
      ["long operation id", request(input({ operationId: "a".repeat(65) }))],
      ["slot shape", request(input({ slots: { text: {}, color: {} } }))],
      ["no host input", request(input(), null)],
      ["relative host cache root", request(input(), hostInput({ cacheRoot: "relative/cache" }))],
      ["host input extra key", request(input(), hostInput({ outputPath: "C:/x" }))],
      ["unbound picture", request(input(), hostInput({ assetPaths: {} }))],
      ["foreign picture", request(input(), hostInput({ assetPaths: { [asset.uri]: join(folder, "a.png"), [join(folder, "other.png")]: join(folder, "b.png") } }))],
      ["relative admitted path", request(input(), hostInput({ assetPaths: { [asset.uri]: "media/split.png" } }))],
      ["network admitted path", request(input(), hostInput({ assetPaths: { [asset.uri]: "\\\\attacker\\share\\split.png" } }))],
    ];
    const admitted: string[] = [];
    for (const [name, payload] of refused) await dispatchEngineTaskV1(payload, runtime()).then(() => admitted.push(name), () => undefined);
    expect(admitted).toEqual([]);
    expect(calls.renders).toEqual([]);
  });

  it("refuses a reply for another template", async () => {
    await mkdir(join(folder, "cache"), { recursive: true });
    calls.templateId = "S5_vox_collage";
    await expect(dispatchEngineTaskV1(request(input()), runtime())).rejects.toThrow("ENGINE_TASK_REPLY_BINDING_CHANGED");
  });

  it("renders a template without pictures with an empty admitted set", async () => {
    await mkdir(join(folder, "cache"), { recursive: true });
    const noPictures = input({ slots: { text: { keyword: "遊戲引擎" }, color: { accent: "#FF5500" }, image: {} }, assets: [] });
    const reply = await dispatchEngineTaskV1(request(noPictures, hostInput({ assetPaths: {} })), runtime());
    expect(reply.result).toMatchObject({ request: noPictures });
  });
});
