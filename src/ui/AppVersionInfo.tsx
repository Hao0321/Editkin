import { useEffect, useState } from "react";
import { useI18n } from "./i18n/interfacePreferences";
import type { AppBuildInfo } from "../desktop/apiTypes";

/**
 * 「關於 Editkin」 in the settings panel: the app version and the build ID the build embedded (its release input
 * identity), so a creator can tell exactly which build they are using when they ask for help.
 */
export function AppVersionInfo() {
  const { t } = useI18n();
  const [info, setInfo] = useState<AppBuildInfo | "browser" | "loading">("loading");
  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.haoDesktop;
    if (!api?.appBuildInfo) { setInfo("browser"); return; }
    let live = true;
    void api.appBuildInfo().then(value => { if (live) setInfo(value); }, () => { if (live) setInfo("browser"); });
    return () => { live = false; };
  }, []);
  return <section className="app-version-info" aria-label={t("關於 Editkin")} data-testid="app-version-info">
    <strong>{t("關於 Editkin")}</strong>
    {info === "loading" ? <p>{t("正在讀取版本…")}</p>
      : info === "browser" ? <p>{t("網頁版：桌面版才有建置編號。")}</p>
      : <dl>
        <dt>{t("版本")}</dt><dd data-testid="app-version">{info.version}</dd>
        <dt>{t("建置編號")}</dt><dd data-testid="app-build-id" title={info.buildIdFull}>{info.buildId}</dd>
        {info.edition === "community" && <><dt>{t("版本類型")}</dt><dd>{t("社群版")}</dd></>}
      </dl>}
  </section>;
}
