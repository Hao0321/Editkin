const EXPECTED_THEMES = {
  sky: "#175cd3",
  candy: "#b11e55",
  volt: "#8bbf65",
};

export function assessUiMeasurement(measurement) {
  const findings = [];
  const fail = (code, message, details) => findings.push({ status: "FAIL", code, message, details });
  const pass = (code, message) => findings.push({ status: "PASS", code, message });

  const overflowX = measurement.document.scrollWidth - measurement.document.clientWidth;
  const overflowY = measurement.document.scrollHeight - measurement.document.clientHeight;
  if (overflowX > 0 || overflowY > 0) fail("document-overflow", "編輯器文件層不得溢位", { overflowX, overflowY });
  else pass("document-overflow", "文件層無水平或垂直溢位");

  const missingFlow = Object.entries(measurement.primaryFlow).filter(([, visible]) => !visible).map(([name]) => name);
  if (missingFlow.length) fail("primary-flow", "四步主流程必須直接可見", { missingFlow });
  else pass("primary-flow", "加入素材、自動剪輯、拖曳微調、輸出影片皆直接可見");

  const welcomeMode = measurement.workspaceMode === "welcome";
  const expectedBeginnerActions = welcomeMode ? ["加入影片"] : ["加入素材", "一鍵自動完成", "輸出影片"];
  const wrongBeginnerActions = measurement.beginnerActions.length !== expectedBeginnerActions.length
    || expectedBeginnerActions.some((label) => !measurement.beginnerActions.some((actual) => actual.includes(label)));
  if (wrongBeginnerActions) fail("beginner-actions", welcomeMode ? "首次畫面只能有一個清楚的主行動" : "剪輯工作區只能有三個清楚的主行動", { expectedBeginnerActions, actual: measurement.beginnerActions });
  else pass("beginner-actions", welcomeMode ? "首次畫面的單一主行動正確" : "剪輯工作區的三個主行動正確");

  const decisionLimit = welcomeMode ? 6 : 14;
  if (measurement.visibleDecisionCount > decisionLimit) fail("decision-density", `目前畫面同時可見的操作選擇不得超過 ${decisionLimit} 個`, { workspaceMode: measurement.workspaceMode, visibleDecisionCount: measurement.visibleDecisionCount });
  else pass("decision-density", "目前畫面的操作選擇密度符合新手模式");

  const disabledDecisionLimit = welcomeMode ? 0 : 3;
  if ((measurement.disabledDecisionCount ?? 0) > disabledDecisionLimit) fail("disabled-clutter", `目前畫面不可操作的提示控制不得超過 ${disabledDecisionLimit} 個`, { workspaceMode: measurement.workspaceMode, disabledDecisionCount: measurement.disabledDecisionCount });
  else pass("disabled-clutter", "不可操作的流程提示數量符合新手模式");

  if (welcomeMode) {
    const firstProject = measurement.firstProject ?? {};
    if (!firstProject.welcomeVisible || firstProject.editorChromeVisible) {
      fail("welcome-focus", "尚未加入影片時只顯示開始畫面，不得同時展開檢查器與時間軸", firstProject);
    } else pass("welcome-focus", "首次畫面已隱藏專業剪輯工作區");
    if (firstProject.displayedUserAssetCount !== 0 || firstProject.demoListedAsUserMedia) {
      fail("demo-isolation", "示範素材不得計入或顯示成使用者影片", firstProject);
    } else pass("demo-isolation", "示範素材與使用者素材已清楚分離");
    if (firstProject.currentStep !== 1) fail("welcome-workflow-state", "尚未加入影片時流程必須停在第 1 步", firstProject);
    else pass("welcome-workflow-state", "首次畫面正確停在第 1 步");
  }

  if (measurement.visibilityFixture.collapsed !== 1 || measurement.visibilityFixture.opened !== 2) fail("visibility-calibration", "可見操作量尺必須排除收合區內容", measurement.visibilityFixture);
  else pass("visibility-calibration", "收合／展開操作的可見性量尺已校準");

  const undersized = measurement.primaryControls.filter((control) => control.height < 40 || control.width < 40);
  if (undersized.length) fail("primary-control-size", "主要操作必須至少 40×40 CSS px", { undersized });
  else pass("primary-control-size", "主要操作皆達 40×40 CSS px");

  const smallText = Object.entries(measurement.fontSamples).filter(([, pixels]) => Number.isFinite(pixels) && pixels < 12).map(([name, pixels]) => ({ name, pixels }));
  if (smallText.length) fail("core-font-size", "核心操作文字不得小於 12px", { smallText });
  else pass("core-font-size", "核心區域文字皆至少 12px");

  const wrongThemes = Object.entries(EXPECTED_THEMES).filter(([name, accent]) => measurement.themeSamples[name] !== accent);
  if (wrongThemes.length || measurement.persistedTheme !== "sky") {
    fail("theme-contract", "三套主題與保存狀態必須符合產品 token", { wrongThemes, persistedTheme: measurement.persistedTheme });
  } else pass("theme-contract", "藍白、粉白、黑綠主題 token 與保存狀態正確");

  const lowContrast = Object.entries(measurement.themeTokens).flatMap(([theme, tokens]) => {
    const pairs = [
      ["ink", tokens.ink, tokens.surface],
      ["soft", tokens.soft, tokens.surface],
      ["muted", tokens.muted, tokens.surface],
      ["accentButton", tokens.accentInk, tokens.accent],
    ];
    return pairs.map(([role, foreground, background]) => ({ theme, role, ratio: contrastRatio(foreground, background) })).filter((item) => item.ratio < 4.5);
  });
  if (lowContrast.length) fail("theme-contrast", "核心文字與按鈕對比必須至少 4.5:1", { lowContrast });
  else pass("theme-contrast", "三套主題的核心文字與按鈕對比皆至少 4.5:1");

  if (measurement.advancedOpen !== 0) fail("progressive-disclosure", "進階調整預設必須收合", { advancedOpen: measurement.advancedOpen });
  else pass("progressive-disclosure", "進階調整預設收合");

  return { status: findings.some((finding) => finding.status === "FAIL") ? "BLOCK" : "GREEN", findings };
}

export function selfTestUiUsability() {
  const shared = {
    document: { clientWidth: 1280, scrollWidth: 1280, clientHeight: 720, scrollHeight: 720 },
    primaryFlow: { import: true, agent: true, fineTune: true, export: true },
    visibilityFixture: { collapsed: 1, opened: 2 },
    fontSamples: { toolbar: 12, inspector: 12, timeline: 12, status: 12 },
    themeSamples: { ...EXPECTED_THEMES },
    themeTokens: {
      sky: { ink: "#172033", soft: "#3c485c", muted: "#5b6678", surface: "#ffffff", accent: "#175cd3", accentInk: "#ffffff" },
      candy: { ink: "#2b1f24", soft: "#56444b", muted: "#6f5b63", surface: "#ffffff", accent: "#b11e55", accentInk: "#ffffff" },
      volt: { ink: "#f2f6f3", soft: "#cbd4ce", muted: "#a3afa7", surface: "#151b17", accent: "#8bbf65", accentInk: "#10180d" },
    },
    persistedTheme: "sky",
    advancedOpen: 0,
  };
  const valid = {
    ...shared,
    workspaceMode: "editor",
    beginnerActions: ["加入素材", "一鍵自動完成", "輸出影片"],
    visibleDecisionCount: 12,
    disabledDecisionCount: 0,
    primaryControls: [{ name: "import", width: 100, height: 44 }],
  };
  const validWelcome = {
    ...shared,
    workspaceMode: "welcome",
    beginnerActions: ["加入影片開始剪"],
    visibleDecisionCount: 4,
    disabledDecisionCount: 0,
    primaryControls: [{ name: "import", width: 260, height: 58 }],
    firstProject: { welcomeVisible: true, editorChromeVisible: false, displayedUserAssetCount: 0, demoListedAsUserMedia: false, currentStep: 1 },
  };
  if (assessUiMeasurement(valid).status !== "GREEN") throw new Error("UI evaluator rejected its valid control");
  if (assessUiMeasurement(validWelcome).status !== "GREEN") throw new Error("UI evaluator rejected its valid welcome control");
  const mutations = [
    ["document-overflow", { document: { ...valid.document, scrollWidth: 1281 } }],
    ["primary-flow", { primaryFlow: { ...valid.primaryFlow, agent: false } }],
    ["beginner-actions", { beginnerActions: ["加入素材", "輸出影片"] }],
    ["decision-density", { visibleDecisionCount: 15 }],
    ["disabled-clutter", { disabledDecisionCount: 4 }],
    ["visibility-calibration", { visibilityFixture: { collapsed: 2, opened: 2 } }],
    ["primary-control-size", { primaryControls: [{ name: "import", width: 39, height: 40 }] }],
    ["core-font-size", { fontSamples: { ...valid.fontSamples, timeline: 11 } }],
    ["theme-contract", { themeSamples: { ...valid.themeSamples, candy: "#000000" } }],
    ["theme-contrast", { themeTokens: { ...valid.themeTokens, sky: { ...valid.themeTokens.sky, muted: "#dddddd" } } }],
    ["progressive-disclosure", { advancedOpen: 1 }],
  ];
  for (const [expectedCode, patch] of mutations) {
    const measured = { ...valid, ...patch };
    const report = assessUiMeasurement(measured);
    if (report.status !== "BLOCK" || !report.findings.some((finding) => finding.code === expectedCode && finding.status === "FAIL")) {
      throw new Error(`UI evaluator missed ${expectedCode}`);
    }
  }
  const welcomeMutations = [
    ["beginner-actions", { beginnerActions: ["加入影片開始剪", "輸出影片"] }],
    ["decision-density", { visibleDecisionCount: 7 }],
    ["welcome-focus", { firstProject: { ...validWelcome.firstProject, editorChromeVisible: true } }],
    ["demo-isolation", { firstProject: { ...validWelcome.firstProject, displayedUserAssetCount: 1, demoListedAsUserMedia: true } }],
    ["welcome-workflow-state", { firstProject: { ...validWelcome.firstProject, currentStep: 2 } }],
  ];
  for (const [expectedCode, patch] of welcomeMutations) {
    const measured = { ...validWelcome, ...patch };
    const report = assessUiMeasurement(measured);
    if (report.status !== "BLOCK" || !report.findings.some((finding) => finding.code === expectedCode && finding.status === "FAIL")) {
      throw new Error(`UI evaluator missed welcome ${expectedCode}`);
    }
  }
  return { status: "GREEN", detected: [...mutations, ...welcomeMutations].map(([code]) => code), negativeControl: "PASS" };
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) return 0;
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
