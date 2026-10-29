import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { parseLongformWordWindowV1 } from "./longformWordTimingV1";
import { readLongformCaptionSourceTextV1 } from "./longformCaptionSourceTextRuntimeV1";
const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) { const path = relative(tmpdir(), root);
  if (!path || path.startsWith("..") || isAbsolute(path)) throw Error("OWNED_TEST_ROOT"); await rm(root, { recursive: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "caption-source-text-")); owned.push(root);
  const raw = JSON.stringify({ transcription: [{ text: "Hello, world!", offsets: { from: 0, to: 1000 },
    tokens: [{ text: "Hello, world!", id: 1, p: 0.9, offsets: { from: 100, to: 900 } }] }] });
  const parsed = parseLongformWordWindowV1(raw, { index: 0, start: 0, coreStart: 0, coreEnd: 1, duration: 1 }, 1, "en");
  const index = { schema: "editkin.longform-word-cache-window/v1" as const, key: "a".repeat(64),
    rawFile: `${"a".repeat(64)}-${randomUUID()}.raw.json`, parsedFile: "parsed.json", rawSha256: parsed.rawJsonSha256,
    parsedSha256: "b".repeat(64), wordCount: parsed.words.length, issueCount: parsed.issues.length, segmentCount: 1 };
  await writeFile(join(root, index.rawFile), raw, { flag: "wx" });
  return { root, raw, current: { index, parsed } };
}
it("reads actual bounded raw bytes with the validated cache identity before projecting separators", async () => {
  const f = await fixture(), before = structuredClone(f.current);
  const projected = await readLongformCaptionSourceTextV1(f.root, f.current);
  expect(projected.words.map(word => word.text).join("")).toBe("Hello, world!"); expect(f.current).toEqual(before);
});
it("refuses changed raw cache bytes, path escapes and cancellation", async () => {
  const f = await fixture(); await writeFile(join(f.root, f.current.index.rawFile), f.raw + " ");
  await expect(readLongformCaptionSourceTextV1(f.root, f.current)).rejects.toThrow("CACHE_SHA");
  const escaped = structuredClone(f.current); escaped.index.rawFile = "../outside.raw.json";
  await expect(readLongformCaptionSourceTextV1(f.root, escaped)).rejects.toThrow("CACHE_IDENTITY");
  const controller = new AbortController(); controller.abort();
  await expect(readLongformCaptionSourceTextV1(f.root, f.current, controller.signal)).rejects.toThrow();
});
