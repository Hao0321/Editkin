import { mkdir, mkdtemp, realpath, rmdir, unlink, writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { colorBytesSha, colorDigest, colorFileSha, runColorProcess } from "./materialColorSamplingRuntime";
import { WINDOWS_OCR_SCRIPT_V1 } from "./windowsOcrScriptV1";
import { windowsOcrImageRequestV1Schema, windowsOcrResponseV1Schema, type WindowsOcrReceiptV1 } from "../domain/windowsOcrV1";

export interface WindowsOcrRuntimeV1 { workRoot: string; signal?: AbortSignal }
export function windowsOcrExecutableV1(): string {
  if (process.platform !== "win32") throw Error("OCR_WINDOWS_REQUIRED");
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
export function verifyWindowsOcrReceiptV1(receipt: WindowsOcrReceiptV1) {
  windowsOcrResponseV1Schema.parse(receipt.result);
  if (receipt.schema !== "editkin.windows-ocr-receipt/v1" || receipt.receiptSha256 !== colorDigest({ ...receipt, receiptSha256: undefined })
    || !/^[a-f0-9]{64}$/.test(receipt.imageSha256) || !/^[a-f0-9]{64}$/.test(receipt.provider.executableSha256)
    || receipt.provider.scriptSha256 !== colorBytesSha(Buffer.from(WINDOWS_OCR_SCRIPT_V1))
    || receipt.provider.engine !== "Windows.Media.Ocr" || receipt.provider.resources !== "existing-installed-os-language-components"
    || receipt.provider.modelBinarySha256Verified !== false || receipt.authority !== "text-regions-in-this-image-only"
    || receipt.calibratedConfidenceAvailable !== false) throw Error("OCR_RECEIPT_INCONSISTENT");
}

/** Read-only OCR over caller-owned bytes. A seal proves consistency, not trusted
 * origin: production detection obtains its bytes directly from current media. */
export async function recognizeWindowsOcrV1(image: Uint8Array, raw: unknown, runtime: WindowsOcrRuntimeV1): Promise<WindowsOcrReceiptV1> {
  const request = windowsOcrImageRequestV1Schema.parse(raw);
  runtime.signal?.throwIfAborted();
  const executable = await realpath(windowsOcrExecutableV1());
  if (image.length < 4 || image.length > 8 * 1024 * 1024 || image[0] !== 255 || image[1] !== 216
    || image.at(-2) !== 255 || image.at(-1) !== 217 || colorBytesSha(image) !== request.imageSha256) throw Error("OCR_IMAGE_BINDING");
  if (!isAbsolute(runtime.workRoot)) throw Error("OCR_ABSOLUTE_WORK_ROOT_REQUIRED");
  await mkdir(runtime.workRoot, { recursive: true });
  const root = await realpath(runtime.workRoot), directory = await mkdtemp(join(root, "ocr-v1-"));
  const imagePath = join(directory, "input.jpg"), scriptPath = join(directory, "provider.ps1");
  const relation = relative(root, await realpath(directory));
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw Error("OCR_WORK_BOUNDARY");
  try {
    await writeFile(imagePath, image, { flag: "wx" });
    await writeFile(scriptPath, WINDOWS_OCR_SCRIPT_V1, { flag: "wx" });
    const executableSha256 = await colorFileSha(executable);
    const actual = await runColorProcess(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath,
      "-ImagePath", imagePath, "-LanguageTag", request.language], 524288, 15000, runtime.signal);
    runtime.signal?.throwIfAborted();
    if (await colorFileSha(executable) !== executableSha256 || colorBytesSha(await readFile(imagePath)) !== request.imageSha256
      || colorBytesSha(await readFile(scriptPath)) !== colorBytesSha(Buffer.from(WINDOWS_OCR_SCRIPT_V1))) throw Error("OCR_INPUT_OR_PROVIDER_CHANGED");
    const result = windowsOcrResponseV1Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(actual.stdout)));
    if (result.width !== request.width || result.height !== request.height || result.language.toLowerCase() !== request.language.toLowerCase()
      || !result.runtime.languages.some(tag => tag.toLowerCase() === request.language.toLowerCase())) throw Error("OCR_RESULT_BINDING");
    const receipt: WindowsOcrReceiptV1 = { schema: "editkin.windows-ocr-receipt/v1", receiptSha256: "", imageSha256: request.imageSha256,
      provider: { scriptSha256: colorBytesSha(Buffer.from(WINDOWS_OCR_SCRIPT_V1)), executableSha256, engine: "Windows.Media.Ocr",
        resources: "existing-installed-os-language-components", modelBinarySha256Verified: false }, result,
      authority: "text-regions-in-this-image-only", calibratedConfidenceAvailable: false };
    receipt.receiptSha256 = colorDigest({ ...receipt, receiptSha256: undefined });
    verifyWindowsOcrReceiptV1(receipt); return receipt;
  } finally {
    // Only these two freshly created names; no recursive deletion or discovery.
    if (resolve(await realpath(directory)) !== resolve(directory)) throw Error("OCR_CLEANUP_BOUNDARY");
    for (const path of [imagePath, scriptPath]) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}
