import { symlink } from "node:fs/promises";

/** File links need a Windows privilege that ordinary developer/test tokens may lack. */
export async function createFileSymlinkOrSkip(target: string, path: string, context: { skip: (note?: string) => void }): Promise<void> {
  try { await symlink(target, path, "file"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows test token lacks file symbolic-link privilege; directory-junction guards run separately");
      return;
    }
    throw error;
  }
}
