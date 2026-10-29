import type { ModuleRuntimeAdapterV2 } from "./moduleTypes";

export type ModuleAdapterLoaderTableV2 = Readonly<Record<string, () => Promise<ModuleRuntimeAdapterV2>>>;
/** One shared import per id; a cancelled waiter never cancels other callers or poisons the cache. */
export function createModuleLazyLoaderV2(loaders: ModuleAdapterLoaderTableV2) {
  const pending = new Map<string, Promise<ModuleRuntimeAdapterV2>>();
  function load(id: string): Promise<ModuleRuntimeAdapterV2> {
    const found = pending.get(id);
    if (found) return found;
    // Own-property admission makes __proto__/constructor/path injection incapable of choosing a loader.
    if (!Object.hasOwn(loaders, id)) return Promise.reject(Error(`MODULE_ADAPTER_UNAVAILABLE:${id}`));
    const promise = Promise.resolve().then(() => loaders[id]()).then(adapter => {
      if (!adapter || typeof adapter.prepare !== "function") throw Error(`MODULE_ADAPTER_INVALID:${id}`);
      return adapter;
    });
    pending.set(id, promise);
    void promise.catch(() => { if (pending.get(id) === promise) pending.delete(id); });
    return promise;
  }
  return async (id: string, signal?: AbortSignal): Promise<ModuleRuntimeAdapterV2> => {
    signal?.throwIfAborted();
    const promise = load(id);
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      let listening = true;
      const aborted = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => { if (listening) { listening = false; signal.removeEventListener("abort", aborted); } };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      void promise.then(adapter => { cleanup(); if (signal.aborted) reject(signal.reason); else resolve(adapter); }, error => { cleanup(); reject(error); });
    });
  };
}
