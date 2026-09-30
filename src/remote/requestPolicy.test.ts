import { describe, expect, it } from "vitest";
import { hostAllowed, resolveByteRange } from "./requestPolicy";

describe("resolveByteRange", () => {
  it("serves the whole file without a usable Range header", () => {
    expect(resolveByteRange(undefined, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(resolveByteRange("items=0-1", 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(resolveByteRange("bytes=-", 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(resolveByteRange(undefined, 0)).toEqual({ start: 0, end: -1, partial: false });
  });

  it("returns the last N bytes for a suffix range", () => {
    expect(resolveByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(resolveByteRange("bytes=-1", 100)).toEqual({ start: 99, end: 99, partial: true });
    expect(resolveByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99, partial: true });
    expect(resolveByteRange("bytes=-0", 100)).toBeUndefined();
    expect(resolveByteRange("bytes=-5", 0)).toBeUndefined();
  });

  it("handles explicit and open-ended ranges and rejects unsatisfiable ones", () => {
    expect(resolveByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19, partial: true });
    expect(resolveByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(resolveByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99, partial: true });
    expect(resolveByteRange("bytes=100-", 100)).toBeUndefined();
    expect(resolveByteRange("bytes=20-10", 100)).toBeUndefined();
  });
});

describe("hostAllowed", () => {
  const allowed = ["editkin.example.com"];

  it("accepts IP literals, localhost and advertised names, with or without a port", () => {
    for (const host of ["192.168.1.20:12690", "127.0.0.1", "localhost:12690", "[::1]:12690", "editkin.example.com", "EDITKIN.example.com:443"]) {
      expect(hostAllowed(host, allowed), host).toBe(true);
    }
  });

  it("rejects an attacker name that a DNS-rebinding page would use, and malformed values", () => {
    for (const host of [undefined, "", "attacker.example:12690", "editkin.example.com.attacker.example", "a b", "evil.example/x", "user@editkin.example.com", "999.1.1.1x", "[zzz]"]) {
      expect(hostAllowed(host, allowed), String(host)).toBe(false);
    }
    expect(hostAllowed("editkin.example.com", [])).toBe(false);
  });
});
