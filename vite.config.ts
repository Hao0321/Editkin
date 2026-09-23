import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import sourceTestExclusions from "./source-test-exclusions.json";

const nodeTestFiles = [
  "scripts/build-creative-previews.test.mjs",
  "scripts/build-personal-visual-pack.test.mjs",
  "scripts/creative-pack-rights.test.mjs",
  "scripts/font-em-metrics.test.mjs",
  "scripts/font-source-acquisition.test.mjs",
  "scripts/open-source-preflight.test.mjs",
  "scripts/lib/cargo-artifact-path.test.mjs",
  "scripts/lib/cargo-lock-preflight.test.mjs",
  "scripts/lib/desktop-stage-target-policy.test.mjs",
  "scripts/lib/native-shared-inputs.test.mjs",
  "scripts/lib/owned-process-runner.test.mjs",
  "scripts/lib/tauri-candidate-artifact-root.test.mjs",
  "scripts/material-color-runtime-pair.test.mjs",
  "src/shared/visualAssetRights.test.mjs",
];

export default defineConfig(({ command }) => ({
  // Electron/Tauri load the production UI from a file:// URL. Absolute
  // `/assets/*` URLs resolve from the filesystem root and leave a blank
  // window, so every production asset must remain relative to index.html.
  base: "./",
  // Release builds embed only the UI-critical web surface. Large OCIO LUTs
  // and static render faces stay in Tauri/Electron resources and are loaded
  // through bounded desktop commands instead of being duplicated in the EXE.
  publicDir: command === "build" ? ".web-public" : "public",
  plugins: [react()],
  test: {
    // Retained fail-before experiments are replayed explicitly against their
    // captured source; they are not current product regression entry points.
    exclude: [
      ...configDefaults.exclude,
      ".rd/**",
      ...nodeTestFiles,
      ...(process.platform === "win32" ? [] : ["scripts/electron-update-ipc.test.ts"]),
      ...(process.env.EDITKIN_FULL_TESTS === "1" ? [] : sourceTestExclusions.entries.map(row => row.file)),
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom/client", "react/jsx-runtime"],
        },
      },
    },
  },
  server: {
    strictPort: true,
  },
}));
