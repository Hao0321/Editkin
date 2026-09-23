const utf8Encoder = new TextEncoder();

/**
 * Locale-independent lexicographic order for canonical/security data.
 *
 * UTF-8 preserves ASCII byte order; explicit byte comparison makes the ordering
 * independent of the host's ICU build, default locale, and collation rules.
 */
export function compareUtf8Bytes(left: string, right: string): number {
  if (left === right) return 0;
  const a = utf8Encoder.encode(left);
  const b = utf8Encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
