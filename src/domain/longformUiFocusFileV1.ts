import * as z from "zod/v4";
import { longformUiFocusRequestV1Schema } from "./longformUiFocusV1";
import type { LongformUiFocusDraftV1 } from "./longformUiFocusV1";

export const longformUiFocusFileRequestV1Schema = z.strictObject({
  projectPath: z.string().min(1).max(4096), expectedRevision: z.number().int().nonnegative(),
  clipId: z.string().min(1).max(160), language: longformUiFocusRequestV1Schema.shape.language,
  frameTimes: longformUiFocusRequestV1Schema.shape.frameTimes,
  targetTexts: longformUiFocusRequestV1Schema.shape.targetTexts,
}).superRefine((value, ctx) => {
  if (value.frameTimes.some((time, index) => index > 0 && time <= value.frameTimes[index - 1])
    || new Set(value.targetTexts.map(text => text.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US"))).size !== value.targetTexts.length)
    ctx.addIssue({ code: "custom", message: "Duplicate targets or unordered frame times" });
});
export type LongformUiFocusFileRequestV1 = z.infer<typeof longformUiFocusFileRequestV1Schema>;
export interface LongformUiFocusArtifactV1 {
  schema: "editkin.longform-ui-focus-artifact/v1"; artifactId: string; algorithmSha256: string;
  request: LongformUiFocusFileRequestV1;
  project: { id: string; revision: number; canonicalSha256: string; clipId: string; assetId: string };
  sourcePath: string; draft: LongformUiFocusDraftV1;
}
export interface LongformUiFocusJobResultV1 {
  artifactId: string; draftId: string; state: "REVIEW_REQUIRED"; frameCount: number; candidateCount: number;
  omittedFrameCount: number; projectRevision: number; projectModified: false; focusHintsReady: false;
}
