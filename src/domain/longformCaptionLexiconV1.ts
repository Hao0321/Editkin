/** Canonical literal Hao word policy, copied without executing or modifying VA. */
export const LONGFORM_CAPTION_LEXICON_V1 = Object.freeze({
  schema: "editkin.longform-caption-lexicon/v1",
  referenceSha256: "c2b3fd047abe7b3f724b6960ab963e84ae72400fd94a7e3295d8ad90ba17f680",
  fixes: Object.freeze([["Cloud\\s*Code", "Claude Code"], ["cloud\\s*code", "Claude Code"], ["老口", "Claude Code"], ["每速圖", "美術圖"], ["美速圖", "美術圖"], ["立會", "立繪"], ["安慮", "Unreal"], ["安路", "Unreal"], ["論和", "任何"], ["遮行", "這行"], ["熟寫", "手寫"], ["游戏", "遊戲"], ["寫勾", "寫 code"], ["寫購", "寫 code"], ["Apple\\s*Store", "App Store"], ["AppleStore", "App Store"], ["\\bC\\s*ode\\b", "Code"], ["G\\s*P\\s*T", "GPT"], ["U\\s*I", "UI"], ["字幕by\\S*", ""], ["字幕組\\S*", ""]].map(pair => Object.freeze(pair as [string, string]))),
  NEVER_SPLIT: Object.freeze(["一直", "一開", "上架", "下去", "不斷", "互動", "交流", "什麼", "件事", "作為", "來越", "公式", "分享", "剛剛", "創作", "功能", "半成", "回報", "地方", "基礎", "大堆", "大概", "完整", "實說", "實驗", "小時", "工具", "已經", "平台", "幾乎", "廣告", "引擎", "影片", "慢慢", "成品", "戰鬥", "打開", "抽卡", "持續", "挑戰", "推測", "收入", "收益", "收穫", "教學", "數據", "方向", "時候", "期待", "東西", "模一", "正在", "流量", "演算", "瀏覽", "營利", "留言", "盈利", "社群", "禮拜", "程度", "程式", "立繪", "算法", "簡單", "細節", "結論", "美術", "老實", "自己", "藍圖", "規則", "觀念", "角色", "觸及", "訂閱", "誤會", "貼文", "資料", "越來", "追蹤", "這套", "連結", "遊戲", "運氣", "邏輯", "部分", "鐵粉", "開發", "開過", "陌生", "震撼"]),
  TAIL_HARD: Object.freeze(["像", "向", "始", "對", "幫", "往", "從", "想", "成", "把", "會", "比", "用", "當", "給", "能", "被", "要", "該", "變", "讓", "跟", "這", "開", "靠"]),
  TAIL_HARD_TOK: Object.freeze(["一直", "幾乎", "越來越", "慢慢", "剛剛", "正在", "不斷", "持續", "已經"]),
  HEAD_DANGLERS: Object.freeze(["了", "個", "們", "吧", "呢", "啦", "嗎", "地", "得", "的"]),
  DIR_COMPLEMENTS: Object.freeze(["下去", "起來", "出來", "回來", "進去", "下來", "上來", "過去", "過來"]),
} as const);
