import { createHash } from "node:crypto";
import { extname } from "node:path";
import { OWNER_VISUAL_GRANT } from "../../src/shared/visualAssetRights.mjs";
import { NATIVE_SHARED_PROCESS_INPUTS } from "./native-shared-inputs.mjs";

// One owner for declared input/output namespaces. Workspace source identities
// remain input-only; shipping paths refer to generated product resources.
export const BUILD_INPUT_PATH_CONTRACT_FILE = "scripts/lib/build-input-path-contract.mjs";

const OWNER_VISUAL_SOURCE_PREFIX = "workspace/community/hao-motion-kit/";
const OWNER_VISUAL_OUTPUT_PREFIX = ".creative-packs/hao-creator-library/";
const ownerVisualOutputs = OWNER_VISUAL_GRANT.assets.flatMap((asset) => {
  const previewKey = createHash("sha256").update(JSON.stringify(asset.id)).digest("hex").slice(0, 20);
  const safeId = asset.id.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return [
    `${OWNER_VISUAL_OUTPUT_PREFIX}assets/${asset.category}/${safeId}${extname(asset.sourcePath).toLowerCase()}`,
    `${OWNER_VISUAL_OUTPUT_PREFIX}previews/${previewKey}/poster.jpg`,
    `${OWNER_VISUAL_OUTPUT_PREFIX}previews/${previewKey}/preview.mp4`,
  ];
});

export const APP_INPUT_ROOTS = [
  "scripts/lib/module-metadata-sync-read-v3.cjs",
  "scripts/lib/module-metadata-source-loader-v3.cjs",
  "scripts/lib/module-metadata-bounded-read-v3.mjs",
  ".build-node-receipt.json",
  "scripts/module-metadata-v2.sources.json",
  "src/modules/moduleMetadataV2.generated.ts",
  "src/modules/moduleMetadataV2.data.json",
  "scripts/lib/module-metadata-format-v3.cjs",
  "scripts/lib/module-metadata-input-contract-v3.cjs",
  "index.html",
  "forge.config.cjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "performance-budgets.json",
  "config/retired-product-surfaces.json",
  "THIRD_PARTY_NOTICES.md",
  "src-tauri/icons",
  "src-tauri/capabilities",
  "src-tauri/remote-relay.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/src",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.android.conf.json",
  "src-tauri/tauri.existing-dev-server.conf.json",
  "src-tauri/tauri.ios.conf.json",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "src/shared/agentSetupContract.json",
  "scripts/editkin-product-mcp-launcher.mjs",
  "public/demo-source.mp4",
  "public/editkin-demo-preview.mp4",
  "public/favicon.svg",
  "public/brand/editkin-symbol-v3-sky.webp",
  "public/brand/editkin-symbol-v3-candy.webp",
  "public/brand/editkin-symbol-v3-volt.webp",
  "public/fonts",
  "public/color/aces2",
  "plugins",
  "native/hao-core/Cargo.toml",
  "native/hao-core/Cargo.lock",
  "native/hao-core/src/engine",
  "native/hao-core/src/lib.rs",
  "native/hao-core/src/main.rs",
  "native/shared",
  "spikes/gpu-compositor/Cargo.toml",
  "spikes/gpu-compositor/Cargo.lock",
  "spikes/gpu-compositor/src",
  "vendor/node/win32-x64",
  "vendor/ffmpeg/win32-x64",
  "vendor/whisper/win32-x64",
  ".personal-packs/hao-music-library/COMMUNITY-ASSET-GRANT.md",
  BUILD_INPUT_PATH_CONTRACT_FILE,
];

export const PRODUCT_MODULE_ENTRYPOINTS = [
  "src/main.tsx",
  "electron/main.ts",
  "electron/preload.ts",
  "src/mcp/server.ts",
  "src/service/cli.ts",
  "src/remote/server.ts",
];

export const PRODUCT_PIPELINE_SCRIPT_ENTRYPOINTS = [
  "scripts/editkin-mcp-generation-preflight-worker.mjs",
  "scripts/tauri-frontend.mjs",
  "scripts/tauri-build.mjs",
  "scripts/tauri-build-isolation-runner.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/product-agent-connect-delivery-gate.mjs",
  "scripts/build-native-core.mjs",
  "scripts/build-gpu-compositor.mjs",
  "scripts/build-creative-pack.mjs",
  "scripts/archive-creative-pack.mjs",
  "scripts/build-personal-music-pack.mjs",
  "scripts/personal-music-pack-gate.mjs",
  "scripts/generate-sbom.mjs",
  "scripts/bundle-size-gate.mjs",
  "scripts/build-web-public.mjs",
  "scripts/build-desktop.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/stage-platform-runtime.mjs",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "scripts/product-release-manifest-policy-gate.mjs",
  "scripts/auto-roto-native-product-artifact-freshness-gate.ts",
  "scripts/artifact-lifecycle-gate.mjs",
  "scripts/security-hardening-gate.mjs",
  "scripts/macos-bundle-runtime-gate.mjs",
  "scripts/editkin-skill-pack-gate.ts",
  "scripts/editkin-mcp-generation-launcher.mjs",
  "scripts/editkin-product-mcp-launcher.mjs",
  "scripts/activate-editkin-mcp-generation.mjs",
  "scripts/editkin-mcp-generation-self-test.mjs",
  "scripts/update-channel.mjs",
  "scripts/retired-product-surfaces-gate.mjs",
];

export const WORKSPACE_INPUT_ROOTS = [
  "community/hao-motion-kit",
  "assets/bgm",
  "video-autopilot-kit/knowledge/runtime/filter_library.json",
];

export const PRODUCT_REQUIRED_INPUT_PATHS = Object.freeze([
  "scripts/lib/module-metadata-sync-read-v3.cjs",
  "scripts/lib/module-metadata-source-loader-v3.cjs",
  "scripts/lib/module-metadata-bounded-read-v3.mjs",
  "scripts/lib/module-metadata-input-contract-v3.cjs",
  "scripts/module-metadata-v2.sources.json",
  "src/modules/moduleMetadataV2.generated.ts",
  "src/modules/moduleMetadataV2.data.json",
  "scripts/lib/module-metadata-format-v3.cjs",
  "scripts/refresh-module-metadata-v2.cjs",
  ...NATIVE_SHARED_PROCESS_INPUTS,
  "scripts/lib/native-shared-inputs.mjs",
  "src/application/autoRotoNativeProduct.ts",
  "src/application/autoRotoProductContract.ts",
  "src/domain/autoRotoPreviewProjection.ts",
  "src/domain/autoRotoProductReceipt.ts",
  "src/render/autoRotoMatteIntegrity.ts",
  "src/service/autoRotoServiceArtifact.ts",
  "src/service/cli.ts",
  "src/application/updateManager.ts",
  "src/application/updateCache.ts",
  "src/shared/updateVersion.mjs",
  "src/shared/updateVersion.d.mts",
  "src/shared/visualAssetRights.mjs",
  "src/shared/visualAssetRights.d.mts",
  `${OWNER_VISUAL_SOURCE_PREFIX}OWNER_VISUAL_GRANT.json`,
  `${OWNER_VISUAL_SOURCE_PREFIX}OWNER_VISUAL_BUNDLE_GRANT.md`,
  ...OWNER_VISUAL_GRANT.assets.map((asset) => `${OWNER_VISUAL_SOURCE_PREFIX}${asset.sourcePath}`),
  "scripts/update-channel.mjs",
  "native/hao-core/src/engine/auto_roto.rs",
  "src-tauri/src/main.rs",
  "scripts/build-native-core.mjs",
  "scripts/build-tauri-product-binary.mjs",
  "scripts/product-agent-connect-delivery-gate.mjs",
  "scripts/build-release-input-manifest.mjs",
  "scripts/tauri-build.mjs",
  "scripts/lib/build-input-identity.mjs",
  "scripts/lib/desktop-stage-target-policy.mjs",
  "scripts/lib/desktop-stage-target-policy.d.mts",
  "scripts/lib/tauri-product-feature-policy.mjs",
  "scripts/lib/tauri-candidate-artifact-root.mjs",
  "scripts/lib/tauri-candidate-artifact-root.d.mts",
  "scripts/lib/tauri-stage-target-policy.mjs",
  "scripts/product-release-manifest-policy-gate.mjs",
  "scripts/auto-roto-native-product-artifact-freshness-gate.ts",
  "scripts/artifact-lifecycle-gate.mjs",
  "scripts/security-hardening-gate.mjs",
  "scripts/macos-bundle-runtime-gate.mjs",
  "scripts/editkin-skill-pack-gate.ts",
  "scripts/editkin-mcp-generation-launcher.mjs",
  "scripts/editkin-product-mcp-launcher.mjs",
  "scripts/activate-editkin-mcp-generation.mjs",
  "scripts/editkin-mcp-generation-self-test.mjs",
  "scripts/editkin-mcp-generation-preflight-worker.mjs",
  "scripts/lib/editkin-mcp-generation-contract.mjs",
  "scripts/lib/editkin-mcp-generation-preflight.mjs",
  "scripts/lib/editkin-mcp-generation-snapshot.mjs",
  "scripts/lib/editkin-mcp-generation-runtime.mjs",
  "scripts/lib/editkin-mcp-generation-test-harness.mjs",
  "scripts/retired-product-surfaces-gate.mjs",
  "config/retired-product-surfaces.json",
  "scripts/stage-tauri-resources.mjs",
  "scripts/stage-desktop-resources.mjs",
  "forge.config.cjs",
  BUILD_INPUT_PATH_CONTRACT_FILE,
]);

export const PRODUCT_REQUIRED_OUTPUT_PATHS = Object.freeze([
  "desktop-dist/main.mjs",
  "desktop-dist/preload.cjs",
  "desktop-dist/mcp.mjs",
  "desktop-dist/mcp.mjs.material-color-identity.json",
  "desktop-dist/service.mjs",
  "desktop-dist/remote.mjs",
  ".creative-packs/hao-creator-library/editkin-pack.json",
  `${OWNER_VISUAL_OUTPUT_PREFIX}${OWNER_VISUAL_GRANT.document.path}`,
  ...ownerVisualOutputs,
  ".personal-packs/hao-music-library/editkin-personal-music.json",
  "release/editkin.spdx.json",
  "release/THIRD_PARTY_NOTICES.md",
]);

export const RESEARCH_ONLY_EXACT_PATHS = new Set([
  "src/application/autoRoto.ts",
  "src/application/autoRotoModelRouter.ts",
  "src/application/autoRotoProductBoundary.ts",
  "src/application/autoRotoVideoModel.ts",
  "src/application/autoRotoVideoPack.ts",
  "native/hao-core/src/engine/auto_roto_onnx.rs",
  "native/hao-core/src/bin/adaptive_optical_alpha_benchmark.rs",
  "native/hao-core/src/bin/optical_alpha_benchmark.rs",
  "native/hao-core/src/bin/region_memory_roto_benchmark.rs",
]);

// Product capability evidence is release governance, not executable runtime
// input. Keeping it outside the product byte identity prevents an impossible
// manifest -> gate report -> ledger -> manifest hash cycle.
export const EVIDENCE_ONLY_EXACT_PATHS = new Set(["product-capabilities.json"]);

export function outputPaths() {
  const runtime = process.platform === "win32"
    ? [
        "native/bin/win32-x64/hao-core.exe",
        "native/bin/win32-x64/editkin-gpu-compositor.exe",
        "vendor/node/win32-x64",
        "vendor/ffmpeg/win32-x64",
        "vendor/whisper/win32-x64",
      ]
    : [".platform-runtime"];
  return [
    "dist",
    "desktop-dist",
    ".creative-packs/hao-creator-library",
    ".personal-packs/hao-music-library",
    "release/editkin.spdx.json",
    "release/THIRD_PARTY_NOTICES.md",
    ...runtime,
  ];
}

