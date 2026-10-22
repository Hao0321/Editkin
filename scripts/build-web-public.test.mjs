import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, readFile, rename, symlink, writeFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useTempRoots } from "../src/test/tempRoot.mjs";
import { spawnSync } from "node:child_process";
import { verifyWebPublicIdentity } from "./lib/web-public-identity.mjs";
import { DESKTOP_BRAND_CONFIG, DESKTOP_BRAND_FILES, DESKTOP_BRAND_MANIFEST,
  DESKTOP_BRAND_SOURCE, WINDOWS_BRAND_ICON } from "./lib/desktop-branding.mjs";

const sources = ["public/demo-source.mp4", "public/editkin-demo-preview.mp4", "public/favicon.svg",
  "public/brand/editkin-symbol-v3-sky.webp",
  "public/brand/editkin-symbol-v3-candy.webp",
  "public/brand/editkin-symbol-v3-volt.webp",
  "public/fonts/NotoSansTC[wght].ttf", "public/fonts/NotoSerifTC[wght].ttf",
  "public/fonts/LXGWWenKaiMonoTC-Regular.ttf", "public/fonts/BebasNeue-Regular.ttf",
  "public/fonts/Fredoka[wdth,wght].ttf", "public/fonts/LXGWWenKaiTC-Bold.ttf"];

// Fixtures are removed after the file; their junctions are unlinked as links, never followed.
const temp = useTempRoots(after);
async function fixture() {
  const root = await temp.create("editkin-web-public-identity-");
  for (const source of [...sources, "public/benchmarks/nested/frame.svg", WINDOWS_BRAND_ICON]) {
    const path = join(root, source);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, `Owned test asset ${source}\n`);
  }
  for (const source of [DESKTOP_BRAND_CONFIG, DESKTOP_BRAND_MANIFEST, DESKTOP_BRAND_SOURCE, ...DESKTOP_BRAND_FILES]) {
    const path = join(root, source);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, await readFile(resolve(import.meta.dirname, "..", source)));
  }
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  for (const script of ["build-web-public.mjs", "lib/web-public-identity.mjs", "lib/regular-file.mjs", "lib/desktop-branding.mjs"]) {
    await writeFile(join(root, "scripts", script), await readFile(resolve(import.meta.dirname, script)));
  }
  return { root, output: join(root, ".web-public"), sources };
}

function runProducer(root) {
  const result = spawnSync(process.execPath, [join(root, "scripts/build-web-public.mjs")],
    { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function successful(result) {
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "GREEN_WEB_PUBLIC");
  return report;
}

test("an absent output is inspected without creating it", async () => {
  const value = await fixture();
  const check = await verifyWebPublicIdentity(value);
  assert.equal(check.matches, false);
  assert.equal(check.present, false);
  assert.equal(check.assetFiles, 14);
  assert.equal((await readdir(value.root)).includes(".web-public"), false);
});

test("cold production copy is exact and the unchanged second request reuses it", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  assert.equal((await verifyWebPublicIdentity(value)).matches, true);
  assert.deepEqual(await readFile(join(value.output, "favicon.ico")), await readFile(join(value.root, WINDOWS_BRAND_ICON)));
  const names = await readdir(value.root);
  const report = successful(runProducer(value.root));
  assert.equal(report.reused, true);
  assert.equal(report.assetFiles, 14);
  assert.deepEqual(await readdir(value.root), names);
});

test("same-size changed bytes cannot be reused and are rebuilt", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  const source = join(value.root, "public/favicon.svg");
  const prior = await readFile(source);
  const next = Buffer.from(prior);
  next[0] ^= 1;
  await writeFile(source, next);
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
  assert.notEqual(successful(runProducer(value.root)).reused, true);
  assert.deepEqual(await readFile(join(value.output, "favicon.svg")), next);
});

test("new registered benchmark assets enter the expected closed set", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  await writeFile(join(value.root, "public/benchmarks/new-frame.svg"), "new owned fixture\n");
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
  successful(runProducer(value.root));
  assert.equal((await verifyWebPublicIdentity(value)).assetFiles, 15);
  assert.equal(await readFile(join(value.output, "benchmarks/new-frame.svg"), "utf8"), "new owned fixture\n");
});

test("extra regular cached bytes cannot be reused or included in the rebuilt surface", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  const file = join(value.output, "foreign.txt");
  await writeFile(file, "foreign entries require review\n");
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
  assert.notEqual(successful(runProducer(value.root)).reused, true);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal((await verifyWebPublicIdentity(value)).matches, true);
  assert.equal((await readdir(value.root)).some(name => name.startsWith(".web-public-backup-")), false);
});

test("an extra empty cache directory cannot count as an exact reuse", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  await mkdir(join(value.output, "foreign-directory"));
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
});

test("removed benchmark assets are omitted by a fresh rebuild", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  await unlink(join(value.root, "public/benchmarks/nested/frame.svg"));
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
  assert.notEqual(successful(runProducer(value.root)).reused, true);
  await assert.rejects(readFile(join(value.output, "benchmarks/nested/frame.svg")), { code: "ENOENT" });
  assert.equal((await verifyWebPublicIdentity(value)).matches, true);
});

test("a source directory junction cannot become trusted asset inputs", async () => {
  const value = await fixture();
  const folder = join(value.root, "public/benchmarks");
  await rename(folder, join(value.root, "held-benchmarks"));
  await symlink(join(value.root, "held-benchmarks"), folder, "junction");
  await assert.rejects(verifyWebPublicIdentity(value), /Unsafe web asset directory/);
});

test("an output junction is rejected even when its target has matching bytes", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  const held = join(value.root, "held-output");
  await rename(value.output, held);
  await symlink(held, value.output, "junction");
  const result = runProducer(value.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe web asset directory/);
  assert.deepEqual(await readFile(join(held, "favicon.svg")), await readFile(join(value.root, "public/favicon.svg")));
});

test("case-folded duplicate destinations and parent escape are rejected", async () => {
  const value = await fixture();
  await assert.rejects(verifyWebPublicIdentity({ ...value, sources: [...sources, "public/favicon.svg"] }), /Duplicate web asset path/);
  await assert.rejects(verifyWebPublicIdentity({ ...value, output: join(value.root, "..", "foreign-output") }), /escapes its managed directory/);
});

test("all three existing theme logos are copied exactly and a missing logo blocks a fresh build", async () => {
  const value = await fixture();
  successful(runProducer(value.root));
  for (const theme of ["sky", "candy", "volt"]) {
    const rel = `brand/editkin-symbol-v3-${theme}.webp`;
    assert.deepEqual(await readFile(join(value.output, rel)), await readFile(join(value.root, "public", rel)));
  }
  const logo = join(value.root, "public/brand/editkin-symbol-v3-sky.webp");
  const before = await readFile(join(value.output, "brand/editkin-symbol-v3-sky.webp"));
  await unlink(logo);
  const blocked = runProducer(value.root);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /ENOENT/);
  assert.deepEqual(await readFile(join(value.output, "brand/editkin-symbol-v3-sky.webp")), before);
});

test("same-size altered theme-logo bytes invalidate reuse and never enter a wrong identity", async () => {
  const value = await fixture(); successful(runProducer(value.root));
  const source = join(value.root, "public/brand/editkin-symbol-v3-candy.webp");
  const next = Buffer.from(await readFile(source)); next[0] ^= 1; await writeFile(source, next);
  assert.equal((await verifyWebPublicIdentity(value)).matches, false);
  assert.notEqual(successful(runProducer(value.root)).reused, true);
  assert.deepEqual(await readFile(join(value.output, "brand/editkin-symbol-v3-candy.webp")), next);
});
