export declare const MAX_UPDATE_VERSION_LENGTH = 256;

export interface ParsedUpdateVersion {
  core: [string, string, string];
  prerelease: string[];
  build: string[];
}

export declare function parseUpdateVersion(value: unknown, label?: string): ParsedUpdateVersion;
export declare function compareUpdateVersions(left: string, right: string): -1 | 0 | 1;
