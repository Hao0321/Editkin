import type { TimelineThumbnailSource } from "./timelineThumbnailQueue";

export type PreparedTimelineThumbnails = Record<string, { source: string; url: string }>;
interface Dependencies {
  generate: (uri: string, signal: AbortSignal) => Promise<string>;
  revoke: (url: string) => void;
  publish: (prepared: PreparedTimelineThumbnails) => void;
  yield?: () => Promise<void>;
}
interface Lease {
  uri: string;
  abort: AbortController;
  state: "queued" | "running" | "ready" | "failed";
  url?: string;
}

/** Only current visible source URIs own URLs. This is not a media/derivative cache. */
export function createTimelineThumbnailLeases(dependencies: Dependencies) {
  let desired = new Map<string, string>();
  const leases = new Map<string, Lease>();
  const pending = new Map<string, Lease>();
  let disposed = false;
  let pumping: Promise<void> | undefined;
  const nextTurn = dependencies.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));

  const current = (lease: Lease) => !disposed && leases.get(lease.uri) === lease;
  const snapshot = (): PreparedTimelineThumbnails => {
    const prepared: PreparedTimelineThumbnails = Object.create(null);
    for (const [id, uri] of desired) {
      const lease = leases.get(uri);
      if (lease?.url) prepared[id] = { source: uri, url: lease.url };
    }
    return prepared;
  };
  const emit = () => { if (!disposed) dependencies.publish(snapshot()); };
  const release = (lease: Lease) => {
    lease.abort.abort();
    if (lease.url !== undefined) {
      const url = lease.url;
      lease.url = undefined;
      dependencies.revoke(url);
    }
  };

  const drain = async () => {
    while (!disposed && pending.size) {
      const [uri, lease] = pending.entries().next().value!;
      pending.delete(uri);
      await nextTurn();
      if (!current(lease)) continue;
      lease.state = "running";
      let url: string;
      try {
        url = await dependencies.generate(uri, lease.abort.signal);
      } catch {
        if (current(lease)) lease.state = "failed";
        continue;
      }
      if (!current(lease)) {
        dependencies.revoke(url);
        continue;
      }
      lease.url = url;
      lease.state = "ready";
      emit();
    }
  };
  const schedule = (): Promise<void> => {
    if (!pumping) {
      pumping = drain().finally(() => {
        pumping = undefined;
        if (!disposed && pending.size) void schedule();
      });
    }
    return pumping;
  };
  const whenIdle = async (): Promise<void> => {
    // An update may arrive after a drain resolves but before its finally callback.
    // Follow any newly scheduled drain instead of returning an obsolete promise.
    while (pumping) await pumping;
  };

  return {
    update(sources: readonly TimelineThumbnailSource[]): Promise<void> {
      if (disposed) return Promise.resolve();
      desired = new Map(sources.map(source => [source.id, source.uri]));
      const wanted = new Set(desired.values());
      for (const [uri, lease] of leases) {
        if (wanted.has(uri)) continue;
        leases.delete(uri);
        pending.delete(uri);
        release(lease);
      }
      for (const uri of wanted) {
        let lease = leases.get(uri);
        if (!lease) {
          lease = { uri, abort: new AbortController(), state: "queued" };
          leases.set(uri, lease);
          pending.set(uri, lease);
        } else if (lease.state === "failed") {
          // A later visibility update retries an unavailable frame, as the old queue did.
          lease.state = "queued";
          pending.set(uri, lease);
        }
      }
      emit();
      void schedule();
      return whenIdle();
    },
    snapshot,
    whenIdle,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      desired.clear();
      pending.clear();
      for (const lease of leases.values()) release(lease);
      leases.clear();
    },
  };
}

