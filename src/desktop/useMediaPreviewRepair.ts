import { useRef, useState } from "react";
import type { ProjectSession } from "../application/projectSession";
import type {
  HaoDesktopApi,
  PrepareMediaResult,
} from "./types";
import type { MediaAsset } from "../domain/types";
import { isMediaPreviewCurrent } from "../application/mediaDerivativeColor";
export interface PreviewRepairState {
  assetId: string;
  sessionId: number;
  phase: "preparing" | "failed" | "prepared";
  message: string;
  operationId: number;
  previewUrl?: string;
  isCurrent?: () => boolean;
}
export function useMediaPreviewRepair(
  api: HaoDesktopApi | undefined,
  session: ProjectSession,
  onPrepared: (items: PrepareMediaResult[], isCurrent?: () => boolean) => void,
) {
  const operation = useRef(0),
    pending = useRef<{ sessionId: number; operationId: number } | undefined>(undefined),
    [state, setState] = useState<PreviewRepairState>();
  const repair = async (assetId: string) => {
    if (!api) return;
    const initial = session.getSnapshot(),
      asset = initial.history.present.assets.find((a) => a.id === assetId);
    if (
      !asset ||
      asset.kind !== "video" ||
      pending.current?.sessionId === initial.sessionId
    )
      return;
    const operationId = ++operation.current;
    const submitted = structuredClone(asset),
      previousDerivatives = JSON.stringify(asset.derivatives);
    const evidence = (value: MediaAsset) => {
      const { derivatives, ...source } = value;
      return JSON.stringify(source);
    };
    const binding = evidence(submitted);
    let committedDerivatives: string | undefined;
    const current = () =>
      operation.current === operationId &&
      session.isCurrentSession(initial.sessionId) &&
      session
        .getSnapshot()
        .history.present.assets.some(
          (a) =>
            a.id === assetId &&
            evidence(a) === binding &&
            (committedDerivatives === undefined ||
              JSON.stringify(a.derivatives) === committedDerivatives),
        );
    const update = (phase: PreviewRepairState["phase"], message: string) => {
      if (current())
        setState({
          assetId,
          sessionId: initial.sessionId,
          phase,
          message,
          operationId,
        });
    };
    pending.current = { sessionId: initial.sessionId, operationId };
    update("preparing", "正在重建這份素材的預覽，原片與既有剪輯不變。");
    try {
      const prepared = await api.prepareMedia(submitted);
      if (!current()) return;
      const live = session
        .getSnapshot()
        .history.present.assets.find((a) => a.id === assetId)!;
      if (JSON.stringify(live.derivatives) !== previousDerivatives) {
        update("failed", "素材預覽資料已由其他操作更新，未覆蓋；請重試。");
        return;
      }
      if (
        prepared.assetId !== assetId ||
        !prepared.derivatives ||
        !/^[a-f0-9]{64}$/i.test(prepared.derivatives.sourceSha256) ||
        !prepared.derivatives.proxyUri ||
        !isMediaPreviewCurrent(prepared.derivatives) ||
        typeof prepared.runtimeUrls?.[assetId] !== "string" ||
        !prepared.runtimeUrls[assetId].trim()
      )
        throw Error("預覽準備結果缺少正確素材身分、目前版本或可用網址");
      if (
        submitted.derivatives?.sourceSha256 &&
        submitted.derivatives.sourceSha256 !== prepared.derivatives.sourceSha256
      )
        throw Error("原片內容已變更，不能把新內容的代理套回既有剪輯");
      const keys = new Set([
        assetId,
        ...["source", "proxy", "overlay-proxy", "thumbnail", "waveform"].map(
          (s) => assetId + ":" + s,
        ),
      ]);
      if (Object.keys(prepared.runtimeUrls).some((k) => !keys.has(k)))
        throw Error("預覽結果含其他素材網址，已拒絕套用");
      onPrepared([prepared], current);
      committedDerivatives = JSON.stringify(prepared.derivatives);
      if (current())
        setState({
          assetId,
          sessionId: initial.sessionId,
          phase: "prepared",
          operationId,
          previewUrl: prepared.runtimeUrls[assetId],
          isCurrent: current,
          message:
            "預覽已重建，正在等待播放器解碼。若仍失敗可再重試；未改動剪輯內容。",
        });
    } catch (error) {
      update("failed", error instanceof Error ? error.message : String(error));
    } finally {
      if (pending.current?.operationId === operationId)
        pending.current = undefined;
      // Settlement releases only this operation. Stale source evidence must not
      // leave its visible state stuck, or erase a newer session/operation state.
      if (
        operation.current === operationId &&
        session.isCurrentSession(initial.sessionId) &&
        !current()
      ) {
        setState((previous) =>
          previous?.operationId === operationId &&
          previous.sessionId === initial.sessionId
            ? undefined
            : previous,
        );
      }
    }
  };
  return {
    repairPreview: repair,
    previewRepair:
      state?.sessionId === session.getSnapshot().sessionId ? state : undefined,
  };
}
