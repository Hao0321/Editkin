import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Complete desktop API setup before evaluating App, while keeping the boot entry small.
const App = lazy(async () => {
  await import("./desktop/tauriBridge");
  if (typeof window !== "undefined") void window.haoDesktop?.integrationSmokeEnabled?.().then(async enabled => {
    if (enabled === true) (await import("./desktop/integrationUiPerformance")).installIntegrationUiPerformance(true);
  }).catch(() => undefined);
  return import("./App");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<main className="boot-screen" aria-live="polite"><strong>Editkin</strong><span>正在準備剪輯工作區…</span></main>}>
      <App />
    </Suspense>
  </StrictMode>,
);
