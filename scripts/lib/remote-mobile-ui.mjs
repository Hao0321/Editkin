export function assessRemoteMobileUi(evidence) {
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });
  if (!(evidence.pairingReadyMs >= 0 && evidence.pairingReadyMs < 3_000)) fail("pairing-latency", evidence.pairingReadyMs);
  if (!(evidence.commandRoundTripMs >= 0 && evidence.commandRoundTripMs < 1_000)) fail("command-latency", evidence.commandRoundTripMs);
  if (evidence.tokenRemovedFromUrl !== true) fail("bootstrap-token-visible", evidence.tokenRemovedFromUrl);
  if (evidence.reconnectedWithoutQr !== true) fail("permanent-pairing-reconnect", evidence.reconnectedWithoutQr);
  if (evidence.reducedMotion !== true) fail("reduced-motion", evidence.reducedMotion);
  if (evidence.atomicQueueFiles !== 1) fail("atomic-queue", evidence.atomicQueueFiles);
  if (evidence.queuedInstruction !== "復原") fail("queued-instruction", evidence.queuedInstruction);
  if (!Array.isArray(evidence.matrix) || evidence.matrix.length !== 4) fail("viewport-matrix", evidence.matrix?.length);
  for (const item of evidence.matrix ?? []) {
    if (item.viewport?.width !== item.width || item.viewport?.height !== item.height) fail("viewport-identity", item.id);
    if (item.document?.scrollWidth !== item.document?.clientWidth) fail("document-overflow", item.id);
    if (!Array.isArray(item.controls) || item.controls.length < 13) fail("control-count", item.id);
    for (const control of item.controls ?? []) {
      if (control.width < 44 || control.height < 44) fail("touch-target", `${item.id}:${control.name}`);
      if (control.fontSize < 16) fail("input-font", `${item.id}:${control.name}`);
      if (!control.name) fail("accessible-name", `${item.id}:${control.tag}`);
    }
    if (item.quickColumns !== item.columns) fail("quick-grid", item.id);
    if (item.firstScreenActions < 8) fail("first-screen-actions", item.id);
    if (item.finalActionReachable !== true) fail("final-action-unreachable", item.id);
    if ((item.runtimeErrors?.length ?? 0) !== 0) fail("runtime-error", item.id);
    if (item.hash !== "") fail("token-hash-retained", item.id);
    if (item.connected !== true) fail("not-connected", item.id);
  }
  return { status: failures.length === 0 ? "GREEN" : "BLOCK", failures };
}
