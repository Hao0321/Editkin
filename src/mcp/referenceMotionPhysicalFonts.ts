import { resolve } from "node:path";
import { readBundledFontFace } from "../render/bundledFontSource";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import type { ReferenceMotionTemplatePreparationDependencies } from "../application/referenceMotionTemplates";

/** The provider keeps two verified faces and closes its cache even after a late read. */
export async function withReferenceMotionPhysicalFonts<T>(
  operation: (dependencies: ReferenceMotionTemplatePreparationDependencies) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  const bytes = new Map<string, Uint8Array>();
  let closed = false;
  const fontRoot = environment.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts");
  try {
    return await operation({ signal, prepareText: async (faceId, text) => {
      if (closed || signal?.aborted) throw new Error("Reference physical font provider is closed or cancelled");
      let selected = bytes.get(faceId);
      if (!selected) {
        selected = await readBundledFontFace(fontRoot, faceId);
        if (closed || signal?.aborted) throw new Error("Reference physical font read completed after cancellation");
        if (bytes.size >= 2) bytes.delete(bytes.keys().next().value!);
        bytes.set(faceId, selected);
      }
      const run = await prepareGlyphRun(faceId, text, selected);
      if (closed || signal?.aborted) throw new Error("Reference physical glyph preparation completed after cancellation");
      return run;
    } });
  } finally { closed = true; bytes.clear(); }
}
