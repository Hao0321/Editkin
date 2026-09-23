import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function evaluateIdentity(expected, observations) {
  const failures = [];
  for (const [surface, values] of Object.entries(observations)) {
    if (!Array.isArray(values) || values.length === 0) failures.push({ surface, reason: "missing-version" });
    else if (values.some((value) => value !== expected)) failures.push({ surface, reason: "version-drift", values });
  }
  return { status: failures.length === 0 ? "GREEN" : "BLOCK", expectedVersion: expected, observations, failures };
}

export async function inspectReleaseIdentity(root) {
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
  const packageJson = await json("package.json");
  const packageLock = await json("package-lock.json");
  const tauri = await json("src-tauri/tauri.conf.json");
  const ledger = await json("product-capabilities.json");
  const autopilotLedger = await json("autopilot-capabilities.json");
  const creativePack = await json("src/creative/haoCorePack.json");
  const portableCreativePack = await json(".creative-packs/hao-creator-library/editkin-pack.json");
  const personalMusicPack = await json(".personal-packs/hao-music-library/editkin-personal-music.json");
  const openFontPack = await json("public/fonts/editkin-open-fonts.json");
  const cargo = await readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8");
  const mcp = await readFile(resolve(root, "src/mcp/server.ts"), "utf8");
  return evaluateIdentity(packageJson.version, {
    packageLock: [packageLock.version, packageLock.packages?.[""]?.version],
    tauri: [tauri.version],
    cargo: [cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]].filter(Boolean),
    ledger: [ledger.productVersion, ...ledger.obligations.filter((item) => item.status === "verified").map((item) => item.verifiedVersion)],
    autopilotLedger: [autopilotLedger.productVersion],
    creativePack: [creativePack.version, portableCreativePack.version],
    personalMusicPack: [personalMusicPack.version],
    openFontPack: [openFontPack.version],
    mcp: [...new Set(mcp.match(/\b\d+\.\d+\.\d+\b/g) ?? [])],
  });
}
