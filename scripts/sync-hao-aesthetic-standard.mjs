import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = path.resolve(root, "..", "..", "video-autopilot-kit", "knowledge", "aesthetic_standard.json");
const destination = path.join(root, "src", "creative", "editkinAestheticStandard.json");

const canonicalText = await readFile(canonical, "utf8");
const source = JSON.parse(canonicalText);
const portable = {
  schema_version: source.schema_version,
  standard_id: "editkin-community-aesthetic-standard",
  version: source.version,
  source_sha256: createHash("sha256").update(canonicalText).digest("hex"),
  reference_basis: {
    private_reference_count: source.reference_basis?.private_reference_count,
    method: source.reference_basis?.method,
    shared_dna: source.reference_basis?.shared_dna,
    shared_dna_sha256: createHash("sha256").update(JSON.stringify(source.reference_basis?.shared_dna ?? [])).digest("hex"),
  },
  principles: source.principles,
  dimensions: Object.fromEntries(Object.entries(source.dimensions ?? {}).map(([id, row]) => [id, {
    ...row,
    question: String(row.question ?? "").replaceAll("Hao 的識別", "建立者的原創識別"),
  }])),
  format_multipliers: source.format_multipliers,
  score_contract: source.score_contract,
  style_families: source.style_families,
  domain_routes: source.domain_routes,
  format_rules: source.format_rules,
  presentation_grammars: source.presentation_grammars,
  machine_block_signals: source.machine_block_signals,
};
const payload = `${JSON.stringify(portable, null, 2)}\n`;
await writeFile(destination, payload, "utf8");
console.log(JSON.stringify({ status: "GREEN", standard: `${portable.standard_id}@${portable.version}`, sha256: createHash("sha256").update(payload).digest("hex"), destination }));
