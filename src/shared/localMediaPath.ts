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
 * Rejects network, NT object and DOS device paths on Windows. Elsewhere `//x`
 * and `NUL` are ordinary POSIX paths, so nothing is rejected.
 */
export function assertLocalMediaPath(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && isWindowsNetworkPath(path)) {
    throw new Error(`拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：${path}`);
  }
}
