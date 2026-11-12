import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readMaterialIntelligence, readMaterialKeyframe } from "../src/application/materialIntelligence";

const [cacheRootInput, materialId, outputRootInput] = process.argv.slice(2);
if (!cacheRootInput || !/^[a-f0-9]{64}$/.test(materialId ?? "") || !outputRootInput) {
  throw new Error("Usage: tsx scripts/autopilot-material-review.ts <cache-root> <material-id> <output-dir>");
}
const cacheRoot = resolve(cacheRootInput);
const outputRoot = resolve(outputRootInput);
const appRoot = resolve(import.meta.dirname, "..");
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
if (within(cacheRoot, outputRoot) || within(appRoot, outputRoot)) {
  throw new Error("Review output must be outside the cache and source checkout");
}
if (existsSync(outputRoot)) throw new Error("Review output directory already exists; choose a new directory");
const packet = await readMaterialIntelligence(cacheRoot, materialId);
if (packet.materialId !== materialId || !packet.keyframes.length) {
  throw new Error("Material packet has no reviewable keyframes");
}
const frames = await Promise.all(packet.keyframes.map(async (item) => {
  const { frame, data } = await readMaterialKeyframe(cacheRoot, materialId, item.id);
  if (!frame.display || frame.display.normalization.purpose !== "neutral-display-proxy") {
    throw new Error(`Frame ${frame.id} has no verified visual-inspection display receipt`);
  }
  return { frame, data };
}));
await mkdir(outputRoot, { recursive: true });
const escaped = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const frameRows = [];
for (const { frame, data } of frames) {
  const fileName = `${frame.id}.jpg`;
  await writeFile(join(outputRoot, fileName), data);
  frameRows.push({ id: frame.id, time: frame.time, sceneIndex: frame.sceneIndex, sha256: createHash("sha256").update(data).digest("hex"), displayReceiptSha256: frame.display!.receiptSha256, fileName });
}
const review = {
  schema: "editkin.material-review/v1", materialId, sourceSha256: packet.source.sourceSha256,
  assetId: packet.source.assetId, clipId: packet.source.clipId, sourceStart: packet.source.sourceStart,
  duration: packet.source.duration, transcriptState: packet.analysis.transcript.state,
  frameRows, inspectedByHuman: false, semanticReceiptSha256: null,
  note: "This page exports verified keyframes for review. It does not prove the intervals between frames or record material semantics.",
};
await writeFile(join(outputRoot, "review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8");
const cards = frameRows.map((row) => [
  '<figure><img src="', escaped(row.fileName), '" alt="', escaped(`${row.id} at ${row.time.toFixed(3)} seconds`), '"><figcaption>',
  escaped(row.id), " · source clip ", row.time.toFixed(3), " s · scene ", String(row.sceneIndex),
  "<br><code>", escaped(row.sha256), "</code></figcaption></figure>",
].join("")).join("\n");
const html = [
  '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
  '<meta name="referrer" content="no-referrer"><title>素材證據檢視</title><style>',
  "body{margin:0;background:#10151d;color:#e8eff8;font:16px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:32px}h1{margin:0 0 8px}.muted{color:#a8b7ca}.warning{padding:14px;background:#44300d;border:1px solid #bb8732;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}figure{margin:0;background:#1c2633;padding:12px;border-radius:8px}img{display:block;width:100%;height:auto}figcaption{padding-top:8px}code{font-size:11px;overflow-wrap:anywhere;color:#9fb6cd}",
  '</style></head><body><main><h1>素材證據檢視</h1><p class="muted">Clip ', escaped(packet.source.clipId), " · ",
  packet.source.duration.toFixed(3), " 秒 · ", String(frames.length), " 張已驗證關鍵幀 · transcript ", escaped(packet.analysis.transcript.state),
  '</p><p class="warning">抽樣畫面不能證明影格間發生的事；尚未做人眼語意確認，沒有產生語意收據，也沒有改動時間軸。</p><div class="grid">',
  cards, "</div></main></body></html>",
].join("");
await writeFile(join(outputRoot, "index.html"), html, "utf8");
process.stdout.write(JSON.stringify({ status: "review_ready", materialId, frameCount: frames.length, html: join(outputRoot, "index.html"), review: join(outputRoot, "review.json") }) + "\n");
