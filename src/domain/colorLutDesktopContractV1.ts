import * as z from "zod/v4";
import { COLOR_LUT_ID } from "./colorGradeV2Schema";
export const COLOR_LUT_DESKTOP_MANIFEST_BYTES_V1 = 8 * 1024 * 1024;
export const colorLutDesktopSpaceV1Schema = z.enum(["rec709_display", "acescct"]);
const text = () => z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f]+$/);
const sha = () => z.string().regex(/^[a-f0-9]{64}$/);
const rights = { name: text(), license: text(), provenance: text(), rightsBasis: text(), inputSpace: colorLutDesktopSpaceV1Schema };
export const colorLutDesktopEntryV1Schema = z.strictObject({
  id: z.string().regex(COLOR_LUT_ID), sha256: sha(), ...rights,
  kind: z.enum(["1d", "3d"]), size: z.number().int().min(2).max(65536), bytes: z.number().int().positive().max(64 * 1024 * 1024),
  path: z.string(), title: z.string().optional(), importedAt: z.string(),
}).refine(e => e.id === `lut:${e.sha256.slice(0, 16)}` && e.path === `luts/${e.sha256}.cube` && (e.kind !== "3d" || e.size <= 129), "LUT metadata 與內容身分不符");
export const colorLutDesktopRequestV1Schema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list"), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) }),
  z.strictObject({ operation: z.literal("import"), sourcePath: z.string().min(1).max(4096), ...rights }),
  z.strictObject({ operation: z.literal("resolve"), id: z.string().regex(COLOR_LUT_ID), sha256: sha(), inputSpace: colorLutDesktopSpaceV1Schema })
    .refine(r => r.id === `lut:${r.sha256.slice(0, 16)}`, "LUT id 與 SHA-256 不符"),
]);
export type ColorLutDesktopRequestV1 = z.infer<typeof colorLutDesktopRequestV1Schema>;
export type ColorLutDesktopEntryV1 = z.infer<typeof colorLutDesktopEntryV1Schema>;
