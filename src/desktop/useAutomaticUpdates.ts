import { useEffect } from "react";
import { startAutomaticUpdateChecks } from "../application/automaticUpdates";
import type { UpdateCheckResult } from "./types";

export function useAutomaticUpdates(
  check: ((options?: { download?: boolean }) => Promise<UpdateCheckResult>) | undefined,
  notify: (message: string) => void,
): void {
  useEffect(() => {
    if (!check) return;
    return startAutomaticUpdateChecks({
      check: () => check({ download: false }),
      onResult: (result) => {
        document.documentElement.dataset.updateCheck = result.status;
        if (result.status === "ready") notify(`${result.message} 按「更新」即可安裝。`);
        if (result.status === "available") notify(`${result.message} 按「更新」後才會下載，不影響目前剪輯。`);
      },
      onError: () => { document.documentElement.dataset.updateCheck = "error"; },
    });
  }, [check, notify]);
}
