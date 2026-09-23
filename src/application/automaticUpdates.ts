export interface AutomaticUpdateResult {
  status: string;
  message: string;
}

export interface AutomaticUpdateOptions {
  check: () => Promise<AutomaticUpdateResult>;
  onResult: (result: AutomaticUpdateResult) => void;
  onError?: (error: unknown) => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

export function startAutomaticUpdateChecks(options: AutomaticUpdateOptions): () => void {
  const initialDelayMs = options.initialDelayMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1_000;
  if (initialDelayMs < 0 || intervalMs < 1_000) throw new Error("自動更新排程間隔不合法");
  let stopped = false;
  let busy = false;
  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const result = await options.check();
      if (!stopped) options.onResult(result);
    } catch (error) {
      if (!stopped) options.onError?.(error);
    } finally {
      busy = false;
    }
  };
  const initial = setTimeout(() => void check(), initialDelayMs);
  const interval = setInterval(() => void check(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
