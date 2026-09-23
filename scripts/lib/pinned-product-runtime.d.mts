export interface PinnedRuntimeEntry {
  path: string;
  expectedBytes: number;
  expectedSha256: string;
  actualBytes: number;
  actualSha256: string;
}
export function evaluatePinnedProductRuntime(entries: PinnedRuntimeEntry[]): {
  status: "BLOCK" | "GREEN_PINNED_PRODUCT_RUNTIME";
  failures: string[];
};
export function inspectPinnedWindowsProductRuntime(root?: string): Promise<{
  status: "BLOCK" | "GREEN_PINNED_PRODUCT_RUNTIME";
  failures: string[];
  entries: PinnedRuntimeEntry[];
}>;
export function assertPinnedWindowsProductRuntime(root?: string): ReturnType<typeof inspectPinnedWindowsProductRuntime>;
