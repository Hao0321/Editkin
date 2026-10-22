import * as z from "zod/v4";

const dimension = z.number().int().min(1).max(1280);
const language = z.string().min(2).max(64).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const index = z.number().int().min(0).max(4095);
export const windowsOcrImageRequestV1Schema = z.strictObject({
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/), width: dimension, height: dimension, language,
});
export const windowsOcrResponseV1Schema = z.strictObject({
  engine: z.literal("Windows.Media.Ocr"), language, width: dimension, height: dimension,
  processing: z.strictObject({ scale: z.literal(2), recognitionWidth: z.number().int().min(2).max(2560),
    recognitionHeight: z.number().int().min(2).max(2560), interpolation: z.literal("cubic"),
    coordinates: z.literal("recognition-rectangles-divided-by-scale") }),
  textAngle: z.number().finite().min(-180).max(180).nullable(),
  runtime: z.strictObject({ powershellVersion: z.string().min(1).max(64), osVersion: z.string().min(1).max(128),
    maximumImageDimension: z.number().int().min(1).max(32768), languages: z.array(language).max(128) }),
  lines: z.array(z.strictObject({ index, text: z.string().min(1).max(8192),
    words: z.array(z.strictObject({ index, text: z.string().min(1).max(1024),
      x: z.number().finite().min(-2560).max(2560), y: z.number().finite().min(-2560).max(2560),
      width: z.number().finite().positive().max(1280), height: z.number().finite().positive().max(1280),
    })).min(1).max(4096),
  })).max(512),
}).superRefine((value, ctx) => {
  if (value.processing.recognitionWidth !== value.width * 2 || value.processing.recognitionHeight !== value.height * 2
    || value.lines.some((line, i) => line.index !== i || line.words.some((word, j) => word.index !== j))
    || value.lines.reduce((n, line) => n + line.words.length, 0) > 4096
    || value.lines.reduce((n, line) => n + line.text.length + line.words.reduce((s, word) => s + word.text.length, 0), 0) > 65536)
    ctx.addIssue({ code: "custom", message: "OCR observation budget or indexes invalid" });
});
export type WindowsOcrResponseV1 = z.infer<typeof windowsOcrResponseV1Schema>;
export interface WindowsOcrReceiptV1 {
  schema: "editkin.windows-ocr-receipt/v1"; receiptSha256: string; imageSha256: string;
  provider: { scriptSha256: string; executableSha256: string; engine: "Windows.Media.Ocr";
    resources: "existing-installed-os-language-components"; modelBinarySha256Verified: false };
  result: WindowsOcrResponseV1;
  authority: "text-regions-in-this-image-only"; calibratedConfidenceAvailable: false;
}
