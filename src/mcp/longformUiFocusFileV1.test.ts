import { readFile, writeFile, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { readProject } from "./storage";
import { colorBytesSha } from "../application/materialColorSamplingRuntime";
import { uiFocusFileFixtureV1 } from "../application/longformUiFocusFileV1.fixture";
import { assembleLongformUiFocusDraftV1 } from "../application/longformUiFocusV1";
import { prepareLongformUiFocusFileV1, readCurrentLongformUiFocusFileV1, confirmLongformUiFocusFileV1 } from "./longformUiFocusFileV1";

vi.mock("../application/materialColorSamplingRuntime", async original => ({ ...await original<typeof import("../application/materialColorSamplingRuntime")>(),
  getMaterialColorRuntimeIdentity: async () => ({ schema: "editkin.material-color-runtime/v1", status: "verified", identitySha256: "a".repeat(64), tools: [], implementations: [] }),
  colorFileSha: async () => "a".repeat(64),
}));
const temp = useTempRoots(); afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const root = await temp.create("uif-file-", { parent: tmpdir() }); expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  vi.stubEnv("EDITKIN_WORKSPACE", root);
  const sourcePath = join(root, "source.mp4"); await writeFile(sourcePath, "owned protocol-control media");
  const f = uiFocusFileFixtureV1(root, sourcePath, colorBytesSha(await readFile(sourcePath)));
  await writeFile(f.request.projectPath, JSON.stringify(f.project));
  const runtime = { sourceRoot: root, workRoot: join(root, "work"), cacheRoot: join(root, "cache"), ffmpegPath: join(root, "ffmpeg-control.exe") };
  const detect = vi.fn<typeof import("../application/longformUiFocusRuntimeV1").detectLongformUiFocusV1>(async (_raw, runtime) => {
    await runtime.onFrame?.({ ...structuredClone(f.frame), data: Uint8Array.from(f.image) });
    return assembleLongformUiFocusDraftV1(f.source, [f.frame], [], f.request.targetTexts);
  });
  return { root, sourcePath, runtime, deps: { read: readProject, detect }, ...f };
}
it("checks real project/source files, binds detector-produced pixels, reads and confirms without changing author bytes (detector protocol mocked)", async () => {
  const f = await fixture(), before = await readFile(f.request.projectPath);
  const result = await prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps);
  expect(result.summary).toMatchObject({ frameCount: 1, candidateCount: 3, focusHintsReady: false, projectModified: false });
  const artifact = await readCurrentLongformUiFocusFileV1(result.artifact.artifactId, f.runtime, f.deps);
  const confirmation = await confirmLongformUiFocusFileV1(artifact, [artifact.draft.candidates[0].candidateId], f.runtime, f.deps);
  expect(confirmation.focusHintsReady).toBe(false); expect(await readFile(f.request.projectPath)).toEqual(before);
});
it("refuses stale revision, outside clip clocks and media outside workspace before running OCR", async () => {
  const f = await fixture();
  await expect(prepareLongformUiFocusFileV1({ ...f.request, expectedRevision: 99 }, f.runtime, undefined, f.deps)).rejects.toThrow("REVISION");
  await expect(prepareLongformUiFocusFileV1({ ...f.request, frameTimes: [1] }, f.runtime, undefined, f.deps)).rejects.toThrow("OUTSIDE_CLIP");
  f.project.assets[0].uri = join(resolve(f.root, ".."), "outside-source.mp4"); await writeFile(f.request.projectPath, JSON.stringify(f.project));
  await expect(prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps)).rejects.toThrow();
  expect(f.deps.detect).not.toHaveBeenCalled();
});
it("source replacement or a project edit during OCR cannot publish a usable current artifact", async () => {
  const f = await fixture(); f.deps.detect.mockImplementationOnce(async (...args) => {
    await writeFile(f.sourcePath, "replacement"); return assembleLongformUiFocusDraftV1(f.source, [f.frame], [], f.request.targetTexts);
  });
  await expect(prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps)).rejects.toThrow("SOURCE_CHANGED");
  await writeFile(f.sourcePath, "owned protocol-control media");
  f.deps.detect.mockImplementationOnce(async () => {
    f.project.name = "edit while OCR runs"; await writeFile(f.request.projectPath, JSON.stringify(f.project));
    return assembleLongformUiFocusDraftV1(f.source, [f.frame], [], f.request.targetTexts);
  });
  await expect(prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps)).rejects.toThrow("PROJECT_CHANGED");
});
it("later source or project drift invalidates current reads and confirmation", async () => {
  const f = await fixture(), result = await prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps);
  await writeFile(f.sourcePath, "later replacement");
  await expect(readCurrentLongformUiFocusFileV1(result.artifact.artifactId, f.runtime, f.deps)).rejects.toThrow("SOURCE_CHANGED");
  await writeFile(f.sourcePath, "owned protocol-control media"); f.project.revision++; await writeFile(f.request.projectPath, JSON.stringify(f.project));
  await expect(confirmLongformUiFocusFileV1(result.artifact, [result.artifact.draft.candidates[0].candidateId], f.runtime, f.deps)).rejects.toThrow("REVISION");
});
it("canonical cache admission stays held through cancellation settlement, including a junction alias", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), controller = new AbortController();
  const normal = f.deps.detect.getMockImplementation()!;
  f.deps.detect.mockImplementationOnce(async (...args) => { entered.resolve(); await finish.promise; args[1].signal?.throwIfAborted(); return normal(...args); });
  const first = prepareLongformUiFocusFileV1(f.request, { ...f.runtime, signal: controller.signal }, undefined, f.deps).then(() => null, error => error);
  await entered.promise; controller.abort();
  const alias = join(f.root, "cache-alias"); await symlink(f.runtime.cacheRoot, alias, "junction");
  await expect(prepareLongformUiFocusFileV1(f.request, { ...f.runtime, cacheRoot: alias }, undefined, f.deps)).rejects.toThrow("CACHE_BUSY");
  finish.resolve(); expect(await first).toMatchObject({ name: "AbortError" });
  await expect(prepareLongformUiFocusFileV1(f.request, f.runtime, undefined, f.deps)).resolves.toHaveProperty("artifact");
});
