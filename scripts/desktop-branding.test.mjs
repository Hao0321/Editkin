import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { useTempRoots } from "../src/test/tempRoot.mjs";
import { DESKTOP_BRAND_CONFIG, DESKTOP_BRAND_FILES, DESKTOP_BRAND_MANIFEST,
  DESKTOP_BRAND_SOURCE, WINDOWS_BRAND_ICON, verifyDesktopBranding } from "./lib/desktop-branding.mjs";

const root = resolve(import.meta.dirname, "..");
const temp = useTempRoots(after);
async function fixture() {
  const target = await temp.create("editkin-native-branding-");
  for (const name of [DESKTOP_BRAND_CONFIG, DESKTOP_BRAND_MANIFEST, DESKTOP_BRAND_SOURCE, ...DESKTOP_BRAND_FILES]) {
    await mkdir(dirname(join(target, name)), { recursive: true });
    await writeFile(join(target, name), await readFile(join(root, name)));
  }
  return target;
}

test("the actual native and installer configuration binds the existing V3 artwork conversion", async () => {
  const result = await verifyDesktopBranding(root);
  assert.equal(result.status, "GREEN_DESKTOP_BRANDING");
  assert.equal(result.nativeIcon, WINDOWS_BRAND_ICON);
  assert.equal(result.outputFiles, 4);
  assert.ok(result.outputBytes <= 524288);
});

test("replacing the new native icon with the old purple E is rejected", async () => {
  const target = await fixture();
  await writeFile(join(target, WINDOWS_BRAND_ICON), await readFile(join(root, "src-tauri/icons/icon.ico")));
  await assert.rejects(verifyDesktopBranding(target), /output identity changed/);
});

test("an old installer reference or a missing declared PNG cannot pass branding preflight", async () => {
  const target = await fixture();
  const path = join(target, DESKTOP_BRAND_CONFIG);
  const config = JSON.parse(await readFile(path, "utf8"));
  config.bundle.windows.nsis.installerIcon = "icons/icon.ico";
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(verifyDesktopBranding(target), /configuration differs/);
  await writeFile(path, await readFile(join(root, DESKTOP_BRAND_CONFIG)));
  await unlink(join(target, DESKTOP_BRAND_FILES[0]));
  await assert.rejects(verifyDesktopBranding(target), { code: "ENOENT" });
});
