import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledPath = path.join(root, "src", "creative", "editkinAestheticStandard.json");
const canonicalPath = path.resolve(root, "..", "..", "video-autopilot-kit", "knowledge", "aesthetic_standard.json");
const bundledText = await readFile(bundledPath, "utf8");
const bundled = JSON.parse(bundledText);
assert.equal(bundled.standard_id, "editkin-community-aesthetic-standard");
assert.match(bundled.source_sha256, /^[a-f0-9]{64}$/);
assert.match(bundled.reference_basis.shared_dna_sha256, /^[a-f0-9]{64}$/);
assert.equal(Object.values(bundled.dimensions).reduce((sum, row) => sum + Number(row.weight), 0), 100);
assert.equal(Object.keys(bundled.dimensions).length, 10);
assert.ok(Object.keys(bundled.style_families).length >= 12);
assert.equal(bundled.score_contract.pass_score, 90);
assert.equal(bundled.score_contract.minimum_dimension_rating, 3.5);
assert.equal(bundled.score_contract.human_review_required, true);
assert.ok(!/[A-Z]:[\\/]|private_reference.*(?:path|file)|\.(?:png|jpe?g|webp)\b/i.test(bundledText), "可攜美感契約不可洩漏私人路徑或參考圖檔名");
assert.ok(!/Hao|駱君昊|Hao0321|@[a-z0-9_]+/i.test(bundledText), "可攜美感契約不可含建立者姓名或帳號");
for (const [domain, route] of Object.entries(bundled.domain_routes)) {
  assert.ok(bundled.style_families[route.primary], `${domain} 缺 primary family`);
  for (const family of route.support ?? []) assert.ok(bundled.style_families[family], `${domain} 缺 support family ${family}`);
}
let canonicalChecked = false;
try {
  await access(canonicalPath);
  const canonical = JSON.parse(await readFile(canonicalPath, "utf8"));
  const canonicalText = await readFile(canonicalPath, "utf8");
  assert.equal(bundled.source_sha256, createHash("sha256").update(canonicalText).digest("hex"), "Editkin 美感來源 hash 落後 canonical");
  assert.equal(bundled.version, canonical.version, "Editkin 美感契約版本落後 canonical；先跑 npm run aesthetic:sync");
  assert.deepEqual(Object.keys(bundled.dimensions), Object.keys(canonical.dimensions), "Editkin 十維評分維度與 canonical 漂移");
  for (const [id, row] of Object.entries(canonical.dimensions)) {
    assert.equal(bundled.dimensions[id].weight, row.weight, `Editkin ${id} 權重與 canonical 漂移`);
  }
  assert.deepEqual(bundled.style_families, canonical.style_families, "Editkin 美術家族與 canonical 漂移");
  assert.deepEqual(bundled.domain_routes, canonical.domain_routes, "Editkin 題材路由與 canonical 漂移");
  canonicalChecked = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
console.log(JSON.stringify({ status: "GREEN", standard: `${bundled.standard_id}@${bundled.version}`, dimensions: Object.keys(bundled.dimensions).length, families: Object.keys(bundled.style_families).length, canonicalChecked, sha256: createHash("sha256").update(bundledText).digest("hex") }));
