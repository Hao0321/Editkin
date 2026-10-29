import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { greyBackgroundSampler } from "../backgroundSampler";
import { compileStylePlanV1 } from "../compiler";
import { getStyleTemplateV1 } from "../templates";

/**
 * Measured contrast on the real proof footage (design §4, Claude's Phase A review): every compiled caption beat of
 * the S2 and S3 proof plans must reach 4.5:1 against the actual pixels behind its text. The fixtures are the review
 * harness's 4 fps grey copies of the graded footage (Hao's own B-roll) and the hand-written plans.
 */
const PROOF = resolve(import.meta.dirname, "../../../.rd/benchmarks/style-system-20261022/proof");
const CASES = [
  { name: "S2-story_illustrated-9x16", plan: "plan-S2-9x16.json", template: "S2_story_illustrated" },
  { name: "S3-lifestyle_promo-9x16", plan: "plan-S3-9x16.json", template: "S3_lifestyle_promo" },
];

for (const entry of CASES) {
  const grey = join(PROOF, "background", `${entry.name}.grey`), header = join(PROOF, "background", `${entry.name}.json`), planPath = join(PROOF, entry.plan);
  describe.skipIf(!existsSync(grey) || !existsSync(planPath))(`measured contrast on the real footage: ${entry.name}`, () => {
    it("every caption beat reaches 4.5:1 against the pixels behind it", () => {
      const meta = JSON.parse(readFileSync(header, "utf8")) as { rate: number; columns: number; rows: number; width: number; height: number };
      const data = new Uint8Array(readFileSync(grey));
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      const result = compileStylePlanV1(getStyleTemplateV1(entry.template), plan, {
        width: meta.width, height: meta.height, fps: 30, footage: [],
        sampleBackground: greyBackgroundSampler({ ...meta, data }),
      });
      const captions = plan.beats.filter((beat: { kind: string }) => beat.kind === "caption").length;
      expect(result.captionReadability).toHaveLength(captions);
      const failing = result.captionReadability.filter(row => !row.pass || row.lead < 4.5 || (row.keyword !== undefined && row.keyword < 4.5));
      expect(failing, JSON.stringify(failing)).toEqual([]);
      expect(result.issues.filter(issue => issue.code === "STYLE_CONTRAST_BELOW_TARGET")).toEqual([]);
      // Glow survives only on dark, calm backgrounds; S3 never gets a plate (on-footage rule), only a soft scrim ≤ 35%.
      for (const job of result.jobs) {
        if (job.params.component !== "caption") continue;
        expect(job.params.readability.plate).toBeUndefined();
        if (job.params.readability.scrim) expect(job.params.readability.scrim.opacity).toBeLessThanOrEqual(0.35);
      }
    });
  });
}
