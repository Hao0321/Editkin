import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceStartupBoundary } from "./ui/WorkspaceStartupBoundary";
import "./styles.css";

// Complete desktop API setup before evaluating App, while keeping the boot entry small.
const App = lazy(async () => {
  await import("./desktop/tauriBridge");
  // Desktop registers verified selected binary faces through its typed API.
  // Registering absent /fonts/render URLs here would create a competing load.
  await (await import("./typography/motionFontDelivery")).bootstrapMotionFontCss(window, () => import("./generated/fontFaces.css"));
  if (typeof window !== "undefined") void window.haoDesktop?.integrationSmokeEnabled?.().then(async enabled => {
    if (enabled === true) (await import("./desktop/integrationUiPerformance")).installIntegrationUiPerformance(true);
  }).catch(() => undefined);
  return import("./App");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceStartupBoundary>
      <Suspense fallback={<main className="boot-screen" aria-live="polite"><strong>Editkin</strong><span>正在準備剪輯工作區…</span></main>}>
        <App />
      </Suspense>
    </WorkspaceStartupBoundary>
  </StrictMode>,
);
