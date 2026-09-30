// Registers the offline shell worker. Injected only into PWA builds; skipped in
// the desktop shells, which never ship a worker.
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !window.haoDesktop) {
  addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(new URL("sw.js", document.baseURI));
      registration.waiting?.postMessage({ type: "SKIP_WAITING_IF_ALONE" });
    } catch (error) {
      console.warn("Editkin offline shell is unavailable:", error);
    }
  });
}
