/** One running metadata read plus one coalesced trailing request; no project data is stored here. */
export function createProjectMetadataCheck() {
  type Work = (isCurrent: () => boolean) => Promise<void>;
  type Request = { epoch: number; work: Work; promise: Promise<void>; finish: () => void };
  let epoch = 0;
  let running: Request | undefined;
  let pending: Request | undefined;

  const make = (work: Work): Request => {
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    return { epoch, work, promise, finish };
  };
  const launch = (request: Request) => {
    running = request;
    void (async () => {
      try { await request.work(() => running === request && request.epoch === epoch); }
      catch { /* Metadata observers preserve their existing best-effort error policy. */ }
      finally {
        running = undefined;
        request.finish();
        const next = pending;
        pending = undefined;
        if (next?.epoch === epoch) launch(next);
        else next?.finish();
      }
    })();
  };

  return {
    request(work: Work): Promise<void> {
      if (!running) {
        const next = make(work);
        launch(next);
        return next.promise;
      }
      if (pending?.epoch === epoch) {
        pending.work = work;
        return pending.promise;
      }
      pending?.finish();
      pending = make(work);
      return pending.promise;
    },
    /** Revoke publication and queued work. A host read without AbortSignal must still settle normally. */
    invalidate(): void {
      epoch++;
      pending?.finish();
      pending = undefined;
    },
    status(): Readonly<{ running: boolean; pending: boolean }> {
      return { running: Boolean(running), pending: Boolean(pending) };
    },
  };
}
