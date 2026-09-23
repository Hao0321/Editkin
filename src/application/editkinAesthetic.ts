import standardJson from "../creative/editkinAestheticStandard.json";
import type { AestheticSystem, EditorialProfileId } from "../domain/types";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES } from "../domain/aestheticBenchmarks";
export { scoreAestheticReview } from "../domain/aestheticReview";

interface StandardDimension { label_zh: string; weight: number; question: string }
interface StandardFamily { label_zh: string; templates: string[]; traits: string[]; best_for: string[] }
interface StandardRoute { primary: string; support: string[]; avoid: string[] }
interface PortableAestheticStandard {
  standard_id: "editkin-community-aesthetic-standard";
  version: string;
  source_sha256: string;
  reference_basis: { shared_dna_sha256: string; shared_dna: string[] };
  dimensions: Record<string, StandardDimension>;
  format_multipliers: Record<"shorts" | "longform", Record<string, number>>;
  score_contract: { pass_score: number; block_below: number; minimum_dimension_rating: number; human_review_required: true };
  style_families: Record<string, StandardFamily>;
  domain_routes: Record<string, StandardRoute>;
  machine_block_signals: Record<string, string>;
}

export const EDITKIN_AESTHETIC_STANDARD = standardJson as PortableAestheticStandard;

const PROFILE_DOMAIN: Record<EditorialProfileId, string> = {
  auto: "general",
  gaming: "toy",
  food: "food",
  travel: "travel",
  podcast_on_camera: "interview",
  podcast_no_face: "documentary",
};

function normalizeFormat(format: string): "shorts" | "longform" {
  return /long|youtube|landscape/i.test(format) ? "longform" : "shorts";
}

export function aestheticDomainForProfile(profile: EditorialProfileId): string {
  return PROFILE_DOMAIN[profile];
}

export function resolveAestheticSystem(profile: EditorialProfileId, format = "shorts"): AestheticSystem {
  return resolveAestheticSystemForDomain(aestheticDomainForProfile(profile), format);
}

export function resolveAestheticSystemForDomain(domain: string, format = "shorts"): AestheticSystem {
  const selectedFormat = normalizeFormat(format);
  const route = EDITKIN_AESTHETIC_STANDARD.domain_routes[domain] ?? EDITKIN_AESTHETIC_STANDARD.domain_routes.general;
  const family = EDITKIN_AESTHETIC_STANDARD.style_families[route.primary];
  const rawWeights = Object.fromEntries(Object.entries(EDITKIN_AESTHETIC_STANDARD.dimensions).map(([id, row]) => [
    id,
    row.weight * (EDITKIN_AESTHETIC_STANDARD.format_multipliers[selectedFormat][id] ?? 1),
  ]));
  const total = Object.values(rawWeights).reduce((sum, value) => sum + value, 0) || 1;
  return {
    schema: "editkin.aesthetic-system/v1",
    standardId: EDITKIN_AESTHETIC_STANDARD.standard_id,
    standardVersion: EDITKIN_AESTHETIC_STANDARD.version,
    sourceSha256: EDITKIN_AESTHETIC_STANDARD.source_sha256,
    format: selectedFormat,
    domain,
    primaryFamily: route.primary,
    primaryLabel: family.label_zh,
    supportFamilies: [...route.support],
    avoid: [...route.avoid],
    sharedDnaSha256: EDITKIN_AESTHETIC_STANDARD.reference_basis.shared_dna_sha256,
    dimensions: Object.entries(EDITKIN_AESTHETIC_STANDARD.dimensions).map(([id, row]) => ({
      id,
      labelZh: row.label_zh,
      question: row.question,
      weight: Math.round(rawWeights[id] * 100_000 / total) / 1_000,
    })),
    scoreContract: {
      passScore: EDITKIN_AESTHETIC_STANDARD.score_contract.pass_score,
      blockBelow: EDITKIN_AESTHETIC_STANDARD.score_contract.block_below,
      minimumDimensionRating: EDITKIN_AESTHETIC_STANDARD.score_contract.minimum_dimension_rating,
      humanReviewRequired: true,
    },
    review: { status: "REVIEW", score: 0, ratings: {}, machineBlockers: [] },
  };
}

export function compactAestheticContract() {
  return {
    schema: "editkin.aesthetic-system/v1",
    standardId: EDITKIN_AESTHETIC_STANDARD.standard_id,
    standardVersion: EDITKIN_AESTHETIC_STANDARD.version,
    sourceSha256: EDITKIN_AESTHETIC_STANDARD.source_sha256,
    dimensionIds: Object.keys(EDITKIN_AESTHETIC_STANDARD.dimensions),
    familyIds: Object.keys(EDITKIN_AESTHETIC_STANDARD.style_families),
    domainIds: Object.keys(EDITKIN_AESTHETIC_STANDARD.domain_routes),
    passScore: EDITKIN_AESTHETIC_STANDARD.score_contract.pass_score,
    humanReviewRequired: true,
    benchmarkReview: {
      schema: "editkin.aesthetic-benchmark-review/v1",
      axes: BENCHMARK_AXES.map(id => ({ id, minimumScore: 7, outOf: 10, itemIds: AESTHETIC_BENCHMARKS[id].map(item => item.id) })),
      policy: "Eight subcriteria per axis derive the existing two dimension ratings; never double-count. Each needs output-bound frame observations. Missing current output or human review is REVIEW, not certification.",
    },
    privacy: "anonymous compiled principles only; no personal paths, accounts, names or reference artwork",
  } as const;
}
