import type { ColorLutDesktopEntryV1 } from "../domain/colorLutDesktopContractV1";
import type { ColorGradeLutRefV2 } from "../domain/types";
export interface ColorLutPickedV1 { selectionId: string; suggestedName: string }
export interface ColorLutImportV1 { selectionId: string; name: string; license: string; provenance: string; rightsBasis: string; inputSpace: "rec709_display" | "acescct" }
export interface ColorLutApiV1 {
  listColorLutsV1: (offset?: number, limit?: number) => Promise<{ entries: ColorLutDesktopEntryV1[]; total: number; nextOffset?: number }>;
  pickColorLutV1: () => Promise<ColorLutPickedV1 | null>;
  importColorLutV1: (request: ColorLutImportV1) => Promise<{ entry: ColorLutDesktopEntryV1; nodeReference: ColorGradeLutRefV2 }>;
  readColorLutV1: (ref: Pick<ColorGradeLutRefV2, "id" | "sha256">, inputSpace: "rec709_display" | "acescct") => Promise<string>;
}
/** A binary read preserves UTF-8 BOM so the existing preview SHA checks the original file bytes. */
export function decodeColorLutBytesV1(value: ArrayBuffer | number[]) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error("LUT 內容超過 64 MiB 上限。");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
