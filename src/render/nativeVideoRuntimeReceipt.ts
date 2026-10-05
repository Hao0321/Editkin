// Node-only formal renderer boundary. Desktop/browser material receipts must
// not import selected executable IO, child_process or Node crypto.
import { nativeVideoRuntimeMetadataSchema, selectedNativeVideoRuntimeIdentitySchema,
  type SelectedNativeVideoRuntimeIdentity } from "../application/selectedNativeVideoRuntime";
import { canonicalJson } from "../shared/canonicalJson";
import { assertNativeVideoTargetIdentity } from "./nativeFloatingVideoFrameReceipt";

function exact(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Native floating receipt mismatch: ${label}`);
}
export function assertBoundNativeVideoTargetIdentity(input: unknown, generation: unknown, requireBound = false,
  offscreenSize?: { width: number; height: number }, selectedRuntime?: SelectedNativeVideoRuntimeIdentity): Record<string, unknown> {
  const identity = assertNativeVideoTargetIdentity(input, generation, requireBound, offscreenSize);
  if (selectedRuntime) {
    const selected = selectedNativeVideoRuntimeIdentitySchema.parse(selectedRuntime);
    exact(identity.executableSha256, selected.executableSha256, "actual worker executable SHA");
    exact(identity.executableBytes, selected.executableBytes, "actual worker executable bytes");
  }
  return identity;
}
export function assertNativeVideoWorkerRuntime(ready: unknown, selectedRuntime: SelectedNativeVideoRuntimeIdentity): void {
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) throw new Error("Native floating receipt mismatch: actual worker ready");
  const selected = selectedNativeVideoRuntimeIdentitySchema.parse(selectedRuntime);
  const metadata = nativeVideoRuntimeMetadataSchema.parse((ready as Record<string, unknown>).nativeRuntimeMetadata);
  exact(metadata, selected.metadata, "actual serving worker metadata");
}
