import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { canonicalJson } from "../shared/canonicalJson";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const nativeVideoRuntimeMetadataSchema = z.strictObject({
  schema: z.literal("editkin.native-video-runtime-metadata/v1"),
  platform: z.literal("win32"),
  executableSha256: sha, executableBytes: bytes,
  videoInteropProtocol: z.literal("media-foundation-d3d11-d3d12-wgpu/v1"),
  nativeFloatingVideoFrameContract: z.literal("editkin.native-floating-frame-material/v1"),
  offscreenVideoProtocol: z.literal("editkin.resident-offscreen-video-target/v1"),
  displayPaintSchema: z.literal("editkin.native-motion-paint-track/v2"),
  videoTargetAdmission: z.strictObject({
    schema: z.literal("editkin.shared-video-target-admission/v1"),
    requiredBackend: z.literal("Dx12"), factory: z.literal("new_dx12_video"),
    selection: z.literal("deferred-until-target-bind"),
    offscreenProtocol: z.literal("editkin.resident-offscreen-video-target/v1"),
  }),
  actualTargetMeasured: z.literal(false), noNativeWindowCreated: z.literal(true),
});
export const selectedNativeVideoRuntimeIdentitySchema = z.strictObject({
  schema: z.literal("editkin.selected-native-video-runtime/v1"),
  executablePathSha256: sha, executableSha256: sha, executableBytes: bytes,
  metadataSha256: sha, metadata: nativeVideoRuntimeMetadataSchema,
  verification: z.literal("selected_binary_metadata_only"),
}).superRefine((identity, context) => {
  if (identity.executableSha256 !== identity.metadata.executableSha256 || identity.executableBytes !== identity.metadata.executableBytes
    || identity.metadataSha256 !== hash(canonicalJson(identity.metadata))) {
    context.addIssue({ code: "custom", message: "Selected native renderer metadata/bytes identity differs" });
  }
});
export type SelectedNativeVideoRuntimeIdentity = z.infer<typeof selectedNativeVideoRuntimeIdentitySchema>;
export interface SelectedNativeVideoRuntime { executablePath: string; identity: SelectedNativeVideoRuntimeIdentity }
type MetadataExecutor = (executablePath: string) => Promise<string>;
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

/** Full-byte streaming identity: bounded memory, one regular-file handle and
 * a path/read identity check. No source capability substitutes for exe bytes. */
async function executableIdentity(path: string): Promise<{ executableSha256: string; executableBytes: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Selected native renderer must be a regular executable file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size < 1 || opened.size > 2 * 1024 ** 3
      || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Selected native renderer file identity changed or exceeds its bound");
    const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!result.bytesRead) throw new Error("Selected native renderer changed during full-byte read");
      digest.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
    }
    const probe = await handle.read(buffer, 0, 1, offset), after = await handle.stat(), current = await lstat(path);
    if (probe.bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || after.dev !== opened.dev || after.ino !== opened.ino || !current.isFile() || current.isSymbolicLink()
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size) {
      throw new Error("Selected native renderer changed during full-byte read");
    }
    return { executableSha256: digest.digest("hex"), executableBytes: opened.size };
  } finally { await handle.close(); }
}
const executeFile = promisify(execFile);
const executeMetadata: MetadataExecutor = async executablePath => {
  const result = await executeFile(executablePath, ["video-runtime-identity"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  return result.stdout;
};

/** Metadata-only selected binary admission. It creates neither a video target
 * nor a native window and does not certify pixels, artwork or installation. */
export async function readSelectedNativeVideoRuntime(options: {
  executablePath?: string; executeMetadata?: MetadataExecutor;
} = {}): Promise<SelectedNativeVideoRuntime | undefined> {
  const configured = options.executablePath ?? process.env.EDITKIN_GPU_COMPOSITOR_PATH;
  if (configured === undefined) return undefined;
  if (!configured.trim() || !isAbsolute(configured)) throw new Error("EDITKIN_GPU_COMPOSITOR_PATH must be a nonempty absolute executable path");
  const executablePath = await realpath(configured);
  const before = await executableIdentity(executablePath);
  const text = await (options.executeMetadata ?? executeMetadata)(executablePath);
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Selected native renderer metadata exceeds 64 KiB");
  const metadata = nativeVideoRuntimeMetadataSchema.parse(JSON.parse(text));
  const after = await executableIdentity(executablePath);
  if (canonicalJson(before) !== canonicalJson(after) || metadata.executableSha256 !== before.executableSha256
    || metadata.executableBytes !== before.executableBytes || await realpath(configured) !== executablePath) {
    throw new Error("Selected native renderer executable/metadata drifted during identity read");
  }
  const normalized = process.platform === "win32" ? executablePath.toLowerCase() : executablePath;
  return { executablePath, identity: selectedNativeVideoRuntimeIdentitySchema.parse({
    schema: "editkin.selected-native-video-runtime/v1", executablePathSha256: hash(normalized), ...before,
    metadataSha256: hash(canonicalJson(metadata)), metadata, verification: "selected_binary_metadata_only",
  }) };
}

export async function assertSelectedNativeVideoRuntimeCurrent(expected: SelectedNativeVideoRuntimeIdentity | undefined): Promise<SelectedNativeVideoRuntime | undefined> {
  const current = await readSelectedNativeVideoRuntime();
  if ((current === undefined) !== (expected === undefined)
    || (current && canonicalJson(current.identity) !== canonicalJson(selectedNativeVideoRuntimeIdentitySchema.parse(expected)))) {
    throw new Error("Selected native renderer identity drifted from the current invocation");
  }
  return current;
}
