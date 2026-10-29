import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StyleTemplateRenderEngineTaskReplyV1, StyleTemplateRenderInputV1 } from "../application/engineTaskContractV1";
import { runColorProcess } from "../application/materialColorSamplingRuntime";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { assertStyleJobClipV1 } from "../domain/styleJobV1";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, MediaAsset } from "../domain/types";
import { createStyleTemplateDesktopApiV1, styleTemplateEngineInputV1 } from "../desktop/styleTemplateDesktopV1";
import { styleTemplateAddClipCommandV1 } from "../styleTemplates/slots/clipCommands";
import { createStyleTemplateInspectorControllerV1 } from "../styleTemplates/slots/inspectorModel";
import { desktopStyleTemplateRenderHostV1 } from "../styleTemplates/slots/renderHost";
import { assertStyleTemplateProjectFilesV1 } from "../styleTemplates/slots/renderTemplateClip";

/**
 * Headless end to end of the 「模板片段」 re-render through the service entry: every render is one `node tsx src/service/cli.ts`
 * child fed the exact `engine_task_v1` request the native host builds (engine_tasks_v1.rs: owned job files, host cache root,
 * admitted picture paths). Renders the S1 template clip with a real picture, repeats it (cache hit), then changes one slot
 * through the inspector controller (renderHost → desktop API → service) and applies the one update command it produces.
 */
const app = resolve("."), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const W = 540, H = 960, FPS = 30;
let root: string, cacheRoot: string, picture: MediaAsset;

beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `styletpl-engine-e2e-${process.pid}`);
  cacheRoot = join(root, "cache");
  await mkdir(join(root, "media"), { recursive: true }); await mkdir(cacheRoot, { recursive: true });
  // An owned test picture: red | blue halves, 1600 × 900.
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=0xD02828:s=800x900", "-f", "lavfi", "-i", "color=c=0x2850D0:s=800x900",
    "-filter_complex", "[0:v][1:v]hstack=inputs=2,format=rgb24", "-frames:v", "1", join(root, "media", "split.png")], 4096, 60_000);
  picture = { id: "split", name: "split", kind: "image", uri: join(root, "media", "split.png"), duration: 5, width: 1600, height: 900, redistributable: true,
    provenance: "owned test picture (lavfi colour halves)" };
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** What engine_tasks_v1.rs sends for this input: a fresh owned job folder, the host cache root and each admitted picture. */
async function nativeHostRequest(input: StyleTemplateRenderInputV1, admitted?: Record<string, string>) {
  const jobFolder = join(cacheRoot, "engine-jobs-v1", input.operationId);
  await mkdir(jobFolder, { recursive: true });
  const assetPaths = admitted ?? Object.fromEntries(await Promise.all(input.assets.map(async asset => [asset.uri, await realpath(asset.uri)] as const)));
  return { command: "engine_task_v1", runtime: { assetBase: app, cacheRoot, ffmpeg, ffprobe },
    payload: { schema: "editkin.engine-task/v1", kind: "style_template_render_v1", input,
      job: { progressPath: join(jobFolder, "progress.json"), cancelPath: join(jobFolder, "cancel.request") }, hostInput: { cacheRoot, assetPaths } } };
}

/** One service child, as the native host runs it: request on stdin, `{ok, result | error}` on stdout. */
function serviceEntry(request: unknown): Promise<{ ok: boolean; result?: StyleTemplateRenderEngineTaskReplyV1; error?: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/service/cli.ts")], { cwd: app, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", fail);
    child.on("close", () => {
      try { done(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch { fail(new Error(`service gave no envelope: ${Buffer.concat(err).toString("utf8").slice(-2000)}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function render(input: StyleTemplateRenderInputV1) {
  const envelope = await serviceEntry(await nativeHostRequest(input));
  if (!envelope.ok || !envelope.result) throw new Error(`service refused: ${envelope.error}`);
  return envelope.result;
}
const packets = async (path: string) => Number((await runColorProcess(ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
  "stream=nb_read_packets", "-of", "csv=p=0", path], 4096, 30_000)).stdout.toString("utf8").trim());
const slots = (keyword: string) => ({ text: { chapterNumber: "01", chapterLabel: "用 AI 做遊戲", lead: "還有", keyword, tag: "GPT" },
  color: {}, image: { card: { source: { kind: "asset" as const, assetId: "split" }, fit: "cover" as const, focal: [0.2, 0.5] as [number, number] } } });
const request = (operationId: string, keyword: string) => styleTemplateEngineInputV1({ operationId, templateId: "S1_explainer_ui", slots: slots(keyword),
  width: W, height: H, fps: FPS, durationSeconds: 2.2, assets: [picture] });

describe("style_template_render_v1 through the service entry (real renders)", () => {
  it("renders S1, hits the cache for the same slots, and re-renders one changed slot through the inspector into one update", async () => {
    // 1. First render.
    const first = await render(request("style-e2e-first-0001", "角色立繪"));
    expect(first).toMatchObject({ schema: "editkin.engine-task-reply/v1", kind: "style_template_render_v1", operationId: "style-e2e-first-0001",
      result: { schema: "editkin.style-template-render-reply/v1", request: request("style-e2e-first-0001", "角色立繪"), cacheHit: false, frameCount: 66,
        field: { template: { id: "S1_explainer_ui" }, component: { id: "uiCardScene" }, output: "opaque" } } });
    const clipPath = join(cacheRoot, "styletpl-clip", "S1_explainer_ui", `${first.result.field.key}.mov`);
    expect(first.result.asset.uri).toBe(clipPath);
    expect(await packets(clipPath)).toBe(66);
    // The job's progress file ends where the native watcher expects (stage, counts and fraction).
    const progress = JSON.parse(await readFile(join(cacheRoot, "engine-jobs-v1", "style-e2e-first-0001", "progress.json"), "utf8"));
    expect(progress).toMatchObject({ schema: "editkin.engine-task-progress/v1", kind: "style_template_render_v1", operationId: "style-e2e-first-0001",
      progress: { stage: "done", completed: 1, total: 1, fraction: 1 } });

    // 2. Same slots: a cache hit, same file; the picture derivative is reused.
    const again = await render(request("style-e2e-again-0002", "角色立繪"));
    expect(again.result).toMatchObject({ cacheHit: true, field: { key: first.result.field.key }, asset: { uri: clipPath } });

    // 3. One slot changed in the inspector: renderHost → desktop API → engine task (service child) → one update command.
    let project: EditProject = applyCommand(createEmptyProject("Template clip e2e", { id: "e2e", width: W, height: H, fps: FPS }), { type: "import_asset", asset: picture });
    project = validateProject(applyCommand(project, styleTemplateAddClipCommandV1(project, first.result, { clipId: "tpl-1", startFrame: 0 })));
    const tasks: StyleTemplateRenderInputV1[] = [];
    const api = createStyleTemplateDesktopApiV1({
      runStyleTemplateRenderTaskV1: async input => { tasks.push(input); return render(input); },
    }, { convertFileSrc: path => `asset://localhost/${encodeURIComponent(path)}`, pickImageFiles: async () => [] });
    const commands: EditorCommand[] = [], urls: Record<string, string>[] = [];
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => project, clipId: "tpl-1", host: desktopStyleTemplateRenderHostV1(api),
      runCommand: command => { commands.push(command); project = validateProject(applyCommand(project, command)); return true; }, mergeRuntimeUrls: value => urls.push(value), delayMs: 0 });
    const draft = controller.getSnapshot().draft;
    controller.edit({ ...draft, text: { ...draft.text, keyword: "遊戲引擎" } });
    await controller.flush();
    expect(controller.getSnapshot()).toMatchObject({ status: "applied" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assets).toEqual([{ id: "split", name: "split", kind: "image", uri: picture.uri, duration: 5, width: 1600, height: 900, redistributable: true }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "update_style_template_clip", clipId: "tpl-1", expected: { assetId: first.result.asset.id, key: first.result.field.key } });
    const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === "tpl-1")!;
    expect(clip.styleJob).toMatchObject({ slots: { text: { keyword: "遊戲引擎" } } });
    expect(clip.styleJob!.key).not.toBe(first.result.field.key);
    expect(assertStyleJobClipV1(project, "video", clip)).toBe("current");
    expect(urls).toEqual([{ [clip.assetId]: `asset://localhost/${encodeURIComponent(join(cacheRoot, "styletpl-clip", "S1_explainer_ui", `${clip.styleJob!.key}.mov`))}` }]);
    expect(await packets(project.assets.find(asset => asset.id === clip.assetId)!.uri)).toBe(66);
    expect(await assertStyleTemplateProjectFilesV1(project, cacheRoot)).toBe(1);
    // Both renders stay in the cache (Undo plays the first again); one picture derivative served all three renders.
    expect((await stat(clipPath)).isFile()).toBe(true);
    const derivatives = (await readdir(join(cacheRoot, "styletpl-img"))).filter(name => !name.startsWith("req-"));
    expect(derivatives).toHaveLength(1);
  }, 900_000);

  it("refuses a picture the host did not admit, before any render", async () => {
    const input = request("style-e2e-refuse-0003", "拒絕");
    const envelope = await serviceEntry(await nativeHostRequest(input, {}));
    expect(envelope).toMatchObject({ ok: false, error: "ENGINE_TASK_STYLE_TEMPLATE_ASSET_BINDING_CHANGED" });
  }, 120_000);
});
