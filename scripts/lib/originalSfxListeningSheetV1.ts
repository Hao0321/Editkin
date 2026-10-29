import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { createProceduralSfxLibraryV1 } from "../../src/application/proceduralSfxLibraryV1";
import { encodeProceduralSfxWavV1 } from "../../src/application/proceduralSfxSynthV1";
import { createSfxApprovalReviewV1, createEmptySfxListeningPreferencesV1, encodeSfxListeningPreferencesV1 } from "../../src/application/sfxApprovalV1";
import { readBoundedFile } from "../../src/shared/boundedFile";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function sfxWaveformBinsV1(samples: Int16Array, requestedBins = 64) {
  if (!(samples instanceof Int16Array) || samples.length < 1 || samples.length > 48_000 || !Number.isInteger(requestedBins) || requestedBins < 2 || requestedBins > 256) throw Error("SFX_WAVEFORM_BUDGET");
  const count = Math.min(requestedBins, samples.length);
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor(i * samples.length / count), end = Math.floor((i + 1) * samples.length / count); let min = 32767, max = -32768;
    for (let s = start; s < end; s++) { min = Math.min(min, samples[s]); max = Math.max(max, samples[s]); }
    return { startSample: start, endSample: end, min, max };
  });
}
function waveformSvg(bins: ReturnType<typeof sfxWaveformBinsV1>) {
  return `<svg viewBox="0 0 220 40" role="img" aria-label="音效波形"><path d="M4 20H216" stroke="#657084"/>${bins.map((b, i) => {
    const x = 4 + (i + .5) / bins.length * 212;
    return `<path d="M${x.toFixed(3)} ${(20 - b.max / 32768 * 16).toFixed(3)}V${(20 - b.min / 32768 * 16).toFixed(3)}" stroke="#83a9ff"/>`;
  }).join("")}</svg>`;
}
export function renderOriginalSfxListeningHtmlV1(payload: any, browserScript: string) {
  const script = browserScript.replace(/<\/script/gi, "<\\/script"), scriptHash = createHash("sha256").update(script).digest("base64");
  const cards = payload.entries.map((entry: any) => {
    const sound = payload.sounds.find((s: any) => s.id === entry.id);
    return `<article data-sound-id="${escapeHtml(entry.id)}"><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.kind)} · ${entry.durationSeconds.toFixed(3)} s</p>${waveformSvg(sound.waveform)}
<button class="play" data-action disabled>試聽</button><label>偏好 <select data-action disabled><option value="unreviewed">未決定</option><option value="preferred">偏好</option><option value="needs_changes">需調整</option><option value="reject">不採用</option></select></label>
<label>意見<textarea maxlength="500" data-action disabled></textarea></label><p class="decision">尚無試聽紀錄</p><details><summary>來源識別</summary><code>${entry.sha256}</code><br><code>${entry.sourceSha256}</code></details></article>`;
  }).join("");
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; media-src data:; connect-src 'none'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Editkin 原創音效試聽表</title>
<style>html{color-scheme:dark}body{margin:0 auto;max-width:1200px;padding:20px;background:#14171d;color:#eef0f5;font:16px system-ui,sans-serif}h1{font-size:24px}h2{font-size:16px;margin:0}p{line-height:1.5}header{position:relative;border-bottom:1px solid #536079;padding-bottom:16px}audio{width:min(100%,500px)}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px;margin-top:16px}article{min-width:0;border:1px solid #536079;border-radius:6px;padding:14px}svg{display:block;width:100%;height:50px}button,input,select,textarea{font:inherit;color:inherit;background:#252c38;border:1px solid #8192ad;padding:7px;border-radius:3px;max-width:100%;box-sizing:border-box}button{cursor:pointer}label{display:block;margin:8px 0}textarea{width:100%;height:64px}code{font-size:11px;overflow-wrap:anywhere}.decision{font-size:12px;overflow-wrap:anywhere}#status{min-height:3em}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #83a9ff}</style>
<header><h1>Editkin 原創音效：40 項波形試聽</h1><p>私人試聽資料。八類各五種；請逐項比較。偏好紀錄是試聽者自行填寫的意見，聲音仍待 Hao／Claude 認證，不會自動加入模板、VA 或公開素材庫。</p><label>試聽者名稱 <input id="reviewer" maxlength="80" data-action disabled autocomplete="off"></label><audio id="audition" controls preload="none"></audio><p id="status" role="status">正在核對來源與內嵌音檔…</p><button id="download" data-action disabled>下載試聽紀錄</button><label>重開同一版本的紀錄 <input id="reopen" type="file" accept="application/json,.json" data-action disabled></label></header><main>${cards}</main>
<script id="review-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script><script>${script}</script></html>`;
}
async function plainOutputParent(output: string) {
  if (!isAbsolute(output) || resolve(output) !== output || dirname(output) === output || /^[\\/]{2}/.test(output) || /[\u0000-\u001f]/.test(output)) throw Error("SFX_SHEET_OUTPUT_PATH_INVALID");
  for (let p = dirname(output);; p = dirname(p)) {
    const info = await lstat(p); if (!info.isDirectory() || info.isSymbolicLink()) throw Error("SFX_SHEET_OUTPUT_LINK_OR_TYPE_INVALID");
    if (dirname(p) === p) break;
  }
}
/** Offline review artifact only. Reads the existing original pack and creates a new output directory. */
export async function createOriginalSfxListeningSheetV1(packRoot: string, output: string, options: { signal?: AbortSignal; maximumOutputBytes?: number } = {}) {
  const maximum = options.maximumOutputBytes ?? 8 * 1024 ** 2;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8 * 1024 ** 2) throw Error("SFX_SHEET_OUTPUT_BUDGET");
  const check = () => options.signal?.throwIfAborted(); check(); await plainOutputParent(output);
  try { await lstat(output); throw Error("SFX_SHEET_OUTPUT_EXISTS"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pins = await Promise.all(["src/application/proceduralSfxCatalogueV1.ts", "src/application/proceduralSfxSynthV1.ts"].map(async path => {
    const bytes = await readFile(join(APP, path)); return { path, bytes: bytes.length, sha256: sha(bytes) };
  }));
  const library = await createProceduralSfxLibraryV1(packRoot, pins), entries = [], sounds = [], bindings = [];
  for (let offset = 0; offset < 40; offset += 20) {
    check(); const page = await library.list({ offset, limit: 20 }, options.signal);
    if (page.total !== 40 || page.entries.length !== 20) throw Error("SFX_SHEET_LIBRARY_CLOSURE_REQUIRED");
    for (const item of page.entries) {
      check(); const resolved = await library.resolve({ id: item.id, sha256: item.sha256 }, options.signal);
      const wav = await readBoundedFile(resolved.absolutePath, 96_044);
      if (sha(wav) !== resolved.entry.sha256 || !wav.equals(Buffer.from(encodeProceduralSfxWavV1(resolved.pcm)))) throw Error("SFX_SHEET_PHYSICAL_WAV_CHANGED");
      entries.push(resolved.entry); sounds.push({ id: item.id, wavBase64: wav.toString("base64"), waveform: sfxWaveformBinsV1(resolved.pcm) });
      bindings.push({ path: resolved.absolutePath, bytes: wav.length, sha256: sha(wav) });
    }
  }
  check(); const book = await createSfxApprovalReviewV1(entries, pins), payload = { entries: book.entries, generatorPins: book.generatorPins, reviewSha256: book.reviewSha256, sounds };
  const build = await context({ entryPoints: [join(APP, "scripts/lib/originalSfxListeningBrowserV1.ts")], bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true, write: false, legalComments: "none", logLevel: "silent" });
  const cancel = () => { void build.cancel(); }; options.signal?.addEventListener("abort", cancel, { once: true });
  let script: string;
  try { check(); const result = await build.rebuild(); check(); script = result.outputFiles![0].text; }
  finally { options.signal?.removeEventListener("abort", cancel); await build.dispose(); }
  const html = renderOriginalSfxListeningHtmlV1(payload, script), empty = encodeSfxListeningPreferencesV1(book, createEmptySfxListeningPreferencesV1(book));
  const publicBinding = JSON.stringify({ schema: book.schema, reviewSha256: book.reviewSha256, generatorPins: book.generatorPins, entries: book.entries,
    qualityApprovalGranted: false, defaultEnabled: false, redistributable: false, assertion: "No actual human preferences generated" }, null, 2);
  const files = [{ name: "index.html", bytes: Buffer.from(html) }, { name: "SOURCE_BINDING.json", bytes: Buffer.from(publicBinding) }, { name: "EMPTY_PREFERENCES.json", bytes: Buffer.from(empty) }];
  if (files.reduce((sum, f) => sum + f.bytes.length, 0) > maximum) throw Error("SFX_SHEET_OUTPUT_BUDGET");
  for (const binding of bindings) { check(); const bytes = await readBoundedFile(binding.path, 96_044); if (bytes.length !== binding.bytes || sha(bytes) !== binding.sha256) throw Error("SFX_SHEET_PHYSICAL_WAV_CHANGED"); }
  for (const item of entries) { check(); await library.resolve({ id: item.id, sha256: item.sha256 }, options.signal); }
  for (const pin of pins) if (sha(await readFile(join(APP, pin.path))) !== pin.sha256) throw Error("SFX_SHEET_GENERATOR_CHANGED");
  check(); await plainOutputParent(output); await mkdir(output);
  for (const file of files) { check(); await writeFile(join(output, file.name), file.bytes, { flag: "wx" }); }
  return { schema: "editkin.original-sfx-listening-sheet-result/v1" as const, reviewSha256: book.reviewSha256, sounds: 40, files: files.map(f => ({ name: f.name, bytes: f.bytes.length, sha256: sha(f.bytes) })),
    sourceFilesRechecked: true, qualityApprovalGranted: false, defaultEnabled: false, redistributable: false, humanListeningPerformed: false, projectMutationPerformed: false };
}
