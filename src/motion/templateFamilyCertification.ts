import type { ReferenceMotionDesignSystem, ReferenceMotionTemplateId } from "./referenceMotionTemplates";

/** Art certification of one template family × design theme for one-tool Shorts (design §7). Claude certifies a pair
 * after a full art review of real-footage renders; the drift test (templateShortCertification.test.ts) recompiles the
 * pair's fixture and compares `fixtureCompileSha256`, so any template change needs a new review and certification.
 * Ships with the build and never changes at runtime: a pair that is not listed is REVIEW_REQUIRED at best. */
export interface TemplateShortCertification {
  family: ReferenceMotionTemplateId;
  designSystem: ReferenceMotionDesignSystem;
  status: "certified";
  certifiedBy: "claude";
  certifiedAt: string;
  evidence: { path: string; sha256: string };
  fixtureCompileSha256: string;
}
const CERTIFIED: TemplateShortCertification[] = [
  // M1 wave 3 (ROADMAP 1.5): Claude reviewed every frame of two real-footage renders per family after the r53 fixes
  // (tag hitch, claim/deck handoff, struck-hook hierarchy, step handoff, place/brand exit); evidence lists the renders,
  // their QA and the sheets and strips looked at, by SHA-256.
  Object.freeze({ family: "strike_reframe", designSystem: "trip_pop_v1", status: "certified", certifiedBy: "claude", certifiedAt: "2026-10-10T13:05:00+08:00",
    evidence: Object.freeze({ path: ".rd/benchmarks/usable-v1-20261009/work/m1-wave3/CERTIFICATION_strike_reframe_trip_pop_v1.json",
      sha256: "62b652d93e049f32e8165dc18519c5b01862e1e9c8044d66dfd74becfdfc7aa5" }),
    fixtureCompileSha256: "428fac7c7e20b131b1e1f333836c232308ac7a71caf2268541529ca2295ab5ff" }),
  Object.freeze({ family: "context_stack", designSystem: "trip_pop_v1", status: "certified", certifiedBy: "claude", certifiedAt: "2026-10-10T13:05:00+08:00",
    evidence: Object.freeze({ path: ".rd/benchmarks/usable-v1-20261009/work/m1-wave3/CERTIFICATION_context_stack_trip_pop_v1.json",
      sha256: "5dac70ce29cf0a4838d9fd7dda5fe5467a67376e8dc688140781b401d46b3198" }),
    fixtureCompileSha256: "4e6df09211c6ea71ec0ba433f715cf5fadf68a805c54bb4dc20b8229623d06ef" }),
];
export const TEMPLATE_SHORT_CERTIFICATIONS: readonly TemplateShortCertification[] = Object.freeze(CERTIFIED);

export function findTemplateShortCertification(family: ReferenceMotionTemplateId, designSystem: ReferenceMotionDesignSystem,
  certifications: readonly TemplateShortCertification[] = TEMPLATE_SHORT_CERTIFICATIONS): TemplateShortCertification | undefined {
  return certifications.find(row => row.status === "certified" && row.family === family && row.designSystem === designSystem);
}

/** Hao 2026-10-09: the first run of each family × theme gets a full art review, then about one run in five is drawn
 * for a spot-check. Deterministic from the output bytes; mechanical QA still runs on every render. */
export function drawTemplateShortSpotCheck(input: { family: ReferenceMotionTemplateId; designSystem: ReferenceMotionDesignSystem; outputSha256: string;
  priorRuns: ReadonlyArray<{ family: string; designSystem: string }> }): { drawn: boolean; reason: "first_run" | "sampled" | "not_drawn" } {
  if (!/^[a-f0-9]{64}$/.test(input.outputSha256)) throw new Error("Spot-check draw requires the output SHA-256");
  if (!input.priorRuns.some(run => run.family === input.family && run.designSystem === input.designSystem)) return { drawn: true, reason: "first_run" };
  return Number.parseInt(input.outputSha256.slice(0, 8), 16) % 5 === 0 ? { drawn: true, reason: "sampled" } : { drawn: false, reason: "not_drawn" };
}
/** Design §7 shorthand: `index` is this run's family × theme with the INDEX.jsonl rows written before it. */
export function drawSpotCheck(index: { family: ReferenceMotionTemplateId; designSystem: ReferenceMotionDesignSystem; rows: ReadonlyArray<{ family: string; designSystem: string }> },
  outputSha256: string) {
  return drawTemplateShortSpotCheck({ family: index.family, designSystem: index.designSystem, outputSha256, priorRuns: index.rows });
}
