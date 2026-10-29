import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/**
 * Declared TEMP/TMP for helper processes (FFmpeg/ffprobe) started inside one operation, without touching process.env.
 *
 * The source-clock speed cache requires its helper processes to use a temporary root on the project volume. A desktop or
 * MCP host usually runs with TEMP on the system drive, so the export hook declares an owned helper root here instead, and
 * the helper spawn sites pass `helperProcessEnvironmentV1()` as their environment. Outside such an operation it returns
 * undefined and every spawn inherits the process environment exactly as before.
 */
const store = new AsyncLocalStorage<Readonly<{ root: string; env: NodeJS.ProcessEnv }>>();

export function withHelperTemporaryRootV1<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(root);
  return store.run(Object.freeze({ root: absolute, env: { ...process.env, TEMP: absolute, TMP: absolute } }), operation);
}

/** Pass as `env` to a helper spawn; undefined = inherit process.env (no declared root). */
export function helperProcessEnvironmentV1(): NodeJS.ProcessEnv | undefined {
  return store.getStore()?.env;
}

/** The declared helper root of the current operation, if any. */
export function declaredHelperTemporaryRootV1(): string | undefined {
  return store.getStore()?.root;
}
