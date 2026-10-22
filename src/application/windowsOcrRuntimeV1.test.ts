import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recognizeWindowsOcrV1 } from "./windowsOcrRuntimeV1";
import { uiFocusFixtureV1 } from "./longformUiFocusV1.fixture";
import { WINDOWS_OCR_SCRIPT_V1 } from "./windowsOcrScriptV1";
import { colorBytesSha } from "./materialColorSamplingRuntime";
import { windowsOcrResponseV1Schema } from "../domain/windowsOcrV1";

const control = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./materialColorSamplingRuntime", async original => ({ ...await original<typeof import("./materialColorSamplingRuntime")>(), runColorProcess: control.run }));
const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { for (const root of roots.splice(0)) { await unlink(join(root, "preserve.txt")); await rmdir(root); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ocr-provider-test-")); roots.push(root); await writeFile(join(root, "preserve.txt"), "untouched");
  const f = uiFocusFixtureV1(), request = { imageSha256: colorBytesSha(f.image), width: 960, height: 640, language: "zh-Hant-TW" };
  control.run.mockResolvedValue({ stdout: Buffer.from(JSON.stringify(f.frame.ocr.result)), stderr: "" });
  return { root, f, request };
}
// Process responses here are protocol controls; physical evidence runs the OS.
it.skipIf(process.platform !== "win32")("uses fixed -File program/separate arguments, bounds process and removes only its own files", async () => {
  const f = await fixture();
  control.run.mockImplementationOnce(async (_exe, args, cap, timeout) => {
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
    expect(await readFile(args[4], "utf8")).toBe(WINDOWS_OCR_SCRIPT_V1);
    expect(await readFile(args[6])).toEqual(f.f.image); expect(args.slice(7)).toEqual(["-LanguageTag", "zh-Hant-TW"]);
    expect(cap).toBe(524288); expect(timeout).toBe(15000);
    return { stdout: Buffer.from(JSON.stringify(f.f.frame.ocr.result)), stderr: "" };
  });
  const receipt = await recognizeWindowsOcrV1(f.f.image, f.request, { workRoot: f.root });
  expect(receipt).toMatchObject({ imageSha256: f.request.imageSha256, calibratedConfidenceAvailable: false,
    provider: { resources: "existing-installed-os-language-components", modelBinarySha256Verified: false } });
  expect(await readdir(f.root)).toEqual(["preserve.txt"]);
});
it.skipIf(process.platform !== "win32")("refuses image tampering, dimension/language substitution and malformed raw observation fields", async () => {
  const f = await fixture();
  await expect(recognizeWindowsOcrV1(f.f.image, { ...f.request, imageSha256: "b".repeat(64) }, { workRoot: f.root })).rejects.toThrow("IMAGE_BINDING");
  expect(control.run).not.toHaveBeenCalled();
  for (const result of [{ ...f.f.frame.ocr.result, width: 959 }, { ...f.f.frame.ocr.result, language: "en-US" },
    { ...f.f.frame.ocr.result, madeUpConfidence: .99 }]) {
    control.run.mockResolvedValueOnce({ stdout: Buffer.from(JSON.stringify(result)), stderr: "" });
    await expect(recognizeWindowsOcrV1(f.f.image, f.request, { workRoot: f.root })).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(["preserve.txt"]);
  }
});
it.skipIf(process.platform !== "win32")("cancellation and child failure settle before owned helper cleanup", async () => {
  const f = await fixture(), cancelled = new AbortController(); cancelled.abort();
  await expect(recognizeWindowsOcrV1(f.f.image, f.request, { workRoot: f.root, signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(control.run).not.toHaveBeenCalled();
  control.run.mockRejectedValueOnce(Error("analysis-cancelled"));
  await expect(recognizeWindowsOcrV1(f.f.image, f.request, { workRoot: f.root })).rejects.toThrow("analysis-cancelled");
  expect(await readdir(f.root)).toEqual(["preserve.txt"]);
});
it.skipIf(process.platform !== "win32")("detects replacement of the detector's image before publishing a receipt", async () => {
  const f = await fixture(); control.run.mockImplementationOnce(async (_exe, args) => {
    await writeFile(args[6], Buffer.from([255, 216, 1, 255, 217]));
    return { stdout: Buffer.from(JSON.stringify(f.f.frame.ocr.result)), stderr: "" };
  });
  await expect(recognizeWindowsOcrV1(f.f.image, f.request, { workRoot: f.root })).rejects.toThrow("INPUT_OR_PROVIDER_CHANGED");
  expect(await readdir(f.root)).toEqual(["preserve.txt"]);
});
it("closed response schema rejects invented confidence, invalid indexes, oversize image and nonfinite boxes", () => {
  const f = uiFocusFixtureV1(); expect(windowsOcrResponseV1Schema.safeParse(f.frame.ocr.result).success).toBe(true);
  for (const mutate of [
    (r: typeof f.frame.ocr.result) => { r.width = 1281; },
    (r: typeof f.frame.ocr.result) => { r.processing.recognitionWidth = r.width; },
    (r: typeof f.frame.ocr.result) => { r.lines[0].index = 1; },
    (r: typeof f.frame.ocr.result) => { r.lines[0].words[0].x = NaN; },
    (r: typeof f.frame.ocr.result) => { (r.lines[0].words[0] as unknown as Record<string, unknown>).confidence = .5; },
  ]) { const r = structuredClone(f.frame.ocr.result); mutate(r); expect(windowsOcrResponseV1Schema.safeParse(r).success).toBe(false); }
});
