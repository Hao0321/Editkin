/** `<app>/.rd/tmp`: repository-local scratch parent used by decoder-heavy tests. */
export declare const REPO_TMP: string;
/** Set to a folder to keep every test temp root (each is then created under that folder). */
export declare const EVIDENCE_ENV: "EDITKIN_TEST_EVIDENCE_ROOT";

export interface TempRootOptions {
  /** Folder that receives the root; defaults to the OS temp folder. */
  parent?: string;
  /** Environment variable that, when set to a folder, keeps the root there as evidence. */
  keepEnv?: string;
  /** Keep the root in place (only for an explicitly requested run that refers to it afterwards). */
  keep?: boolean;
}

export interface TempRoot {
  path: string;
  kept: boolean;
  remove(): Promise<void>;
}

export declare function createTempRoot(prefix: string, options?: TempRootOptions): Promise<TempRoot>;
/** Deletes a folder tree, unlinking every symlink/junction as a link first. */
export declare function removeTempRoot(path: string): Promise<void>;
/**
 * Module scope. Under vitest (no argument) roots are removed when their test finishes
 * (beforeAll roots in afterAll); under node:test pass its `after` hook.
 */
export declare function useTempRoots(after?: (cleanup: () => Promise<void>) => unknown): {
  create(prefix: string, options?: TempRootOptions): Promise<string>;
};
