import type { MotionLibraryFrameRequestV1 } from "./motionLibraryFramesV1";

/** Messages between the editor and the thumbnail worker (kept dependency-free so both sides import it cheaply). */
export type MotionLibraryThumbnailWorkerInV1 =
  | { readonly type: "frame"; readonly id: number; readonly request: MotionLibraryFrameRequestV1 }
  | { readonly type: "font"; readonly faceId: string; readonly bytes?: ArrayBuffer; readonly error?: string };

export type MotionLibraryThumbnailWorkerOutV1 =
  | { readonly type: "frame"; readonly id: number; readonly url: string; readonly ms: number }
  | { readonly type: "error"; readonly id: number; readonly message: string; readonly font?: boolean }
  | { readonly type: "need-font"; readonly faceId: string };

/** The face a generator could not find in this runtime (glyphs.ts: "…font <faceId> is not registered in this runtime…"). */
export function missingMotionLibraryFaceV1(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /font (EditkinFace-[A-Za-z0-9-]+) is not registered/.exec(message)?.[1];
}

/**
 * A self-contained image URL for one frame. A data URL (not a blob URL) so a card scrolled away and back, or an image
 * the browser re-decodes later, never points at a revoked object.
 */
export function motionLibrarySvgDataUrlV1(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
