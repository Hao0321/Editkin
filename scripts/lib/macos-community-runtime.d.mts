export const COMMUNITY_NODE: Readonly<{ version: string; archive: string; url: string; sha256: string }>;
export const COMMUNITY_WHISPER_CPP: Readonly<{
  version: string;
  tag: string;
  commit: string;
  sourceUrl: string;
  archiveBytes: number;
  archiveSha256: string;
  license: string;
}>;
export const COMMUNITY_FFMPEG: Readonly<{
  version: string;
  archive: string;
  urls: readonly string[];
  bytes: number;
  sha256: string;
  signingKeyFingerprint: string;
  license: string;
}>;
export const COMMUNITY_FONTTOOLS: Readonly<{
  version: string;
  wheel: string;
  url: string;
  bytes: number;
  sha256: string;
  minimumPython: readonly number[];
}>;
export const COMMUNITY_FFMPEG_HOMEBREW_FORMULAE: readonly string[];
export const COMMUNITY_DEPLOYMENT_TARGET: string;
export const COMMUNITY_FFMPEG_CONFIGURE_ARGS: readonly string[];
export const REQUIRED_FFMPEG_CONFIG_SYMBOLS: readonly string[];
export const REQUIRED_FFMPEG_ENCODERS: readonly string[];
export const REQUIRED_FFMPEG_DECODERS: readonly string[];
export const REQUIRED_FFMPEG_FILTERS: readonly string[];
export const REQUIRED_FFMPEG_DEVICES: readonly string[];
export const REQUIRED_FFMPEG_MUXERS: readonly string[];
export const REQUIRED_FFMPEG_DEMUXERS: readonly string[];
export const REQUIRED_FFMPEG_CONFIGURATION_FLAGS: readonly string[];
export const COMMUNITY_OMITTED_RUNTIME_FILES: readonly string[];
export const PLATFORM_RUNTIME_FILES: readonly string[];
export const RUNTIME_EXECUTABLES: readonly string[];
export const COMMUNITY_FONT_PACK_DIRECTORY: string;
export const APP_RUNTIME_ENTRYPOINTS: readonly string[];

/** One thin Mach-O as parsed from `otool -l`. */
export interface MachOLoadCommands {
  id: string | undefined;
  dependencies: string[];
  rpaths: string[];
  minimumMacOS: string | undefined;
}
export interface LoaderPathEdit {
  source: string;
  role: "root" | "library";
  name: string | undefined;
  id: string | undefined;
  changes: [string, string][];
  deleteRpaths: string[];
}
export interface FontPackFile {
  bytes: number;
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array | string): string;
export function whisperCliHasRequiredCapabilities(helpText: string): boolean;
export function requiredWhisperFlags(): string[];
export function isMachO(header: Uint8Array | null | undefined): boolean;
export function parseLipoArchitectures(text: string): string[];
export function parseMachOLoadCommands(text: string): MachOLoadCommands;
export function compareMacOSVersions(left: string, right: string): number;
export function maxMacOSVersion(versions: readonly (string | null | undefined)[]): string | undefined;
export function isSystemInstallName(name: string): boolean;
export function forbiddenReferenceReasons(name: string, buildRoots?: readonly string[]): string[];
export function auditBundledMachO(input: {
  file: string;
  bundleRoot: string;
  loadCommands: MachOLoadCommands;
  exists: (path: string) => boolean;
  buildRoots?: readonly string[];
}): string[];
export function escapeFilterOptionPath(path: string): string;
export function isInside(root: string, candidate: string): boolean;
export function dependencyCandidates(
  dependency: string,
  context: { loaderDirectory: string; executableDirectory: string; rpaths: readonly string[] },
): string[];
export function planLoaderPathClosure(input: {
  roots: readonly string[];
  inspect: (path: string) => Promise<MachOLoadCommands>;
  realpath: (path: string) => Promise<string | undefined>;
}): Promise<{
  libraries: { name: string; source: string; installNames: string[] }[];
  edits: LoaderPathEdit[];
}>;
export function installNameToolArguments(edit: Pick<LoaderPathEdit, "id" | "changes" | "deleteRpaths">): string[];
export function parseCodecList(text: string): Set<string>;
export function parseFilterList(text: string): Set<string>;
export function parseFormatList(text: string): Set<string>;
export function missingNames(required: readonly string[], available: ReadonlySet<string>): string[];
export function ffmpegVersionLine(text: string): string;
export function ffmpegConfigurationLine(text: string): string;
export function enabledConfigSymbols(configHeader: string): Set<string>;
export function homebrewKegFromPath(path: string): { prefix: string; formula: string; version: string; kegRoot: string } | undefined;
export function isHomebrewLicenseFile(name: string): boolean;
export function parseDyldPrintedLibraries(text: string): string[];
export function disallowedLoadedImages(paths: readonly string[], allowedRoots: readonly string[]): string[];
export function fontPackFindings(manifest: unknown, files: Readonly<Record<string, FontPackFile | undefined>>): string[];
export function effectiveMinimumMacOS(declared: string, measured: string | null | undefined): string;
