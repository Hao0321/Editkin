import { spawnSync } from "node:child_process";

// Node 22+ exposes WebSocket globally. The optional Undici fallback keeps the
// local evaluator usable on the older Node 20 runtime present on some hosts,
// without making a transitive package mandatory for supported runtimes.
const WebSocket = globalThis.WebSocket ?? (await import("undici")).WebSocket;

export const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function createTauriCdpHarness({
  child,
  port,
  startupPollMs,
  startupInteractiveTimeoutMs,
  startupInteractiveAttempts,
}) {
  let connection;
  let connectionUrl;
  let nextId = 0;
  let childClosed = child.exitCode !== null;
  let childSpawnError;
  const pending = new Map();
  let resolveChildClose;
  const childClose = new Promise((resolvePromise) => { resolveChildClose = resolvePromise; });
  child.once("error", (error) => { childSpawnError = error; });
  child.once("close", () => {
    childClosed = true;
    resolveChildClose();
  });
  if (childClosed) resolveChildClose();
  async function waitForChildExit(timeoutMs) {
    if (childClosed) return true;
    let timer;
    const timedOut = new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    });
    const closed = childClose.then(() => true);
    const result = await Promise.race([closed, timedOut]);
    clearTimeout(timer);
    return result;
  }
  async function stopOwnedApplication() {
    if (childClosed) return;
    child.kill();
    if (await waitForChildExit(5_000)) return;
    if (process.platform === "win32" && child.pid) {
      const terminated = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      if (terminated.error) throw new Error(`Could not terminate owned Tauri process ${child.pid}: ${terminated.error.message}`);
    } else if (process.platform !== "win32") {
      child.kill("SIGKILL");
    }
    if (!await waitForChildExit(5_000)) throw new Error(`Owned Tauri process ${child.pid ?? "unknown"} did not close`);
  }

  async function target() {
    for (let attempt = 0; attempt < startupInteractiveAttempts; attempt += 1) {
      if (childSpawnError) {
        throw new Error(`Tauri process failed to start: ${childSpawnError.message}`, { cause: childSpawnError });
      }
      if (childClosed || child.exitCode !== null) {
        throw new Error(`Tauri process exited before WebView2 debug target started (exit ${child.exitCode ?? "none"}, signal ${child.signalCode ?? "none"})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(Math.max(1_000, startupPollMs * 2)) });
        if (response.ok) {
          const targets = await response.json();
          const pages = targets.filter((item) => item.type === "page");
          const page = pages.find((item) => /^https?:\/\/tauri\.localhost\//.test(item.url ?? ""))
            ?? pages.find((item) => item.url && item.url !== "about:blank");
          if (page) return page;
        }
      } catch { /* WebView2 is still starting. */ }
      await delay(startupPollMs);
    }
    throw new Error(`Tauri WebView2 debug target did not start within ${startupInteractiveTimeoutMs}ms`);
  }

  async function persistentSocket(webSocketDebuggerUrl) {
    if (connection?.readyState === WebSocket.OPEN && connectionUrl === webSocketDebuggerUrl) return connection;
    if (connection) connection.close();
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timed out")); }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener("error", (error) => { clearTimeout(timer); reject(error); }, { once: true });
    });
    connection = socket;
    connectionUrl = webSocketDebuggerUrl;
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch {
        for (const [id, active] of pending) {
          if (active.socket !== socket) continue;
          pending.delete(id);
          clearTimeout(active.timer);
          active.reject(new Error("CDP returned malformed JSON"));
        }
        socket.close();
        return;
      }
      const active = pending.get(message.id);
      if (!active || active.socket !== socket) return;
      pending.delete(message.id);
      clearTimeout(active.timer);
      if (message.error) {
        const details = message.error.message ?? JSON.stringify(message.error);
        active.reject(new Error(`${details}${active.diagnostic ? `: ${active.diagnostic}` : ""}`));
      } else active.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      if (connection === socket) connection = undefined;
      for (const [id, active] of pending) {
        if (active.socket !== socket) continue;
        pending.delete(id);
        clearTimeout(active.timer);
        active.reject(new Error("CDP connection closed"));
      }
    });
    return socket;
  }

  async function send(webSocketDebuggerUrl, method, params, timeoutMs, diagnostic) {
    const socket = await persistentSocket(webSocketDebuggerUrl);
    const id = ++nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        if (connection === socket) {
          connection = undefined;
          connectionUrl = undefined;
        }
        socket.close();
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms${diagnostic ? `: ${diagnostic}` : ""}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer, socket, diagnostic });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function evaluate(webSocketDebuggerUrl, expression, timeoutMs = 5_000) {
    const diagnostic = expression.replace(/\s+/g, " ").slice(0, 120);
    const result = await send(webSocketDebuggerUrl, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs, diagnostic);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? result.result?.description ?? result.result?.value ?? JSON.stringify(details));
    }
    const value = result.result.value;
    try { return JSON.parse(value); } catch { throw new Error(String(value)); }
  }

  function cdpCommand(webSocketDebuggerUrl, method, params = {}, timeoutMs = 5_000) {
    return send(webSocketDebuggerUrl, method, params, timeoutMs);
  }

  function closeCdp() {
    connection?.close();
    connection = undefined;
    connectionUrl = undefined;
  }

  return { target, evaluate, cdpCommand, stopOwnedApplication, closeCdp };
}
