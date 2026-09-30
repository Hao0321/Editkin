/**
 * Windows UNC (`\\host\share`), `\\?\UNC\…` and device (`\\.\…`, `\\?\Volume{…}`)
 * paths are absolute, but touching them makes Windows open an SMB connection
 * (and may send NTLM credentials) to a host named by an untrusted project file.
 * The only `\\` form that stays local is a verbatim drive path (`\\?\C:\…`).
 */
const VERBATIM_DRIVE_PATH = /^\\\\\?\\[A-Za-z]:(?:\\|$)/;

export function isWindowsNetworkPath(path: string): boolean {
  const normalized = path.replaceAll("/", "\\");
  return normalized.startsWith("\\\\") && !VERBATIM_DRIVE_PATH.test(normalized);
}

/**
 * Rejects network and device paths on Windows. Elsewhere `//x` is an ordinary
 * POSIX path, so nothing is rejected.
 */
export function assertLocalMediaPath(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && isWindowsNetworkPath(path)) {
    throw new Error(`拒絕網路共用或裝置路徑作為媒體來源，請先複製到本機磁碟：${path}`);
  }
}
