import { resolve } from "node:path";
import { readBundledFontFace } from "../render/bundledFontSource";
import { preparePhysicalFace } from "../typography/preparedGlyphRun";
import type { ReferenceMotionTemplatePreparationDependencies } from "../application/referenceMotionTemplates";

/** The provider keeps up to six verified, parsed faces (a design theme sets type in at most five) for one preparation
 * and closes its cache even after a late read. Each face is digested against the catalog and parsed once. */
export async function withReferenceMotionPhysicalFonts<T>(
  operation: (dependencies: ReferenceMotionTemplatePreparationDependencies) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  const faces = new Map<string, Promise<(text: string) => import("../typography/preparedGlyphRun").PreparedGlyphRun>>();
  let closed = false;
  const fontRoot = environment.EDITKIN_FONT_ROOT ?? resolve(import.meta.dirname, "../../public/fonts");
  try {
    return await operation({ signal, prepareText: async (faceId, text) => {
      if (closed || signal?.aborted) throw new Error("Reference physical font provider is closed or cancelled");
      let face = faces.get(faceId);
      if (!face) {
        face = readBundledFontFace(fontRoot, faceId).then(bytes => {
          if (closed || signal?.aborted) throw new Error("Reference physical font read completed after cancellation");
          return preparePhysicalFace(faceId, bytes);
        });
        if (faces.size >= 6) faces.delete(faces.keys().next().value!);
        faces.set(faceId, face);
        face.catch(() => faces.delete(faceId));
      }
      const run = (await face)(text);
      if (closed || signal?.aborted) throw new Error("Reference physical glyph preparation completed after cancellation");
      return run;
    } });
  } finally { closed = true; faces.clear(); }
}
