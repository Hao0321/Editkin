import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceStartupBoundary } from "./ui/WorkspaceStartupBoundary";
import { interfacePreferences, useI18n } from "./ui/i18n/interfacePreferences";
import "./styles.css";

// Complete desktop API setup before evaluating App, while keeping the boot entry small.
const App = lazy(async () => {
  await import("./desktop/tauriBridge");
  await interfacePreferences.initialize();
  // Recovered projects can reach Preview before the preset browser or Inspector mounts.
  // Register every shipped creative extension before React renders any project clip.
  const [{ initializeStudioCreativeAssets }, { initializeWave2Registry }] = await Promise.all([
    import("./creative/studioAssets"),
    import("./creative/wave2Registry"),
  ]);
  initializeStudioCreativeAssets();
  initializeWave2Registry();
  // Desktop registers verified selected binary faces through its typed API.
  // Registering absent /fonts/render URLs here would create a competing load.
  await (await import("./typography/motionFontDelivery")).bootstrapMotionFontCss(window, () => import("./generated/fontFaces.css"));
  if (typeof window !== "undefined") void window.haoDesktop?.integrationSmokeEnabled?.().then(async enabled => {
    if (enabled === true) (await import("./desktop/integrationUiPerformance")).installIntegrationUiPerformance(true);
  }).catch(() => undefined);
  return import("./App");
});

function BootScreen() {
  const { t } = useI18n();
  return <main className="boot-screen" aria-live="polite"><strong>Editkin</strong><span>{t("正在準備剪輯工作區…")}</span></main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceStartupBoundary>
      <Suspense fallback={<BootScreen />}>
        <App />
      </Suspense>
    </WorkspaceStartupBoundary>
  </StrictMode>,
);
