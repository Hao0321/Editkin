import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { buildGpuEnginePreviewGraph } from "../gpuCompositor";
import { PARITY_CANVAS_V1, parityFixtureProjectV1, type ParityFixtureV1 } from "./blendParityFixturesV1";
import { sampleParityPixelsOverBlackV1, type ParityRendererV1 } from "./blendParityHarnessV1";

const run = promisify(execFile);

/**
 * The native image preview route, executed headlessly: the product admission (`buildGpuEnginePreviewGraph`, the
 * graph the native still-image preview receives) and the real WGSL compositor on the GPU through the development
 * `editkin-gpu-compositor engine-render` command (offscreen, no window). A fixture the admission refuses is
 * "declined": the product falls back to the CSS preview for it.
 *
 * Not executed here: the Windows native video preview (SDR v2, windows_video.rs) and the ACES 2 scene-linear video
 * shader (scene_linear_video.wgsl). Both need decoded video sources and a resident window session; their blend
 * functions are pinned to the kernel's WGSL text by the shader source test instead.
 */
export function createParityNativeRendererV1(options: { executablePath: string; backend?: "gpu" | "cpu"; timeoutMs?: number }): ParityRendererV1 {
  let sequence = 0;
  return {
    id: "native",
    route: `native:image-preview(engine-render,${options.backend ?? "gpu"})`,
    async available() {
      if (!existsSync(options.executablePath)) return { ok: false, reason: `native compositor not found: ${options.executablePath}` };
      try {
        await run(options.executablePath, ["probe"], { timeout: 60_000, windowsHide: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `native compositor probe failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) };
      }
    },
    async render(fixture: ParityFixtureV1, context) {
      const project = parityFixtureProjectV1(fixture, image => context.imagePaths[image]);
      const preview = buildGpuEnginePreviewGraph(project, 0);
      if (!preview) return { kind: "declined", reason: "native image preview admission declined (falls back to the CSS preview)" };
      const directory = join(context.workDirectory, "native");
      await mkdir(directory, { recursive: true });
      const id = sequence += 1;
      const graph = join(directory, `graph-${id}.json`), bindings = join(directory, `bindings-${id}.json`), output = join(directory, `native-${id}.png`);
      await writeFile(graph, JSON.stringify(preview.graph));
      await writeFile(bindings, JSON.stringify(preview.assetBindings));
      await run(options.executablePath, ["engine-render", graph, bindings, String(preview.timelineFrame), output, options.backend ?? "gpu"],
        { timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const png = PNG.sync.read(await readFile(output));
      if (png.width !== PARITY_CANVAS_V1.width || png.height !== PARITY_CANVAS_V1.height) throw Error(`native output ${png.width}x${png.height}`);
      return { kind: "measured", samples: sampleParityPixelsOverBlackV1(png.data, png.width) };
    },
  };
}
