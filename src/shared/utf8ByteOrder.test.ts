import { describe, expect, it } from "vitest";
import { compareUtf8Bytes } from "./utf8ByteOrder";
import { Buffer } from "node:buffer";

describe("canonical UTF-8 byte order", () => {
  it("exactly matches the former Node oracle including malformed surrogate replacement", () => {
    const values = ["", "a", "aa", "\0", "\u007f", "\u0080", "\u07ff", "\u0800", "中", "😀", "\ud800", "\udfff", "\ufffd", "\ud800x", "e\u0301", "é"];
    for (const left of values) for (const right of values) {
      expect(compareUtf8Bytes(left, right)).toBe(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    }
  });
  it("uses exact unsigned UTF-8/ASCII byte order", () => {
    const values = ["中", "z", "ä", "A", "_", "0", ".", "-", "😀", "Ä", "a"];
    expect([...values].sort(compareUtf8Bytes)).toEqual([
      "-", ".", "0", "A", "_", "a", "z", "Ä", "ä", "中", "😀",
    ]);
  });

  it("returns the same canonical order regardless of the locale being exercised", () => {
    const values = ["z", "ä", "a-", "a.", "A", "中", "😀"];
    const expected = ["A", "a-", "a.", "z", "ä", "中", "😀"];
    const locales = ["en-US", "sv-SE", "zh-Hant-TW"];
    const localeOrders = locales.map((locale) => [...values].sort(new Intl.Collator(locale).compare));
    expect(new Set(localeOrders.map((order) => JSON.stringify(order))).size).toBeGreaterThan(1);
    for (const locale of locales) {
      expect(new Intl.Collator(locale).resolvedOptions().locale).toBeTruthy();
      expect([...values].sort(compareUtf8Bytes)).toEqual(expected);
    }
  });
});
