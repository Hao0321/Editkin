import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeProjectBytes, encodeProjectBytes } from "../../application/projectCodec";
import { buildRenderPlan } from "../../render/planner";
import { canonicalJson } from "../../shared/canonicalJson";

/**
 * Saved-project identity for the additive `TimelineClip.styleJob` field (editable style templates).
 *
 * Opt-in (not part of the default run): EDITKIN_STYLE_CORPUS_LIST names a file with one `.editkin.json` path per line
 * (the 125 saved projects under videos/). For every project the suite decodes the saved bytes (migrate → schema →
 * validate), re-encodes them, and builds the export render plan with identity asset paths; each stage is hashed, or its
 * first error line recorded. EDITKIN_STYLE_CORPUS_RECORD=<file> writes the digests (run before the field existed);
 * EDITKIN_STYLE_CORPUS_BASELINE=<file> asserts every digest is unchanged. A project without `styleJob` must decode,
 * save and plan byte-identically whether or not the field exists in the schema.
 */
const list = process.env.EDITKIN_STYLE_CORPUS_LIST;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const firstLine = (error: unknown) => `error: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200)}`;

describe.skipIf(!list)("saved projects: decode / encode / render plan identity (opt-in)", () => {
  it("records or matches every saved project's digests", async () => {
    const files = (await readFile(list!, "utf8")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const values: Record<string, { decoded: string; encoded: string; plan: string; styleJobClips: number }> = {};
    for (const file of files) {
      const bytes = await readFile(file);
      let decoded = "", encoded = "", plan = "", styleJobClips = 0;
      try {
        const project = decodeProjectBytes(bytes);
        decoded = sha(canonicalJson(project));
        styleJobClips = [project, ...project.compositions].flatMap(container => container.tracks.flatMap(track => track.clips))
          .filter(clip => (clip as { styleJob?: unknown }).styleJob !== undefined).length;
        try { encoded = sha(encodeProjectBytes(project)); } catch (error) { encoded = firstLine(error); }
        try { plan = sha(canonicalJson(buildRenderPlan(decodeProjectBytes(bytes), uri => uri))); } catch (error) { plan = firstLine(error); }
      } catch (error) {
        decoded = firstLine(error);
      }
      values[file] = { decoded, encoded, plan, styleJobClips };
    }
    if (process.env.EDITKIN_STYLE_CORPUS_RECORD) {
      await writeFile(process.env.EDITKIN_STYLE_CORPUS_RECORD, `${JSON.stringify({ schema: "editkin.style-template-corpus-identity/v1", count: files.length, values }, null, 2)}\n`, "utf8");
    }
    if (process.env.EDITKIN_STYLE_CORPUS_BASELINE) {
      const baseline = JSON.parse(await readFile(process.env.EDITKIN_STYLE_CORPUS_BASELINE, "utf8")) as { values: typeof values };
      const differences = Object.keys({ ...baseline.values, ...values })
        .filter(key => JSON.stringify(baseline.values[key]) !== JSON.stringify(values[key]));
      expect(differences).toEqual([]);
    }
    // No saved project carries the new field: it is purely additive.
    expect(Object.values(values).every(value => value.styleJobClips === 0)).toBe(true);
    expect(Object.values(values).filter(value => /^[0-9a-f]{64}$/.test(value.decoded)).length).toBeGreaterThan(0);
  }, 900_000);
});
