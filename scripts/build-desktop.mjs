import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { buildMaterialColorBundle } from "./lib/material-color-bundle-identity.mjs";

const production = {
  minify: true,
  sourcemap: false,
  legalComments: "none",
};

// A source-only desktop smoke needs the real service, not owner release assets.
const community = process.argv.includes("--community");
// A portable community app bundle also needs the self-authored MCP and Remote
// entrypoints its release runtime resolves. Owner release inputs stay excluded.
const communityEntrypoints = community && process.argv.includes("--with-mcp-and-remote");

await Promise.all([
  "desktop-dist/main.mjs.map",
  "desktop-dist/preload.cjs.map",
  "desktop-dist/mcp.mjs.map",
  "desktop-dist/service.mjs.map",
  "desktop-dist/remote.mjs.map",
].map((path) => rm(path, { force: true })));

if (!community) {
  await build({
    entryPoints: ["electron/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "desktop-dist/main.mjs",
    external: ["electron"],
    ...production,
  });

  await build({
    entryPoints: ["electron/preload.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "desktop-dist/preload.cjs",
    external: ["electron"],
    ...production,
  });
}

if (!community || communityEntrypoints) {
  await buildMaterialColorBundle({
    entryPoints: ["src/mcp/server.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "desktop-dist/mcp.mjs",
    ...production,
  });
}

await build({
  entryPoints: ["src/service/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "desktop-dist/service.mjs",
  define: {
    __EDITKIN_AUTO_ROTO_SERVICE_ARTIFACT_KIND__: JSON.stringify("product"),
  },
  ...production,
});

if (!community || communityEntrypoints) {
  await build({
    entryPoints: ["src/remote/server.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: "desktop-dist/remote.mjs",
    ...production,
  });
}

if (!community) {
  await import("./build-release-input-manifest.mjs");
}
