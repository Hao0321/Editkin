import { cssFontFamily, resolveBundledFontFace, type ResolvedFontFace } from "./fontFaces";

export interface MotionFontSelection {
  readonly selectionKey: string;
  readonly family: string;
  readonly weight: number;
  readonly text: string;
  readonly face?: ResolvedFontFace;
  readonly invalidReason?: string;
}

export type MotionFontStatus = "pending" | "ready" | "blocked" | "unverified" | "cancelled" | "unobserved" | "not-required";
export interface MotionFontReadiness {
  readonly selectionKey: string;
  readonly status: MotionFontStatus;
  readonly reason?: string;
  readonly face?: ResolvedFontFace;
}

/** Structural browser API boundary; unit adapters cannot prove actual browser loading. */
export interface MotionFontFaceSet {
  load(font: string, text?: string): Promise<readonly { family: string; weight: string; status: string }[]>;
  check(font: string, text?: string): boolean;
  readonly ready: PromiseLike<unknown>;
}

export const MOTION_FONT_TIMEOUT_MS = 5000;
export function motionFontSelection(input: { family: string; weight: number; text: string }): MotionFontSelection {
  let face: ResolvedFontFace | undefined, invalidReason: string | undefined;
  try { face = resolveBundledFontFace(input.family, input.weight); }
  catch (error) { invalidReason = error instanceof Error ? error.message : String(error); }
  return { ...input, face, invalidReason, selectionKey: JSON.stringify([input.family, input.weight, input.text, face?.faceId, face?.fontFile]) };
}

function result(selection: MotionFontSelection, status: MotionFontStatus, reason?: string): MotionFontReadiness {
  return { selectionKey: selection.selectionKey, status, face: selection.face, ...(reason ? { reason } : {}) };
}

/** A receipt for another face or text must never authorize this render. */
export function currentMotionFontReadiness(selection: MotionFontSelection, observed: MotionFontReadiness | undefined, browserRender: boolean): MotionFontReadiness {
  if (!selection.text.trim()) return result(selection, "not-required");
  if (selection.invalidReason) return result(selection, "blocked", selection.invalidReason);
  if (!selection.face) return result(selection, "unverified", `字型 ${selection.family} 不在已驗證的 bundled face 目錄`);
  if (!browserRender) return result(selection, "unobserved", "SSR 靜態排版未觀察瀏覽器字型載入");
  if (observed?.selectionKey === selection.selectionKey && observed.status !== "cancelled") return observed;
  return result(selection, "pending", "正在載入所選字型");
}

function matchesFace(loaded: { family: string; weight: string; status: string }, face: ResolvedFontFace): boolean {
  const family = loaded.family;
  const exactFamily = family === face.fontFamily || family === cssFontFamily(face.fontFamily) || family === `'${face.fontFamily}'`;
  const exactWeight = loaded.weight === String(face.fontWeight) || (loaded.weight === "normal" && face.fontWeight === 400);
  return exactFamily && exactWeight && loaded.status === "loaded";
}

/** Exact alias/weight load contract only; this does not certify glyph shaping or pixels. */
export async function loadMotionFontReadiness(selection: MotionFontSelection, options: {
  fontSet?: MotionFontFaceSet | null;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<MotionFontReadiness> {
  const initial = currentMotionFontReadiness(selection, undefined, true);
  if (initial.status !== "pending") return initial;
  if (options.signal?.aborted) return result(selection, "cancelled", "字型選擇已變更");
  const timeoutMs = options.timeoutMs ?? MOTION_FONT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return result(selection, "blocked", "字型載入期限不合法");
  const face = selection.face!, font = `${face.fontWeight} 16px ${cssFontFamily(face.fontFamily)}`;
  let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
  try {
    const fontSet = options.fontSet;
    if (!fontSet || typeof fontSet.load !== "function" || typeof fontSet.check !== "function") return result(selection, "blocked", "瀏覽器未提供字型載入 API");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("字型載入逾時")), timeoutMs);
      cancel = () => reject(new Error("字型選擇已變更"));
      options.signal?.addEventListener("abort", cancel, { once: true });
    });
    const loaded = (async () => {
      const faces = await fontSet.load(font, selection.text);
      if (!Array.isArray(faces) || faces.length === 0 || !faces.every(item => matchesFace(item, face))) throw new Error("所選實體字型未成功載入：alias、字重或狀態不符");
      const ready = fontSet.ready;
      if (!ready || typeof ready.then !== "function") throw new Error("瀏覽器未提供 fonts.ready");
      await ready;
      if (!faces.every(item => matchesFace(item, face)) || !fontSet.check(font, selection.text)) throw new Error("所選實體字型未通過載入後檢查");
    })();
    await Promise.race([loaded, deadline]);
    if (options.signal?.aborted) return result(selection, "cancelled", "字型選擇已變更");
    return result(selection, "ready");
  } catch (error) {
    return result(selection, options.signal?.aborted ? "cancelled" : "blocked", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
  }
}
