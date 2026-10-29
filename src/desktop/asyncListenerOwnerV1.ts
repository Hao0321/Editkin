/** Own a Tauri-style async registration; cancel-before-resolution and repeated cancel release once. */
export function ownAsyncListenerV1(register: (callback: () => void) => Promise<() => void>, handler: () => void): () => void {
  let active = true;
  let release: (() => void) | undefined;
  let released = false;
  const releaseOnce = () => { if (release && !released) { released = true; release(); } };
  try {
    void register(() => { if (active) handler(); }).then(unlisten => {
      release = unlisten;
      if (!active) releaseOnce();
    }, () => { active = false; });
  } catch { active = false; }
  return () => { if (!active && released) return; active = false; releaseOnce(); };
}
