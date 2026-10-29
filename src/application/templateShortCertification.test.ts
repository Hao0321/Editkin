import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TEMPLATE_SHORT_CERTIFICATIONS, drawSpotCheck, findTemplateShortCertification } from "../motion/templateFamilyCertification";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { TEMPLATE_SHORT_FIXTURE_COPY, compileTemplateShortFixture } from "./templateShortFixtures";

// M1 wave 3 step 3.2 (design §7). A certification is Claude's art review of one family × theme, bound to the exact compile of
// its fixture: any change to the template code, fonts, motion or layout changes that compile and fails this test until
// the family is re-reviewed and re-certified (the run then falls back to REVIEW_REQUIRED for that pair).
describe("template family certification drift", () => {
  it.each(TEMPLATE_SHORT_CERTIFICATIONS.map(row => [`${row.family} × ${row.designSystem}`, row] as const))("%s still compiles to the certified fixture", async (_name, row) => {
    const { packet } = await compileTemplateShortFixture(row.family as keyof typeof TEMPLATE_SHORT_FIXTURE_COPY, row.designSystem);
    expect(sha256Canonical(packet.commands)).toBe(row.fixtureCompileSha256);
    expect(findTemplateShortCertification(row.family, row.designSystem)).toBe(row);
  }, 120_000);

  it("certifies only Claude-reviewed pairs with evidence, and ships frozen", () => {
    expect(Object.isFrozen(TEMPLATE_SHORT_CERTIFICATIONS)).toBe(true);
    for (const row of TEMPLATE_SHORT_CERTIFICATIONS) {
      expect(row).toMatchObject({ status: "certified", certifiedBy: "claude", fixtureCompileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        evidence: { path: expect.stringMatching(/^\.rd\/benchmarks\/usable-v1-20261009\/work\/m1-wave3\//), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(Number.isNaN(Date.parse(row.certifiedAt))).toBe(false);
      expect(Object.keys(TEMPLATE_SHORT_FIXTURE_COPY)).toContain(row.family);
    }
    expect(new Set(TEMPLATE_SHORT_CERTIFICATIONS.map(row => `${row.family}/${row.designSystem}`)).size).toBe(TEMPLATE_SHORT_CERTIFICATIONS.length);
  });

  it("keeps the evidence it names (when the private .rd tree is present)", async () => {
    for (const row of TEMPLATE_SHORT_CERTIFICATIONS) {
      const path = resolve(row.evidence.path);
      if (!existsSync(path)) continue;
      expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(row.evidence.sha256);
    }
  });
});

describe("spot-check draw (design §7, Hao 2026-10-09)", () => {
  const pair = { family: "context_stack", designSystem: "trip_pop_v1" } as const;
  it("drawSpotCheck(index, outputSha): the first run of a family × theme in INDEX.jsonl, then about one in five, deterministic", () => {
    expect(drawSpotCheck({ ...pair, rows: [{ family: "strike_reframe", designSystem: "trip_pop_v1" }] }, "1".repeat(64))).toEqual({ drawn: true, reason: "first_run" });
    expect(drawSpotCheck({ ...pair, rows: [pair] }, `0000000f${"0".repeat(56)}`)).toEqual({ drawn: true, reason: "sampled" });
    expect(drawSpotCheck({ ...pair, rows: [pair] }, `00000010${"0".repeat(56)}`)).toEqual({ drawn: false, reason: "not_drawn" });
    const sha = `${"9".repeat(8)}${"a".repeat(56)}`;
    expect(drawSpotCheck({ ...pair, rows: [pair] }, sha)).toEqual(drawSpotCheck({ ...pair, rows: [pair, pair] }, sha));
  });
});
