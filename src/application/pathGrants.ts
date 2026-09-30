import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

/** Every project file Editkin writes must carry one of these compound extensions. */
export const PROJECT_FILE_PATTERN = /\.(?:editkin|haoedit)\.json$/i;

const MAX_GRANTS = 10_000;

/**
 * Paths the user selected (open/save dialogs) or loaded (a project they opened).
 * A renderer request that names a path outside this set is refused, so a
 * compromised renderer cannot make the main process read or write arbitrary
 * files. Matching is by resolved path, not by realpath, so a grant made before
 * a file exists (a Save As target) still matches.
 */
export class PathGrants {
  private readonly granted = new Set<string>();

  private readonly flavor: typeof posix;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {
    this.flavor = platform === "win32" ? win32 : posix;
  }

  private key(path: string): string {
    const absolute = this.flavor.resolve(path);
    return this.platform === "win32" ? absolute.toLowerCase() : absolute;
  }

  grant(path: string): void {
    const key = this.key(path);
    this.granted.delete(key);
    this.granted.add(key);
    if (this.granted.size > MAX_GRANTS) this.granted.delete(this.granted.values().next().value as string);
  }

  has(path: unknown): boolean {
    return typeof path === "string" && this.flavor.isAbsolute(path) && this.granted.has(this.key(path));
  }

  assertGranted(path: unknown, message: string): asserts path is string {
    if (!this.has(path)) throw new Error(message);
  }
}

export function assertProjectFilePath(path: string): void {
  if (!PROJECT_FILE_PATTERN.test(path)) throw new Error("專案檔必須使用 .editkin.json 或 .haoedit.json 副檔名");
}

export function isWithinRoot(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

/** Absolute media locations a loaded project refers to; browser-only and creative URIs are skipped. */
export function projectMediaPaths(assets: ReadonlyArray<{ uri: string }>): string[] {
  return assets.map((asset) => asset.uri).filter((uri) => isAbsolute(uri));
}
