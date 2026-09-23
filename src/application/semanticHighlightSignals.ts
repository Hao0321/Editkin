export type SemanticHighlightRole = "method" | "evidence" | "problem" | "payoff" | "specific" | "housekeeping" | "invalidated";

export interface SemanticHighlightSignals {
  roles: SemanticHighlightRole[];
  bonus: number;
  penalty: number;
  reasons: string[];
}

const HOUSEKEEPING = /(按讚|訂閱|資訊欄|置頂留言|抽獎|課程連結|產品價格|贊助|折扣碼|社群貼文|公告|謝謝大家|\bsponsor(?:ed)?\b|\bsubscribe\b|description|link below|pinned comment|giveaway|course link|community post|announcements?|discount|prices?)/iu;
const METHOD = /(方法|步驟|先框|再把|不要硬猜|手動修正|修正暖機|重跑|清空快取|關掉|放進|移出|移到|重建|保留|套用|\bmethod\b|\bstep\b|\bdraw\b|\bthen\b|\bmove\b|\bput\b|\bdisable\b|\bstop\b|\bkeep\b|\bclear(?:ing)?\b|\brebuild(?:ing)?\b|manual correction|instead of guessing)/iu;
const EVIDENCE = /(實測|測試|重跑|中位數|平均|掉幀|雜湊|完整回來|恢復|從.{0,18}(?:降|升|變成)|(?:一|兩|二|三|四|五|六|七|八|九|十|百|千|萬|百分之|\d).{0,5}(?:秒|次|倍|分鐘|%)|\bmedian\b|\bacross\b|\bhash\b|\brestor(?:e|ed|ing)\b|dropped frames|\bfrom\b.{0,28}\bto\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|eighteen|forty seven|\d+)\b.{0,8}\b(?:seconds?|times?|minutes?|percent)\b)/iu;
const PROBLEM = /(突然|打不開|空白|壞|跑錯|遮住|遮擋|漂走|卡住|但是|可是|直到|才發現|不是影片|\bbut\b|would not open|looked empty|\bbroken\b|\bhidden\b|occlusion|\bdrift\b|\bstall|only after|\brealize\b)/iu;
const PAYOFF = /(這樣|真正有效|真正的|完整回來|不會.{0,12}(?:漂|卡)|能保持|只延遲|差異不是|結果是|\buseful change\b|\bnow\b|\btherefore\b|\brestored\b|\bsurvives\b|\bstays readable\b|the difference came from|delayed.{0,12}\bonly\b)/iu;
const SPECIFIC = /(GPU|CPU|四 ?K|4 ?K|快取|解碼|佇列|執行緒|來源檔|索引|自動備份|低信心|分析範圍|鏡頭切換|tracking region|scene cut|confidence frames|decode queue|interface thread|background task|source hash|index|backup|cache)/iu;
const STRONGLY_INVALIDATED = /(完全無效|不能拿來當結論|不能代表結論|剛才那個.{0,12}結果|not the (?:real )?result|must not be used as the conclusion|cannot be used as the conclusion)/iu;
const INVALID_DISCOVERY = /(看似|看起來|跑錯|快取.{0,8}(?:沒|沒有)清|忘了|\blooked\b.{0,24}\bbut\b|first result.{0,24}\bbut\b|forgot(?:ten)?|warm cache.{0,12}invalid)/iu;

export function analyzeSemanticHighlightSignals(text: string): SemanticHighlightSignals {
  const normalized = text.normalize("NFKC");
  const roles: SemanticHighlightRole[] = [];
  const reasons: string[] = [];
  let bonus = 0; let penalty = 0;
  const add = (role: SemanticHighlightRole, value: number, reason: string) => { roles.push(role); bonus += value; reasons.push(reason); };
  if (METHOD.test(normalized)) add("method", .25, "包含可執行方法");
  if (EVIDENCE.test(normalized)) add("evidence", .25, "包含可驗證證據");
  if (PROBLEM.test(normalized)) add("problem", .18, "建立問題或轉折");
  if (PAYOFF.test(normalized)) add("payoff", .22, "交付結果或解法");
  if (SPECIFIC.test(normalized)) add("specific", .16, "包含具體技術細節");
  if (HOUSEKEEPING.test(normalized)) { roles.push("housekeeping"); penalty += .72; reasons.push("宣傳或流程性口播"); }
  if (STRONGLY_INVALIDATED.test(normalized)) { roles.push("invalidated"); penalty += .68; reasons.push("內容明示為無效結果"); }
  else if (INVALID_DISCOVERY.test(normalized)) { roles.push("invalidated"); penalty += .4; reasons.push("包含尚未校正的結果"); }
  return { roles: [...new Set(roles)], bonus, penalty, reasons };
}
