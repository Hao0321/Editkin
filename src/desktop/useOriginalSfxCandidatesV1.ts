import { useCallback, useEffect, useRef, useState } from "react";
import type { HaoDesktopApi } from "./apiTypes";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";
import { assertOriginalSfxCandidateSummaryV1, mergeOriginalSfxCandidatesV1, type OriginalSfxCandidateSummaryV1 } from "../domain/originalSfxCandidateContractV1";
import { translateUi } from "../ui/i18n/interfacePreferences";
interface Scope { api?: HaoDesktopApi; pending?: Promise<void>; reply?: OriginalSfxCandidateSummaryV1 }
export function useOriginalSfxCandidatesV1(api: HaoDesktopApi | undefined, base: CreativeLibrarySummary | undefined, onStatus: (message: string) => void) {
  const scope = useRef<Scope>({ api }), mounted = useRef(true), [bound, setBound] = useState<{ api: HaoDesktopApi; reply: OriginalSfxCandidateSummaryV1 }>(), [busy, setBusy] = useState<HaoDesktopApi>();
  const merged = useRef<{ base?: CreativeLibrarySummary; reply?: OriginalSfxCandidateSummaryV1; displayed?: CreativeLibrarySummary }>({});
  if (scope.current.api !== api) scope.current = { api };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; scope.current = {}; }; }, []);
  const load = useCallback(async () => {
    if (!api?.listOriginalSfxCandidates || !mounted.current || scope.current.api !== api) return;
    const owner = scope.current;
    if (owner.reply) return; if (owner.pending) return owner.pending;
    setBusy(api);
    const current = () => mounted.current && scope.current === owner && owner.api === api;
    const run = (async () => {
      try {
        const reply = await api.listOriginalSfxCandidates!(); assertOriginalSfxCandidateSummaryV1(reply);
        if (!current()) return; owner.reply = reply; setBound({ api, reply });
      } catch { if (current()) onStatus(translateUi("原創音效載入失敗，請稍後重試。")); }
      finally { if (current()) setBusy(undefined); }
    })();
    owner.pending = run; try { await run; } finally { if (owner.pending === run) owner.pending = undefined; }
  }, [api, onStatus]);
  const reply = bound && bound.api === api ? bound.reply : undefined;
  if (merged.current.base !== base || merged.current.reply !== reply) merged.current = { base, reply, displayed: mergeOriginalSfxCandidatesV1(base, reply) };
  return { library: merged.current.displayed, loading: busy === api && Boolean(api), load: api?.listOriginalSfxCandidates ? load : undefined };
}
