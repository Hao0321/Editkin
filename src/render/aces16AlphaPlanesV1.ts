/** Internal graph labels; media input selectors are bound by the caller. */
function label(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw Error("Invalid internal16-bit alpha plane label");
  return value;
}

/** Copy the existing16-bit G/B/R planes and the independent gray16 alpha plane.
 * Keep the photographic input at GBRAP16: stripping its old alpha first causes
 * a lossy implicit scaler conversion in the bundled runtime. */
export function aces16AlphaPlaneJoinV1(photographic: string, alpha: string, output: string): string {
  return `[${label(photographic)}][${label(alpha)}]mergeplanes=format=gbrap16le:map0s=0:map0p=0:map1s=0:map1p=1:map2s=0:map2p=2:map3s=1:map3p=0[${label(output)}]`;
}

/** Full-range coverage multiplication; an opaque65535 matte is exact identity. */
export function aces16AlphaMultiplyV1(target: string, matte: string, output: string): string {
  return `[${label(target)}][${label(matte)}]blend=all_expr='A*B/65535'[${label(output)}]`;
}
