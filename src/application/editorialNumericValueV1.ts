import * as z from "zod/v4";

/** Canonical nonnegative decimal input, not locale-dependent number parsing. */
export const editorialDecimalV1Schema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u);
export const editorialEvidenceRefsV1Schema = z.array(z.string().trim().min(1).max(160)).min(1).max(8);
export const editorialUnitV1Schema = z.strictObject({
  prefix: z.string().max(8).regex(/^[^\d\r\n\t{}\\]*$/u),
  suffix: z.string().max(8).regex(/^[^\d\r\n\t{}\\]*$/u), groupThousands: z.boolean(),
});
function decimal(value: string) {
  editorialDecimalV1Schema.parse(value);
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
export function compareEditorialDecimalsV1(left: string, right: string): -1 | 0 | 1 {
  const a = decimal(left), b = decimal(right), scale = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(scale - a.scale), y = b.units * 10n ** BigInt(scale - b.scale);
  return x === y ? 0 : x < y ? -1 : 1;
}
/** The frozen number renderer uses Number/toFixed. Refuse inputs it cannot reproduce exactly. */
export function formatEditorialValueV1(value: string, unit: z.infer<typeof editorialUnitV1Schema>): string {
  const parsed = decimal(value), resolved = editorialUnitV1Schema.parse(unit);
  if (Number(value).toFixed(parsed.scale) !== value) throw Error("EDITORIAL_VALUE_RENDERER_PRECISION");
  const [whole, fraction] = value.split(".");
  const label = resolved.prefix + (resolved.groupThousands ? whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",") : whole)
    + (fraction === undefined ? "" : "." + fraction) + resolved.suffix;
  if (!label.trim() || label.trim() !== label || label.length > 24) throw Error("EDITORIAL_VALUE_LABEL_BUDGET");
  return label;
}
/** Explicit half-up decimal display. Ratios remain integer data, even above 2^53. */
export function editorialPercentageV1(completed: string, total: string, decimals: number): string {
  const integer = /^(?:0|[1-9]\d{0,17})$/u;
  if (!integer.test(completed) || !integer.test(total) || !Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw Error("EDITORIAL_PROGRESS_INTEGER_REQUIRED");
  const done = BigInt(completed), denominator = BigInt(total);
  if (denominator === 0n || done > denominator) throw Error("EDITORIAL_PROGRESS_RANGE");
  const scale = 10n ** BigInt(decimals), numerator = done * 100n * scale;
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  const digits = rounded.toString().padStart(decimals + 1, "0");
  return (decimals ? digits.slice(0, -decimals) + "." + digits.slice(-decimals) : digits) + "%";
}
