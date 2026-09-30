import { isIP } from "node:net";
import { SECRET_BEARING_URL_HINT_PATTERN } from "./constants";

export function safeEvidenceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname);
    assertPublicHostname(parsed.hostname);
    const literalAddress = parsed.hostname.replace(/^\[|\]$/g, "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.hostname.length > 0
      && !SECRET_BEARING_URL_HINT_PATTERN.test(decodedPath)
      && !(isIP(literalAddress) && reservedLiteralEvidenceAddress(literalAddress));
  } catch { return false; }
}

function assertPublicHostname(hostname: string): void {
  const host = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host === "metadata.google.internal" || host === "169.254.169.254") {
    throw new Error("Remote origin 不可指向本機、區域網路或雲端 metadata 端點");
  }
}

export function privateAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return privateAddress(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      return privateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    return true;
  }
  if (normalized.includes(":")) {
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function reservedLiteralEvidenceAddress(address: string): boolean {
  if (privateAddress(address)) return true;
  const normalized = address.toLocaleLowerCase();
  if (normalized.includes(":")) {
    return normalized.startsWith("2001:db8:") || normalized === "2001:db8::";
  }
  const [a, b, c] = normalized.split(".").map(Number);
  return (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function validateRemoteOrigin(input: string): string {
  if (input.length > 2_048 || input !== input.trim() || input.includes("\\") || /\s/.test(input)) {
    throw new Error("Remote origin 必須是單純、無空白的 HTTPS origin");
  }
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error("Remote origin 不是有效 URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Remote origin 只能包含 HTTPS scheme、公開 hostname 與選用 port；不得含路徑、帳密、query 或 fragment");
  }
  assertPublicHostname(parsed.hostname);
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && privateAddress(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("Remote origin 不可指向本機或私人 IP");
  }
  return parsed.origin;
}
