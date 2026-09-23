// One required source identity for the launcher shared by Tauri and hao-core.
export const NATIVE_SHARED_PROCESS_INPUTS = Object.freeze([
  "native/shared/owned_process.rs",
  "native/shared/owned_process/windows.rs",
  "native/shared/owned_process/unix.rs",
]);

// Both the native producer and its receipt verifier must enumerate this exact
// closure. Adding a launcher/helper dependency must not leave either side stale.
export const NATIVE_CORE_BUILD_INPUT_ROOTS = Object.freeze([
  "scripts/build-native-core.mjs",
  "scripts/lib/cargo-artifact-path.mjs",
  "scripts/lib/native-shared-inputs.mjs",
  "native/hao-core/Cargo.toml",
  "native/hao-core/Cargo.lock",
  "native/hao-core/src",
  "native/shared",
]);
