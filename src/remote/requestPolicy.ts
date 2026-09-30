import { isIP } from "node:net";

export type ByteRange = { start: number; end: number; partial: boolean };

/**
 * Resolves a single-range `Range` header against a file size. Returns `undefined`
 * when the range cannot be satisfied (416). A missing or malformed header is
 * ignored, as RFC 9110 requires, and yields the whole file.
 */
export function resolveByteRange(header: string | undefined, size: number): ByteRange | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return { start: 0, end: size - 1, partial: false };
  const [, first, last] = match;
  let start: number;
  let end: number;
  if (!first) {
    // `bytes=-N` is the last N bytes, not "bytes 0 through N".
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last ? Math.min(Number(last), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return undefined;
  return { start, end, partial: true };
}

/**
 * Accepts a `Host` header whose name is an IP literal, `localhost`, or one of the
 * advertised names. A DNS-rebinding page reaches the server under an attacker
 * name, which is none of those.
 */
export function hostAllowed(header: string | undefined, allowedHosts: readonly string[]): boolean {
  if (!header) return false;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(header);
  if (!match) return false;
  const hostname = match[1].toLowerCase();
  if (hostname.startsWith("[")) return isIP(hostname.slice(1, -1)) === 6;
  return isIP(hostname) === 4 || hostname === "localhost" || allowedHosts.includes(hostname);
}
