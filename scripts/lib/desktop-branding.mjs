import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { readRegularFile } from "./regular-file.mjs";
import { assertWindowIconResolutionV1 } from "./windows-icon-container.mjs";

export const DESKTOP_BRAND_SOURCE = "public/brand/editkin-symbol-v3-sky.webp";
export const DESKTOP_BRAND_MANIFEST = "src-tauri/icons/brand-v3/manifest.json";
export const DESKTOP_BRAND_CONFIG = "src-tauri/tauri.windows.conf.json";
export const WINDOWS_BRAND_ICON = "src-tauri/icons/brand-v3/icon.ico";
// The context's PNG fallback keeps the full artwork for high-DPI window icons.
export const DESKTOP_BRAND_FILES = Object.freeze([
  "src-tauri/icons/brand-v3/128x128@2x.png",
  "src-tauri/icons/brand-v3/128x128.png",
  "src-tauri/icons/brand-v3/32x32.png",
  WINDOWS_BRAND_ICON,
]);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function checkedBytes(root, name) {
  const path = resolve(root, name);
  if (relative(root, path).split(/[\\/]/u).includes("..")) throw new Error("Desktop branding escaped source root");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe desktop branding directory: ${name}`);
    if (parent === root) break;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 524288) throw new Error(`Unsafe desktop branding file: ${name}`);
  const bytes = await readRegularFile(path);
  if (bytes.length > 524288) throw new Error(`Oversize desktop branding file: ${name}`);
  return bytes;
}

/** Verify the declared conversion of existing artwork before frontend staging.
 * Pixel equivalence is recorded by the converter; this checks those exact bytes,
 * source and native configuration, not installed appearance or art approval. */
export async function verifyDesktopBranding(rootInput) {
  const root = resolve(rootInput);
  const manifest = JSON.parse((await checkedBytes(root, DESKTOP_BRAND_MANIFEST)).toString("utf8"));
  if (manifest.schema !== "editkin.desktop-branding-conversion/v1"
    || manifest.source?.path !== DESKTOP_BRAND_SOURCE
    || manifest.recipe !== "existing-sky-v3-rgba-lanczos-png-ico/v2-largest-frame-first"
    || !Array.isArray(manifest.outputs) || manifest.outputs.length !== DESKTOP_BRAND_FILES.length
    || manifest.outputs.some((entry, index) => entry.path !== DESKTOP_BRAND_FILES[index])) {
    throw new Error("Invalid desktop branding conversion manifest");
  }
  const source = await checkedBytes(root, DESKTOP_BRAND_SOURCE);
  if (source.length !== manifest.source.bytes || digest(source) !== manifest.source.sha256) {
    throw new Error("Desktop branding source identity changed; regenerate its declared conversion");
  }
  let outputBytes = 0;
  for (const entry of manifest.outputs) {
    const bytes = await checkedBytes(root, entry.path);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
      throw new Error(`Desktop branding output identity changed: ${entry.path}`);
    }
    if (entry.path === WINDOWS_BRAND_ICON) assertWindowIconResolutionV1(bytes);
    outputBytes += bytes.length;
  }
  if (outputBytes > 524288) throw new Error("Desktop branding conversion exceeds its aggregate byte budget");
  const config = JSON.parse((await checkedBytes(root, DESKTOP_BRAND_CONFIG)).toString("utf8"));
  const expected = DESKTOP_BRAND_FILES.map(name => name.slice("src-tauri/".length));
  if (JSON.stringify(config.bundle?.icon) !== JSON.stringify(expected)
    || config.bundle?.windows?.nsis?.installerIcon !== WINDOWS_BRAND_ICON.slice("src-tauri/".length)) {
    throw new Error("Desktop branding native/installer icon configuration differs from the conversion");
  }
  return { status: "GREEN_DESKTOP_BRANDING", sourceSha256: manifest.source.sha256,
    nativeIcon: WINDOWS_BRAND_ICON, outputFiles: manifest.outputs.length, outputBytes };
}
