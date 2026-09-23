import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export function evaluateBundleSizes(measurement, budgets) {
  const findings = [];
  const checks = [
    ["main-js", measurement.mainJavaScriptBytes, budgets.mainJavaScriptMaxBytes],
    ["main-js-gzip", measurement.mainJavaScriptGzipBytes, budgets.mainJavaScriptGzipMaxBytes],
    ["initial-js", measurement.initialJavaScriptBytes, budgets.initialJavaScriptMaxBytes],
    ["initial-js-gzip", measurement.initialJavaScriptGzipBytes, budgets.initialJavaScriptGzipMaxBytes],
    ["main-css", measurement.mainCssBytes, budgets.mainCssMaxBytes],
    ["main-css-gzip", measurement.mainCssGzipBytes, budgets.mainCssGzipMaxBytes],
  ];
  for (const [code, actual, limit] of checks) {
    if (!Number.isSafeInteger(limit) || limit <= 0) findings.push({ status: "FAIL", code: "invalid-budget", metric: code, limit });
    else if (!Number.isSafeInteger(actual) || actual <= 0) findings.push({ status: "FAIL", code: "missing-measurement", metric: code, actual });
    else if (actual > limit) findings.push({ status: "FAIL", code: "bundle-budget", metric: code, actual, limit });
    else findings.push({ status: "PASS", code, actual, limit });
  }
  return { status: findings.some((item) => item.status === "FAIL") ? "BLOCK" : "GREEN", measurement, budgets, findings };
}

if (process.argv.includes("--self-test")) {
  const budgets = { mainJavaScriptMaxBytes: 10, mainJavaScriptGzipMaxBytes: 8, initialJavaScriptMaxBytes: 20, initialJavaScriptGzipMaxBytes: 14, mainCssMaxBytes: 5, mainCssGzipMaxBytes: 4 };
  const valid = { mainJavaScriptBytes: 10, mainJavaScriptGzipBytes: 8, initialJavaScriptBytes: 20, initialJavaScriptGzipBytes: 14, mainCssBytes: 5, mainCssGzipBytes: 4 };
  if (evaluateBundleSizes(valid, budgets).status !== "GREEN") throw new Error("bundle gate rejected positive control");
  const mutations = Object.keys(valid).map((key) => {
    const value = { ...valid, [key]: valid[key] + 1 };
    if (evaluateBundleSizes(value, budgets).status !== "BLOCK") throw new Error(`bundle gate missed ${key}`);
    return key;
  });
  process.stdout.write(`${JSON.stringify({ status: "GREEN", positiveControl: "PASS", detected: mutations })}\n`);
} else {
  const root = resolve(import.meta.dirname, "..");
  const budgets = JSON.parse(await readFile(resolve(root, "performance-budgets.json"), "utf8"));
  if (budgets.schemaVersion !== 1) throw new Error("performance-budgets schemaVersion 必須是 1");
  const assetsRoot = resolve(root, "dist/assets");
  const names = await readdir(assetsRoot);
  const jsName = names.find((name) => /^index-.*\.js$/.test(name));
  const cssName = names.find((name) => /^index-.*\.css$/.test(name));
  if (!jsName || !cssName) throw new Error("找不到 Vite main JavaScript／CSS bundle");
  const [javascript, css] = await Promise.all([readFile(resolve(assetsRoot, jsName)), readFile(resolve(assetsRoot, cssName))]);
  const initialFiles = [];
  const pending = [jsName];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const bytes = await readFile(resolve(assetsRoot, name));
    initialFiles.push({ name, bytes });
    const source = bytes.toString("utf8");
    const imports = source.matchAll(/\b(?:from|import)["']\.\/([^"']+\.js)["']/g);
    for (const match of imports) pending.push(match[1]);
  }
  const report = evaluateBundleSizes({
    mainJavaScriptFile: jsName,
    mainJavaScriptBytes: javascript.length,
    mainJavaScriptGzipBytes: gzipSync(javascript).length,
    initialJavaScriptFiles: initialFiles.map((item) => item.name).sort(),
    initialJavaScriptBytes: initialFiles.reduce((total, item) => total + item.bytes.length, 0),
    initialJavaScriptGzipBytes: initialFiles.reduce((total, item) => total + gzipSync(item.bytes).length, 0),
    mainCssFile: cssName,
    mainCssBytes: css.length,
    mainCssGzipBytes: gzipSync(css).length,
  }, budgets);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "GREEN") process.exitCode = 1;
}
