/** Log2 RGB gain in explicitly decoded, straight linear-light Rec709. Not Kelvin or artistic tint. */
export interface LinearWhiteBalanceColor {
  whiteBalanceRed?: number;
  whiteBalanceGreen?: number;
  whiteBalanceBlue?: number;
}
/** Explicit camera Rec709 OETF convention, not BT1886 display EOTF; no range clipping. */
export function decodeRec709Oetf(value: number): number {
  if (!Number.isFinite(value)) throw Error("Nonfinite Rec709 sample");
  return value < .081 ? value / 4.5 : ((value + .099) / 1.099) ** (1 / .45);
}
export function encodeRec709Oetf(value: number): number {
  if (!Number.isFinite(value)) throw Error("Nonfinite linear Rec709 sample");
  return value < .018 ? value * 4.5 : 1.099 * value ** .45 - .099;
}
/** Input/output are normalized FLOAT RGB; caller owns the format and transfer tags. */
export function rec709OetfDecodeFilters(): string[] {
  const expr = (c: string) => `if(lt(${c}(X,Y),0.081),${c}(X,Y)/4.5,pow((${c}(X,Y)+0.099)/1.099,1/0.45))`;
  return [`geq=r='${expr("r")}':g='${expr("g")}':b='${expr("b")}':a='alpha(X,Y)':i=nearest`];
}
export function rec709OetfEncodeFilters(): string[] {
  const expr = (c: string) => `if(lt(${c}(X,Y),0.018),${c}(X,Y)*4.5,1.099*pow(${c}(X,Y),0.45)-0.099)`;
  return [`geq=r='${expr("r")}':g='${expr("g")}':b='${expr("b")}':a='alpha(X,Y)':i=nearest`];
}
export function getLinearWhiteBalanceStops(color: LinearWhiteBalanceColor): [number, number, number] {
  if (!color || typeof color !== "object") throw Error("Invalid linear white balance controls");
  const values = [color.whiteBalanceRed, color.whiteBalanceGreen, color.whiteBalanceBlue].map(value => value === undefined ? 0 : value);
  if (!values.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 4)) throw Error("Linear white balance stops must be finite and within [-4,4]");
  return values as [number, number, number];
}
export function hasLinearWhiteBalance(color: LinearWhiteBalanceColor): boolean {
  return getLinearWhiteBalanceStops(color).some(value => value !== 0);
}
/** Caller owns float format, transfer/gamut and straight-alpha normalization. Never quantize/clamp here. */
export function linearWhiteBalanceFilters(color: LinearWhiteBalanceColor): string[] {
  const stops = getLinearWhiteBalanceStops(color);
  if (stops.every(value => value === 0)) return [];
  const [red, green, blue] = stops.map(value => 2 ** value);
  return [`geq=r='r(X,Y)*${red}':g='g(X,Y)*${green}':b='b(X,Y)*${blue}':a='alpha(X,Y)':i=nearest`];
}
export interface LinearWhiteBalanceSolution {
  status: "candidate" | "unchanged" | "out-of-range";
  /** Absolute stops for a set command; never append these as another relative transform. */
  stops: [number, number, number];
  relativeStops: [number, number, number];
  targetLinearY: number;
}
/** meanRgb is explicitly measured AFTER baseline gain, BEFORE tone/look, in linear Rec709.
 * Caller must validate neutral-reference provenance, variance, clipping, temporal and luma limits.
 * An algebraic candidate is not an accepted or aesthetically certified correction.
 */
export function solveLinearWhiteBalanceStops(meanRgb: [number, number, number], baseline: LinearWhiteBalanceColor, maxStepStops: number): LinearWhiteBalanceSolution {
  const base = getLinearWhiteBalanceStops(baseline);
  if (!Array.isArray(meanRgb) || meanRgb.length !== 3 || !meanRgb.every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(maxStepStops) || maxStepStops <= 0 || maxStepStops > 4) throw Error("Invalid explicit linear neutral reference or step bound");
  const targetLinearY = meanRgb[0] * .2126 + meanRgb[1] * .7152 + meanRgb[2] * .0722;
  if (!Number.isFinite(targetLinearY) || targetLinearY <= 0) throw Error("Unrepresentable linear neutral reference");
  const relativeStops = meanRgb.map(value => Math.log2(targetLinearY) - Math.log2(value)) as [number, number, number];
  const stops = base.map((value, i) => value + relativeStops[i]) as [number, number, number];
  const outOfRange = relativeStops.some(value => !Number.isFinite(value) || Math.abs(value) > maxStepStops)
    || stops.some(value => !Number.isFinite(value) || Math.abs(value) > 4);
  return { status: outOfRange ? "out-of-range" : relativeStops.every(value => Math.abs(value) <= 1e-12) ? "unchanged" : "candidate",
    stops, relativeStops, targetLinearY };
}
