/**
 * Windows UNC (`\\host\share`), `\\?\UNC\…` and device (`\\.\…`, `\\?\Volume{…}`)
 * paths are absolute, but touching them makes Windows open an SMB connection
 * (and may send NTLM credentials) to a host named by an untrusted project file.
 * The only `\\` form that stays local is a verbatim drive path (`\\?\C:\…`).
 * `\??\` hands the rest of the path to the NT object manager unparsed
 * (`\??\UNC\host\share\…`), so no path with that prefix is local media.
 */
const VERBATIM_DRIVE_PATH = /^\\\\\?\\[A-Za-z]:(?:\\|$)/;

/**
 * Win32 opens a DOS device instead of a file for these names in any letter case,
 * also with trailing spaces (`NUL `) and, before Windows 11, with an extension
 * (`nul.txt`, `NUL .txt`); `:` also ends a name (`C:NUL`). Classic Win32 only
 * maps the final component to a device; every component is checked anyway, a
 * conservative choice that also covers a folder later opened on its own.
 * COM0 and LPT0 are not on Microsoft's current list but are rejected too.
 */
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/;

function hasReservedDeviceName(normalized: string): boolean {
  return normalized.split(/[\\:]/).some((name) =>
    RESERVED_DEVICE_NAME.test(name.split(".", 1)[0].replace(/ +$/, "").toUpperCase()));
}

export function isWindowsNetworkPath(path: string): boolean {
  const normalized = path.replaceAll("/", "\\");
  return (normalized.startsWith("\\\\") && !VERBATIM_DRIVE_PATH.test(normalized))
    || normalized.startsWith("\\??\\")
    || hasReservedDeviceName(normalized);
}

/**
 * `C:\clip.mp4:stream` names an NTFS alternate data stream of `clip.mp4`, not a file: any `:` after the drive
 * prefix (`C:` or the verbatim `\\?\C:`) is one, or an invalid name.
 */
function hasWindowsAlternateStream(path: string): boolean {
  const normalized = path.replaceAll("/", "\\");
  const rest = normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized;
  return (/^[A-Za-z]:/.test(rest) ? rest.slice(2) : rest).includes(":");
}

export type LocalPathProblem = "not_absolute" | "network_or_device" | "alternate_stream";

/**
 * The twin of the desktop host's `local_path_text_problem` (src-tauri/src/main.rs): what keeps a path string from
 * being a plain local absolute path, from its text alone, or undefined when it is one. A network or device form wins
 * over "not absolute" (`\??\…`, `C:NUL`). Absolute follows Rust's Windows rule: a drive with a separator, or a
 * `\\`/`//` prefix (`\foo` and `/foo` are not). Both sides are checked against `localPathVerdicts.json`.
 */
export function localPathTextProblem(path: string, platform: NodeJS.Platform = process.platform): LocalPathProblem | undefined {
  if (platform !== "win32") return path.startsWith("/") ? undefined : "not_absolute";
  if (isWindowsNetworkPath(path)) return "network_or_device";
  if (!/^[A-Za-z]:[\\/]/.test(path) && !/^[\\/]{2}/.test(path)) return "not_absolute";
  if (hasWindowsAlternateStream(path)) return "alternate_stream";
  return undefined;
}

/**
 * Rejects network, NT object and DOS device paths, and NTFS alternate data streams, on Windows (relative paths are
 * left to the caller, as before). Elsewhere `//x`, `NUL` and `a:b` are ordinary POSIX paths, so nothing is rejected.
 * The messages are the desktop host's (media_source_path_check); the stream one must not read as a network drive in
 * plainProblems.ts.
 */
export function assertLocalMediaPath(path: string, platform: NodeJS.Platform = process.platform): void {
  const problem = localPathTextProblem(path, platform);
  if (problem === "network_or_device") {
    throw new Error(`拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：${path}`);
  }
  if (problem === "alternate_stream") {
    throw new Error(`拒絕檔名裡帶冒號的路徑作為媒體來源（這是檔案的隱藏資料串流，不是檔案本身），請改用一般檔名：${path}`);
  }
}
