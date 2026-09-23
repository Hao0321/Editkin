/** Explicit user intent; never inferred from geometry, duration or topic. */
export type NativeEditingPolicy = Readonly<{
  format: "longform" | "shorts" | "unknown";
  /** Manual preserves subtitle styling and surviving original outer transitions. */
  ownership: "automatic" | "manual";
}>;
export const conservativePolicy: NativeEditingPolicy = Object.freeze({ format: "unknown", ownership: "automatic" });
export function validatePolicy(policy: NativeEditingPolicy): NativeEditingPolicy {
  if (!["longform", "shorts", "unknown"].includes(policy?.format)
    || !["automatic", "manual"].includes(policy?.ownership)) {
    throw new Error("請明確選擇剪輯片型與字幕／轉場樣式處理方式。");
  }
  return Object.freeze({ format: policy.format, ownership: policy.ownership });
}
