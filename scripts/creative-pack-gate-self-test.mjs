import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preset = (id, renderer) => ({ id, name: id, license: "CC-BY-4.0", provenance: "fixture", renderer });
const base = {
  schemaVersion: 1,
  id: "fixture.pack",
  name: "Fixture",
  version: "1.0.0",
  license: "CC-BY-4.0",
  attribution: "Fixture",
  source: { referenceCount: 1, privateImagesEmbedded: false },
  presets: {
    looks: [preset("look", "ffmpeg-eq")],
    effects: [preset("effect", "ffmpeg-film-grain")],
    transitions: [preset("transition", "transition-fade")],
    textStyles: [preset("text", "ass-text")],
    templates: [preset("template", "hao-motion-composition/v1")],
  },
  assets: [{ ...preset("asset", "media-asset"), path: "asset.bin", bytes: 1, sha256: "a".repeat(64) }],
};
const minimums = { looks: 1, effects: 1, transitions: 1, textStyles: 1, templates: 1, assets: 1 };
const mutations = [
  ["private-path", (item) => { item.attribution = "D:\\fixture-workspace\\private"; }],
  ["private-reference-embedded", (item) => { item.source.privateImagesEmbedded = true; }],
  ["duplicate-id", (item) => { item.presets.effects[0].id = "look"; }],
  ["missing-license", (item) => { item.presets.looks[0].license = ""; }],
  ["public-asset-rights", (item) => { item.assets[0].license = "PRIVATE-OWNER-ONLY"; item.assets[0].redistributable = false; }],
  ["public-asset-rights", (item) => { item.presets.looks[0].license = "PRIVATE-OWNER-ONLY"; }],
  ["public-asset-rights", (item) => { item.assets[0].license = "UNKNOWN-LICENSE"; }],
  ["unsupported-renderer", (item) => { item.presets.transitions[0].renderer = "magic"; }],
  ["unsafe-asset-path", (item) => { item.assets[0].path = "../private.bin"; }],
  ["hash-mismatch", () => {}],
];
const detected = [];
const fixtureRoot = mkdtempSync(join(tmpdir(), "editkin-creative-pack-gate-"));
try {
  writeFileSync(join(fixtureRoot, "asset.bin"), "x");
  for (const [code, mutate] of mutations) {
    const sample = structuredClone(base);
    mutate(sample);
    const report = evaluateCreativePack(sample, code === "hash-mismatch" ? { root: fixtureRoot, minimums } : { minimums });
    if (!report.findings.some((finding) => finding.code === code)) throw new Error(`Creative Pack evaluator 漏抓：${code}`);
    detected.push(code);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
const positive = evaluateCreativePack(base, { minimums });
if (positive.status !== "GREEN") throw new Error(`Creative Pack positive control 失敗：${JSON.stringify(positive)}`);
process.stdout.write(`${JSON.stringify({ status: "GREEN", positiveControl: "PASS", detected })}\n`);
