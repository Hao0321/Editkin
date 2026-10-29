import { useCallback, useEffect, useRef, useState } from "react";
import type { HaoDesktopApi, MobileRemoteNetworkSummary, MobileRemoteResult, MobileRemoteSnapshot, MobileRemoteStartOptions, MobileRemoteStatus } from "./types";
import { remoteProposalNeedsAttention } from "../application/remoteOnboarding";

/** A snapshot that changes without re-rendering its owner (the playhead, PF1): read when needed, told when it changed. */
export interface MobileRemoteSnapshotSource {
  getSnapshot: () => MobileRemoteSnapshot;
  subscribe: (listener: () => void) => () => void;
}

interface MobileRemoteOptions {
  api?: HaoDesktopApi;
  snapshot: MobileRemoteSnapshot | MobileRemoteSnapshotSource;
  onInstruction: (instruction: string) => void;
  onStatus: (message: string) => void;
}

const isSnapshotSource = (value: MobileRemoteSnapshot | MobileRemoteSnapshotSource): value is MobileRemoteSnapshotSource =>
  typeof (value as MobileRemoteSnapshotSource).getSnapshot === "function";

export function useMobileRemote({ api, snapshot: snapshotInput, onInstruction, onStatus }: MobileRemoteOptions) {
  const source = isSnapshotSource(snapshotInput) ? snapshotInput : undefined;
  const snapshot = source ? undefined : snapshotInput as MobileRemoteSnapshot;
  const [remote, setRemote] = useState<MobileRemoteResult>();
  const [remoteStatus, setRemoteStatus] = useState<MobileRemoteStatus>();
  const [networkSummary, setNetworkSummary] = useState<MobileRemoteNetworkSummary>();
  const [showConnect, setShowConnect] = useState(false);
  const instructionRef = useRef(onInstruction);
  const statusRef = useRef(onStatus);
  instructionRef.current = onInstruction;
  statusRef.current = onStatus;

  const start = useCallback(async (options: MobileRemoteStartOptions = {}) => {
    if (!api?.startMobileRemote) return;
    if (remote?.active) {
      setShowConnect(true);
      return;
    }
    try {
      statusRef.current("正在建立一次性 QR 綁定碼…");
      const result = await api.startMobileRemote(source ? source.getSnapshot() : snapshot!, options);
      setRemote(result);
      setRemoteStatus({ active: true, connectedCount: 0, devices: [] });
      setShowConnect(true);
      statusRef.current(result.transport === "lan"
        ? "手機遙控已用預設 LAN 啟動；同 Wi-Fi 可直接配對，不會產生雲端流量費。"
        : "手機遙控已用你自備的跨網路服務啟動；供應商帳號、用量與費用由你直接管理。");
    } catch (error) {
      statusRef.current(error instanceof Error ? `手機遙控啟動失敗：${error.message}` : "手機遙控啟動失敗");
    }
  }, [api, remote?.active, snapshotInput]);

  const open = useCallback(async () => {
    if (!api?.startMobileRemote) return;
    if (remote?.active) {
      if (api.getMobileRemoteNetworkSummary) {
        try { setNetworkSummary(await api.getMobileRemoteNetworkSummary()); }
        catch { /* live Remote remains usable; the modal will show quality as unverified */ }
      }
      setShowConnect(true);
      return;
    }
    if (!api.getMobileRemoteNetworkSummary) {
      await start();
      return;
    }
    try {
      const summary = await api.getMobileRemoteNetworkSummary();
      setNetworkSummary(summary);
      const proposalNeedsAttention = remoteProposalNeedsAttention(summary);
      if (summary.requiresExternalTrafficConsent || proposalNeedsAttention) {
        setShowConnect(true);
        statusRef.current(proposalNeedsAttention
          ? "Remote 方案尚未核准、部署或連線；請先檢查價格、配額、權限與預計異動。"
          : "跨網路 Remote 尚未啟動；請先確認你自己的供應商費用與資料傳輸範圍。");
        return;
      }
      await start();
    } catch (error) {
      statusRef.current(error instanceof Error ? `Remote 設定檢查失敗：${error.message}` : "Remote 設定檢查失敗");
    }
  }, [api, remote?.active, start]);

  const stop = useCallback(async () => {
    try { await api?.stopMobileRemote?.(); }
    finally {
      setRemote(undefined);
      setRemoteStatus(undefined);
      setShowConnect(false);
      statusRef.current("手機遙控已停止；已綁定裝置仍保留，下次啟動會自動重連。");
    }
  }, [api]);

  const revoke = useCallback(async (deviceId: string) => {
    const result = await api?.revokeMobileDevice?.(deviceId);
    if (!result?.revoked) return;
    setRemoteStatus((current) => current ? {
      ...current,
      connectedCount: Math.max(0, current.connectedCount - (current.devices.find((device) => device.id === deviceId)?.connected ? 1 : 0)),
      trustedCount: Math.max(0, (current.trustedCount ?? current.devices.length) - 1),
      devices: current.devices.filter((device) => device.id !== deviceId),
    } : current);
    statusRef.current("已撤銷這台手機；它必須重新掃描 QR 才能連線。");
  }, [api]);

  useEffect(() => {
    const getSummary = api?.getMobileRemoteNetworkSummary;
    if (!showConnect || remote?.active || !getSummary) return;
    let canceled = false;
    const refresh = async () => {
      try {
        const next = await getSummary();
        if (!canceled) setNetworkSummary(next);
      } catch { /* fail closed in start; keep the last non-secret summary while Agent works */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [api, remote?.active, showConnect]);

  useEffect(() => {
    if (!remote?.active || !api?.updateMobileSnapshot) return;
    const desktop = api;
    const send = (value: MobileRemoteSnapshot) => void desktop.updateMobileSnapshot!(value).catch((error) => {
      statusRef.current(error instanceof Error ? `手機狀態同步失敗：${error.message}` : "手機狀態同步失敗");
    });
    if (!source) { send(snapshot!); return; }
    // Each changed snapshot once, as the effect above did for each new snapshot object.
    let last = source.getSnapshot();
    send(last);
    return source.subscribe(() => {
      const next = source.getSnapshot();
      if (next === last) return;
      last = next;
      send(next);
    });
  }, [api, remote?.active, snapshotInput]);

  useEffect(() => {
    const pollCommands = api?.pollMobileCommands;
    if (!remote?.active || !pollCommands) return;
    let canceled = false;
    let busy = false;
    const poll = async () => {
      if (busy || canceled) return;
      busy = true;
      try {
        const commands = await pollCommands();
        if (!canceled) commands.forEach((command) => instructionRef.current(command.instruction));
      } catch (error) {
        if (!canceled) statusRef.current(error instanceof Error ? `手機指令接收失敗：${error.message}` : "手機指令接收失敗");
      } finally { busy = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 400);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [api, remote?.active]);

  useEffect(() => {
    const getStatus = api?.getMobileRemoteStatus;
    if (!remote?.active || !getStatus) return;
    let canceled = false;
    const refresh = async () => {
      try {
        const next = await getStatus();
        if (canceled) return;
        setRemoteStatus(next);
        if (next.url && next.transport) setRemote((current) => current ? { ...current, url: next.url!, transport: next.transport!, warning: next.warning } : current);
        if (!next.active) {
          setRemote(undefined);
          setShowConnect(false);
          statusRef.current("手機遙控服務已停止；請重新啟動配對。");
        }
      } catch { /* a partial devices.json write is transient; the next heartbeat retries */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 750);
    return () => { canceled = true; window.clearInterval(timer); };
  }, [api, remote?.active]);

  return { remote, remoteStatus, networkSummary, showConnect, setShowConnect, open, start, stop, revoke };
}
