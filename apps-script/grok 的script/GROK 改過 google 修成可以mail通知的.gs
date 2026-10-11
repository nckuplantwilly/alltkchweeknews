/**
 * ============================================================
 * 德光長老教會 週報自動化處理系統 (v4.1)
 * Google Apps Script
 *
 * v4 針對實際營運的兩個問題：
 *
 *  1. 舊週報已上架，但連結不正確（href="#"、lin.ee/example、
 *     Gemini 省略網址、每次重跑都新建 Gist 導致網址飄移）
 *     → 新增「不呼叫 Gemini」的補修管線，從已發布 HTML + PDF
 *       註解層慢慢修，避免打爆 Gemini 配額。
 *
 *  2. 「劉娗坊」PDF 是對的，辨識後常變成 劉嫆坊 / 劉媞坊 / 劉婷坊
 *     → 專有名詞白名單 + 正規化「劉○坊」；不再只靠 prompt。
 *
 * 建議執行順序（金鑰請用 setupApiKeys，不要貼在腳本裡）：
 *  1) setupApiKeys()
 *  2) testGeminiConnection()            // 只在要跑新週報時需要
 *  3) previewPublishedIssues()          // 不花 Gemini，只掃描已上架問題
 *  4) repairPublishedWithoutGemini()    // 每次修幾期舊連結／錯字
 *  5) checkAndProcessNewBulletins()     // 只處理還沒做過的新 PDF
 *  6) installScheduleTriggers()         // 只跑一次：裝台北時間 8/10/12/14/16/18/20 點排程
 *  7) startTestingPeriod()              // 測試期：網站只留 2026-09-27，並重辨識 2026-09-20
 *
 * 可選：
 *  - backfillUnpublishedSlowly()        // 每天 1 份，把 2022-12-25 起還沒上架的慢慢補
 *  - reprocessLatestBulletin()          // 最新一期才重跑 Gemini
 *  - dedupeDuplicateGists(true)         // 先預覽重複 Gist；確認後再傳 false 刪除
 *  - listScheduleTriggers() / removeScheduleTriggers()
 * ============================================================
 */

const DEACON_FOLDER_ID   = '174Z7NcewqIu6tFQl2h_LbFZVdhtqrKcX';
const PERSONAL_FOLDER_ID = '1SdFohepZisOeqDCa-orOxWlb1XvbqWuN';
const GITHUB_USERNAME    = 'wowidance-cloud';
const INDEX_FILENAME     = 'tkch-bulletin-index.json';
const INDEX_DESCRIPTION  = 'TKCH-BULLETIN-INDEX';
const PROCESSED_KEY      = 'PROCESSED_FILE_IDS';
const INDEX_GIST_ID_KEY  = 'INDEX_GIST_ID';
const GIST_MAP_KEY       = 'GIST_ID_BY_DATE';
const REPAIR_CURSOR_KEY  = 'REPAIR_CURSOR_DATE';
const REPAIRED_DATES_KEY = 'REPAIRED_DATES';
const LAST_GEMINI_429_KEY = 'LAST_GEMINI_429_AT';
const FILE_STATE_KEY     = 'PROCESSED_FILE_STATE';

/** ★ 自動發布通知收件人信箱（多個信箱以逗號分隔） */
const NOTIFICATION_EMAILS = [
  'Tkch06@gmail.com',
  '10802036@gs.ncku.edu.tw'
];

/** 更舊的週報不處理 */
const MIN_BULLETIN_DATE = '2022-12-25';

/** 新週報（會呼叫 Gemini）每次最多幾份。務必維持 1，以免配額瞬間燒完。 */
const GEMINI_BATCH_LIMIT = 1;

/** 舊週報補修（不呼叫 Gemini）每次幾份。GitHub／Drive 配額遠比 Gemini 寬。 */
const REPAIR_BATCH_LIMIT = 5;

/** 歷史第一次轉檔（會呼叫 Gemini）每天建議 1 份。 */
const BACKFILL_BATCH_LIMIT = 1;

/** 碰到 Gemini 429 後，至少冷卻幾小時才再試。 */
const GEMINI_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * 測試期：不要自動把 2022–2026/09/13 那些舊 PDF 陸續上架。
 * 已在網站上的日期若 PDF 被覆蓋，仍會自動重跑。
 * 比「網站上最新一期」更晚的新主日，也會自動上架。
 */
const HISTORICAL_BACKFILL_ENABLED = false;

/** 台北時間每天要跑的時段（Apps Script 會落在該整點後約 0–15 分鐘）。 */
const SCHEDULE_HOURS = [8, 10, 12, 14, 16, 18, 20];
const SCHEDULE_TIMEZONE = 'Asia/Taipei';
const SCHEDULE_HANDLER = 'scheduledTick';
/** 只有這個時段才用 Gemini 回補「還沒上架」的歷史週報，避免白天配額被吃光。 */
const BACKFILL_HOUR = 20;

const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest'
];

/**
 * 常設活動按鈕：prompt 與 HTML 後處理共用同一份。
 * keys 為週報內文關鍵字；只要內文出現，就必須放入對應按鈕。
 */
const KNOWN_ACTIVITY_BUTTONS = [
  {
    keys: ['慕道班'],
    match: 'FAIpQLScx-vbYcoA2Eq0ICfe5Jxa78AU8TKpwAOUSVcpURoiumN5E_w',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLScx-vbYcoA2Eq0ICfe5Jxa78AU8TKpwAOUSVcpURoiumN5E_w/viewform',
    label: '慕道班線上報名',
    isOffering: false
  },
  {
    keys: ['中保代禱', '中保帶禱'],
    match: 'r30vKE',
    href: 'https://reurl.cc/r30vKE',
    label: '中保代禱專頁',
    isOffering: false
  },
  {
    keys: ['從懷疑到相信', '从怀疑到相信'],
    match: 'zpQDKe',
    href: 'https://reurl.cc/zpQDKe',
    label: '從懷疑到相信',
    isOffering: false
  },
  {
    keys: ['小步走'],
    match: 'FAIpQLSc0RclQMdd4rS4pIXpxx40nWqSVddkFADU2VP4GTg6_-MgwEQ',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLSc0RclQMdd4rS4pIXpxx40nWqSVddkFADU2VP4GTg6_-MgwEQ/viewform',
    label: '小步走線上報名',
    isOffering: false
  },
  {
    keys: ['愛相隨', '爱相随'],
    match: 'FAIpQLSef6aEXbLACST9abmXXsF01CoT8RhKVdoy9cxUZA7dEMGAQLw',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLSef6aEXbLACST9abmXXsF01CoT8RhKVdoy9cxUZA7dEMGAQLw/viewform',
    label: '愛相隨小組報名',
    isOffering: false
  }
];

const KNOWN_URL_META = [
  {
    match: 'O56r6A',
    keys: ['停車', '汽機車', '停車場'],
    href: 'https://reurl.cc/O56r6A',
    label: '教會停車配置圖',
    desc: '教會汽機車停車公告與配置圖，若週報有提及停車才放，嚴禁誤放入慕道班！',
    isOffering: false
  },
  {
    match: 'Egm6bA',
    keys: ['線上奉獻', '線上献金'],
    href: '',
    label: '線上奉獻',
    desc: '奉獻相關，依規定嚴格排除，不放入 HTML！',
    isOffering: true
  },
  {
    match: '100068541559964',
    keys: ['教會粉絲頁', '官方粉絲', '德光長老教會 Facebook', '德光長老教會臉書', '教會FB', '教會粉專'],
    href: 'https://www.facebook.com/profile.php?id=100068541559964&mibextid=LQQJ4d',
    label: '德光長老教會粉絲頁',
    desc: '德光長老教會官方 Facebook 粉絲頁（QR Code 標籤：教會粉絲頁）！',
    isOffering: false
  },
  {
    match: 'tntklove',
    keys: ['教會據點粉絲頁', '據點粉絲頁', '社區據點粉絲頁', '據點FB', '據點粉專', '社區照顧關懷據點'],
    href: 'https://www.facebook.com/tntklove062672323?mibextid=LQQJ4d',
    label: '德光教會據點粉絲頁',
    desc: '德光社區照顧關懷據點暨C級巷弄長照站 Facebook 專頁（QR Code 標籤：教會據點粉絲頁）！',
    isOffering: false
  }
];

/**
 * 事奉表專有名詞。中間字「娗」極生僻，Gemini／OCR 幾乎每次都猜錯。
 * 實際已出現過：劉嫆坊（2026-09-27）、劉媞坊（2026-09-06）。
 * 規則：劉 + 單一字 + 坊，只要不是「娗」，一律改回「劉娗坊」。
 * 若將來真的有另一位「劉○坊」，把該全名放進 PROPER_NOUN_EXCEPTIONS。
 */
const PROPER_NOUN_FIXES = [
  ['劉嫆坊', '劉娗坊'],
  ['劉媞坊', '劉娗坊'],
  ['劉婷坊', '劉娗坊'],
  ['劉挺坊', '劉娗坊'],
  ['劉廷坊', '劉娗坊'],
  ['劉庭坊', '劉娗坊'],
  ['劉艇坊', '劉娗坊'],
  ['劉蜓坊', '劉娗坊'],
  ['劉珽坊', '劉娗坊'],
  ['劉娙坊', '劉娗坊'],
  ['劉姈坊', '劉娗坊'],
  ['劉容坊', '劉娗坊'],
  ['劉榕坊', '劉娗坊'],
  ['劉溶坊', '劉娗坊'],
  ['劉延坊', '劉娗坊'],
  ['刘娗坊', '劉娗坊']
];
const PROPER_NOUN_EXCEPTIONS = [];

/** 長詞優先，避免部分替換造成二次錯字。單字簡轉繁放最後。 */
const TYPO_FIXES = [
  ['業界消息', '教界消息'],
  ['界界消息', '教界消息'],
  ['教教消息', '教界消息'],
  ['教際消息', '教界消息'],
  ['长考教会', '長老教會'],
  ['長考教會', '長老教會'],
  ['長老教曾', '長老教會'],
  ['長老教惠', '長老教會'],
  ['長老教回', '長老教會'],
  ['慕道版', '慕道班'],
  ['慕道板', '慕道班'],
  ['侍奉表', '事奉表'],
  ['事俸表', '事奉表'],
  ['侍俸表', '事奉表'],
  ['帶禱事項', '代禱事項'],
  ['中保帶禱', '中保代禱'],
  ['掰餅', '擘餅'],
  ['主日学', '主日學'],
  ['台南中会', '台南中會'],
  ['台灣基督长老教会', '台灣基督長老教會'],
  ['台湾基督长老教会', '台灣基督長老教會'],
  ['德光长老教会', '德光長老教會'],
  ['德光長老教会', '德光長老教會'],
  ['周報', '週報'],
  ['礼拜', '禮拜'],
  ['祷告', '禱告'],
  ['见证', '見證'],
  ['团契', '團契'],
  ['圣经', '聖經'],
  ['诗篇', '詩篇'],
  ['荣耀', '榮耀'],
  ['感谢', '感謝'],
  ['赞美', '讚美'],
  ['牧师', '牧師'],
  ['长老', '長老'],
  ['执事', '執事'],
  ['圣灵', '聖靈'],
  ['教会', '教會'],
  ['台湾', '台灣'],
  ['学', '學'],
  ['礼', '禮'],
  ['祷', '禱'],
  ['经', '經'],
  ['诗', '詩'],
  ['团', '團'],
  ['证', '證'],
  ['长', '長'],
  ['灵', '靈'],
  ['圣', '聖'],
  ['会', '會'],
  ['区', '區'],
  ['义', '義'],
  ['听', '聽'],
  ['读', '讀'],
  ['讲', '講'],
  ['爱', '愛'],
  ['属', '屬'],
  ['备', '備'],
  ['处', '處'],
  ['门', '門'],
  ['开', '開'],
  ['关', '關'],
  ['报', '報'],
  ['号', '號'],
  ['页', '頁'],
  ['书', '書'],
  ['乐', '樂'],
  ['齐', '齊'],
  ['实', '實'],
  ['从', '從'],
  ['应', '應'],
  ['该', '該'],
  ['还', '還'],
  ['让', '讓'],
  ['过', '過'],
  ['点', '點'],
  ['钟', '鐘'],
  ['为', '為'],
  ['与', '與'],
  ['这', '這'],
  ['个', '個'],
  ['们', '們'],
  ['来', '來'],
  ['对', '對'],
  ['时', '時'],
  ['间', '間'],
  ['请', '請'],
  ['说', '說']
];

const JUNK_URL_RE = /w3\.org|adobe\.com|purl\.org|color\.org|npes\.org|xml\.org|microsoft\.com|apple\.com\/DTDs|schemas\.openxmlformats|ns\.adobe|xmp\.iid|xmp\.did|pdfa\.org|ci\.org|iptc\.org|plus\.google\.com\/u\/0\/_/i;
const PLACEHOLDER_HREF_RE = /^(#|https?:\/\/(www\.)?example\.com\/?|https?:\/\/lin\.ee\/example|https?:\/\/example\.org\/?|javascript:void\(0\)?)$/i;

// ============================================================
// ★ 定時排程（台北時間 8/10/12/14/16/18/20）
// ============================================================
/**
 * 每個時段實際會做三件事，依序：
 *  1) 掃描幹事資料夾，若有「還沒處理過」的新 PDF，轉 1 份（會呼叫 Gemini）
 *  2) 補修已上架但連結／錯字有問題的舊 HTML（不呼叫 Gemini）
 *  3) 只有約 20:00 那一輪，才額外把還沒上架的歷史 PDF 轉 1 份
 *
 * 請在 Apps Script 左下角「專案設定」把時區設成 (GMT+08:00) 台北，
 * 然後手動執行一次 installScheduleTriggers()。沒裝觸發器就不會自動跑。
 */
function scheduledTick() {
  const nowLabel = Utilities.formatDate(new Date(), SCHEDULE_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const hour = Number(Utilities.formatDate(new Date(), SCHEDULE_TIMEZONE, 'H'));
  Logger.log('=== 定時任務開始（台北 ' + nowLabel + '）===');

  try {
    checkAndProcessNewBulletins();
  } catch (e) {
    Logger.log('❌ 新週報階段失敗：' + e.message);
  }

  try {
    repairPublishedWithoutGemini();
  } catch (e) {
    Logger.log('❌ 舊週報補修失敗：' + e.message);
  }

  if (HISTORICAL_BACKFILL_ENABLED && hour >= BACKFILL_HOUR) {
    try {
      backfillUnpublishedSlowly();
    } catch (e) {
      Logger.log('❌ 歷史回補失敗：' + e.message);
    }
  } else if (!HISTORICAL_BACKFILL_ENABLED) {
    Logger.log('⏭ 測試期已關閉歷史回補，不會自動上架更舊的週報。');
  }

  Logger.log('=== 定時任務結束 ===');
}

/** 只需要執行一次。會先清掉舊的 scheduledTick 觸發器，再裝上 7 個每日時段。 */
function installScheduleTriggers() {
  removeScheduleTriggers();
  SCHEDULE_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger(SCHEDULE_HANDLER)
      .timeBased()
      .atHour(hour)
      .everyDays(1)
      .inTimezone(SCHEDULE_TIMEZONE)
      .create();
  });
  Logger.log('✅ 已安裝台北時間每日排程：' + SCHEDULE_HOURS.map(function (h) {
    return String(h).padStart(2, '0') + ':00';
  }).join('、'));
  Logger.log('⚠ Apps Script 不會剛好 00 分觸發，會落在該整點後約 0–15 分鐘。');
  Logger.log('⚠ 請確認「專案設定 → 時區」是 (GMT+08:00) 台北。');
  listScheduleTriggers();
}

function removeScheduleTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === SCHEDULE_HANDLER) {
      ScriptApp.deleteTrigger(t);
      removed += 1;
    }
  });
  Logger.log('已移除舊排程：' + removed + ' 個');
}

function listScheduleTriggers() {
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === SCHEDULE_HANDLER;
  });
  if (triggers.length === 0) {
    Logger.log('目前沒有任何自動排程。請執行 installScheduleTriggers()。');
    return;
  }
  Logger.log('目前排程共 ' + triggers.length + ' 個：');
  triggers.forEach(function (t, i) {
    Logger.log('  ' + (i + 1) + '. ' + t.getHandlerFunction() + ' / ' + t.getEventType());
  });
}

// ============================================================
// ★ 主要排程入口
// ============================================================
function checkAndProcessNewBulletins() {
  const props = PropertiesService.getScriptProperties();
  const GEMINI_API_KEY = props.getProperty('GEMINI_API_KEY');
  const GITHUB_TOKEN   = props.getProperty('GITHUB_TOKEN');
  if (!GEMINI_API_KEY || !GITHUB_TOKEN) {
    Logger.log('❌ 錯誤：請先執行 setupApiKeys() 填入 API 金鑰');
    return;
  }

  if (isGeminiCoolingDown()) {
    Logger.log('⏸ 距上次 Gemini 429 未滿冷卻時間，改跑「不呼叫 Gemini」的舊週報補修。');
    repairPublishedWithoutGemini();
    return;
  }

  Logger.log('=== 德光週報自動化處理開始 (v4.1) ===');
  Logger.log('🔍 掃描幹事資料夾：' + DEACON_FOLDER_ID);
  let deaconFolder;
  try {
    deaconFolder = DriveApp.getFolderById(DEACON_FOLDER_ID);
  } catch (e) {
    Logger.log('❌ 無法存取幹事資料夾：' + e.message);
    return;
  }

  const indexState = loadIndexGist(GITHUB_TOKEN);
  const indexDates = {};
  let latestPublished = '';
  (indexState && indexState.list ? indexState.list : []).forEach(function (e) {
    if (e && e.date) {
      indexDates[e.date] = true;
      if (e.date > latestPublished) latestPublished = e.date;
    }
  });
  Logger.log('📋 網站目前已上架：' + (Object.keys(indexDates).sort().join(', ') || '（空）'));

  const allPdfFiles = getAllPdfFilesRecursive(deaconFolder);
  Logger.log('📂 找到總計 ' + allPdfFiles.length + ' 份 PDF 檔案');
  const byDate = groupPdfsByDate(allPdfFiles);
  const jobs = [];
  Object.keys(byDate).forEach(function (dateStr) {
    if (dateStr < MIN_BULLETIN_DATE) return;
    if (!shouldAutoPublish(dateStr, indexDates, latestPublished)) return;
    const file = pickNewestPdf(byDate[dateStr]);
    const reason = detectPdfChangeReason(file, dateStr);
    if (reason) jobs.push({ file: file, date: dateStr, reason: reason });
  });

  if (jobs.length === 0) {
    Logger.log('✅ 沒有新週報，已上架的 PDF 也沒有被覆蓋。');
    return;
  }
  jobs.sort(function (a, b) { return b.date.localeCompare(a.date); });
  const toProcess = jobs.slice(0, GEMINI_BATCH_LIMIT);
  Logger.log('📄 待處理：' + jobs.length + ' 期，本次 ' + toProcess.length + ' 期');
  for (const job of toProcess) {
    Logger.log('\n----------------------------------------');
    Logger.log('▶ ' + job.file.getName() + '（' + job.reason + '）');
    try {
      processOneBulletin(job.file, GEMINI_API_KEY, GITHUB_TOKEN, {
        useGemini: true,
        replaceBackup: job.reason !== 'new'
      });
      markAsProcessed(job.file.getId());
      markFileState(job.file, job.date);
      Logger.log('✅ 處理成功：' + job.file.getName());
    } catch (e) {
      Logger.log('❌ 處理失敗：' + job.file.getName() + '\n   原因：' + e.message);
      if (/429/.test(String(e.message))) break;
    }
    Utilities.sleep(3000);
  }
  Logger.log('\n=== 本次執行完畢！===');
}

/** 已上架的會因 PDF 被覆蓋而更新；比網站最新一期更晚的新主日會自動上架。更舊的歷史檔不會自動跑。 */
function shouldAutoPublish(dateStr, indexDates, latestPublished) {
  if (indexDates[dateStr]) return true;
  if (!latestPublished) return true;
  return dateStr > latestPublished;
}

function groupPdfsByDate(files) {
  const byDate = {};
  (files || []).forEach(function (f) {
    const d = extractDateFromFilename(f.getName());
    if (!d) return;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(f);
  });
  return byDate;
}

function pickNewestPdf(files) {
  const list = (files || []).slice();
  list.sort(function (a, b) {
    return b.getLastUpdated().getTime() - a.getLastUpdated().getTime();
  });
  return list[0] || null;
}

function getFileState() {
  const raw = PropertiesService.getScriptProperties().getProperty(FILE_STATE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveFileState(state) {
  PropertiesService.getScriptProperties().setProperty(FILE_STATE_KEY, JSON.stringify(state));
}

function markFileState(file, dateStr) {
  const state = getFileState();
  Object.keys(state).forEach(function (id) {
    if (state[id] && state[id].date === dateStr && id !== file.getId()) delete state[id];
  });
  state[file.getId()] = {
    date: dateStr,
    updated: file.getLastUpdated().getTime(),
    size: file.getSize()
  };
  saveFileState(state);
}

function findFileStateByDate(dateStr) {
  const state = getFileState();
  const ids = Object.keys(state);
  for (let i = 0; i < ids.length; i++) {
    if (state[ids[i]] && state[ids[i]].date === dateStr) {
      return { fileId: ids[i], meta: state[ids[i]] };
    }
  }
  return null;
}

/**
 * 回傳為何要重跑：new / replaced-file / content-changed；沒變化則空字串。
 * 幹事若「同一個檔案覆蓋內容」或「再傳一份同日期新檔」，都會被抓到。
 */
function detectPdfChangeReason(file, dateStr) {
  if (!file) return '';
  const state = getFileState();
  const prev = state[file.getId()];
  const size = file.getSize();
  const updated = file.getLastUpdated().getTime();
  if (!prev) {
    const byDate = findFileStateByDate(dateStr);
    if (!byDate) {
      const processed = getProcessedIds();
      if (processed.indexOf(file.getId()) !== -1) {
        markFileState(file, dateStr);
        return '';
      }
      return 'new';
    }
    if (updated > byDate.meta.updated || size !== byDate.meta.size) return 'replaced-file';
    return '';
  }
  if (size !== prev.size) return 'content-changed';
  if (updated > prev.updated + 5000) return 'content-changed';
  return '';
}

/**
 * 不呼叫 Gemini。下載已上架 HTML，用 PDF 真實網址 + 常設按鈕 + 錯字／人名規則補修，
 * 再 PATCH 回同一個 Gist（網址不變）。每次 REPAIR_BATCH_LIMIT 份，從最舊開始。
 */
function repairPublishedWithoutGemini() {
  const props = PropertiesService.getScriptProperties();
  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  Logger.log('=== 舊週報補修（不呼叫 Gemini）v4.0 ===');

  const indexState = loadIndexGist(githubToken);
  if (!indexState || !indexState.list) {
    Logger.log('❌ 找不到目錄 Gist');
    return;
  }
  const repaired = getRepairedDates();
  const targets = indexState.list
    .filter(function (e) { return e && e.date && e.date >= MIN_BULLETIN_DATE; })
    .filter(function (e) { return repaired.indexOf(e.date) === -1; })
    .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });

  if (targets.length === 0) {
    Logger.log('✅ 目錄中 ' + MIN_BULLETIN_DATE + ' 起的週報都已補修過。若規則有更新，先執行 resetRepairCursor() 再跑。');
    return;
  }

  Logger.log('📋 待補修：' + targets.length + ' 期，本次最多 ' + REPAIR_BATCH_LIMIT + ' 期');
  const pdfIndex = buildPdfDateIndex();
  let changedIndex = false;
  const batch = targets.slice(0, REPAIR_BATCH_LIMIT);

  for (const entry of batch) {
    Logger.log('\n----------------------------------------');
    Logger.log('▶ 補修 ' + entry.date + '　' + (entry.title || ''));
    try {
      const result = repairOneIndexEntry(entry, pdfIndex, githubToken);
      if (result.previewUrl && result.previewUrl !== entry.url) {
        entry.url = result.previewUrl;
        changedIndex = true;
      }
      markDateRepaired(entry.date);
      props.setProperty(REPAIR_CURSOR_KEY, entry.date);
      Logger.log('   ✓ ' + (result.changed ? '已寫回 Gist' : '內容已正確，僅核對網址'));
    } catch (e) {
      Logger.log('   ❌ 失敗：' + e.message);
    }
    Utilities.sleep(1500);
  }

  if (changedIndex) {
    saveIndexList(indexState, githubToken);
    Logger.log('✓ 目錄網址已改為不含 commit hash 的穩定連結，之後 PATCH 網站會跟著更新。');
  }
  Logger.log('=== 本次補修結束，剩下 ' + Math.max(0, targets.length - batch.length) + ' 期。明天再跑或手動再執行一次。===');
}

/** 預覽已上架週報有哪些壞連結／錯字，不寫入、不呼叫 Gemini。 */
function previewPublishedIssues() {
  const props = PropertiesService.getScriptProperties();
  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  const indexState = loadIndexGist(githubToken);
  if (!indexState) return;
  Logger.log('=== 掃描已上架週報問題（唯讀）===');
  const repaired = getRepairedDates();
  indexState.list.forEach(function (entry) {
    if (!entry || !entry.date) return;
    const gistId = parseGistIdFromPreviewUrl(entry.url);
    if (!gistId) {
      Logger.log(entry.date + '　⚠ 無法從目錄網址解析 Gist ID：' + entry.url);
      return;
    }
    const html = fetchGistHtml(gistId, githubToken);
    const issues = detectHtmlIssues(html);
    const flag = repaired.indexOf(entry.date) !== -1 ? '（已補修過）' : '';
    if (issues.length === 0) {
      Logger.log(entry.date + '　✓ 看起來沒有已知問題 ' + flag);
    } else {
      Logger.log(entry.date + '　' + issues.join('；') + ' ' + flag);
    }
    Utilities.sleep(300);
  });
}

/**
 * 把 2022-12-25 起、還沒上架的 PDF，從最舊開始每天轉 1 份。
 * 會呼叫 Gemini，請用每日時間觸發器，不要一次跑完。
 */
function backfillUnpublishedSlowly() {
  const props = PropertiesService.getScriptProperties();
  const GEMINI_API_KEY = props.getProperty('GEMINI_API_KEY');
  const GITHUB_TOKEN   = props.getProperty('GITHUB_TOKEN');
  if (!GEMINI_API_KEY || !GITHUB_TOKEN) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  if (isGeminiCoolingDown()) {
    Logger.log('⏸ Gemini 冷卻中，改跑 repairPublishedWithoutGemini()');
    repairPublishedWithoutGemini();
    return;
  }

  const indexState = loadIndexGist(GITHUB_TOKEN);
  const publishedDates = {};
  (indexState && indexState.list ? indexState.list : []).forEach(function (e) {
    if (e && e.date) publishedDates[e.date] = true;
  });

  const deaconFolder = DriveApp.getFolderById(DEACON_FOLDER_ID);
  const allPdfFiles = getAllPdfFilesRecursive(deaconFolder);
  const candidates = allPdfFiles.filter(function (f) {
    const d = extractDateFromFilename(f.getName());
    return d >= MIN_BULLETIN_DATE && !publishedDates[d];
  }).sort(function (a, b) {
    return extractDateFromFilename(a.getName()).localeCompare(extractDateFromFilename(b.getName()));
  });

  if (candidates.length === 0) {
    Logger.log('✅ 沒有尚未上架的歷史週報。');
    return;
  }
  Logger.log('📄 尚未上架：' + candidates.length + ' 份，本次從最舊開始處理 ' + BACKFILL_BATCH_LIMIT + ' 份');
  const batch = candidates.slice(0, BACKFILL_BATCH_LIMIT);
  for (const file of batch) {
    Logger.log('▶ 回補：' + file.getName());
    try {
      processOneBulletin(file, GEMINI_API_KEY, GITHUB_TOKEN, { useGemini: true });
      markAsProcessed(file.getId());
    } catch (e) {
      Logger.log('❌ 回補失敗：' + e.message);
      if (/429/.test(String(e.message))) break;
    }
    Utilities.sleep(4000);
  }
}

function repairOneDate(dateStr) {
  const props = PropertiesService.getScriptProperties();
  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  const indexState = loadIndexGist(githubToken);
  const entry = (indexState.list || []).find(function (e) { return e.date === dateStr; });
  if (!entry) {
    Logger.log('❌ 目錄找不到日期：' + dateStr);
    return;
  }
  const result = repairOneIndexEntry(entry, buildPdfDateIndex(), githubToken);
  if (result.previewUrl && result.previewUrl !== entry.url) {
    entry.url = result.previewUrl;
    saveIndexList(indexState, githubToken);
  }
  markDateRepaired(dateStr);
  Logger.log('✅ 指定日期補修完成：' + dateStr);
}

function resetRepairCursor() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(REPAIR_CURSOR_KEY);
  props.deleteProperty(REPAIRED_DATES_KEY);
  Logger.log('✅ 已清除補修進度。下次 repairPublishedWithoutGemini() 會從最舊一期重跑（仍不呼叫 Gemini）。');
}

/**
 * 測試期一次到位：
 *  1) 網站目錄只留 2026-09-27（其他期只從目錄拿掉，Gist 檔案還在）
 *  2) 用 Gemini 重新辨識 2026-09-20，再放回網站
 *
 * 之後排程只會：更新已上架的期數（含幹事覆蓋 PDF）、以及比目前最新一期更晚的新主日。
 */
function startTestingPeriod() {
  Logger.log('=== 測試期：目錄只留 2026-09-27，並重辨識 2026-09-20 ===');
  keepOnlyWebsiteDates(['2026-09-27']);
  reprocessDateWithGemini('2026-09-20');
  Logger.log('🎉 請重新整理 https://tkch-weeknews-all.netlify.app/ 應只剩 9/27 與剛上架的 9/20。');
}

/** 只改網站目錄，不刪 Drive PDF、也不刪 Gist 檔（之後要加回來很快）。 */
function keepOnlyWebsiteDates(keepDates) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  const allow = {};
  (keepDates || []).forEach(function (d) { allow[d] = true; });
  const indexState = loadIndexGist(token);
  if (!indexState) {
    Logger.log('❌ 找不到目錄 Gist');
    return;
  }
  const before = (indexState.list || []).length;
  indexState.list = (indexState.list || []).filter(function (e) { return e && allow[e.date]; });
  saveIndexList(indexState, token);
  Logger.log('✓ 目錄從 ' + before + ' 筆改為 ' + indexState.list.length + ' 筆：' +
    indexState.list.map(function (e) { return e.date; }).join(', '));
}

function reprocessDateWithGemini(dateStr) {
  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty('GEMINI_API_KEY');
  const token = props.getProperty('GITHUB_TOKEN');
  if (!geminiKey || !token) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  if (isGeminiCoolingDown()) {
    Logger.log('⏸ Gemini 冷卻中，稍後再跑 reprocessDateWithGemini("' + dateStr + '")');
    return;
  }
  const file = findPdfForDate(dateStr);
  if (!file) {
    Logger.log('❌ 找不到日期 ' + dateStr + ' 的 PDF（請確認幹事資料夾或個人備份檔名含 ' + dateStr.replace(/-/g, '') + '）');
    return;
  }
  Logger.log('🎯 重新辨識：' + file.getName() + ' → ' + dateStr);
  processOneBulletin(file, geminiKey, token, { useGemini: true, replaceBackup: true });
  markAsProcessed(file.getId());
  markFileState(file, dateStr);
  Logger.log('✅ ' + dateStr + ' 已重新辨識並寫入網站目錄');
}

function findPdfForDate(dateStr) {
  const map = buildPdfDateIndex();
  if (map[dateStr]) return map[dateStr];
  const compact = String(dateStr || '').replace(/-/g, '');
  const folders = [DEACON_FOLDER_ID, PERSONAL_FOLDER_ID];
  for (let i = 0; i < folders.length; i++) {
    try {
      const files = getAllPdfFilesRecursive(DriveApp.getFolderById(folders[i]));
      const matched = files.filter(function (f) {
        return extractDateFromFilename(f.getName()) === dateStr || f.getName().indexOf(compact) !== -1;
      });
      const newest = pickNewestPdf(matched);
      if (newest) return newest;
    } catch (e) {
      Logger.log('⚠ 搜尋資料夾失敗：' + e.message);
    }
  }
  return null;
}

function getAllPdfFilesRecursive(folder) {
  let results = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toUpperCase().endsWith('.PDF')) results.push(f);
  }
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    results = results.concat(getAllPdfFilesRecursive(subFolders.next()));
  }
  return results;
}

function processOneBulletin(file, geminiApiKey, githubToken, options) {
  options = options || {};
  const useGemini = options.useGemini !== false;
  const replaceBackup = !!options.replaceBackup;

  Logger.log('  [1/6] 複製備份至個人資料夾...');
  backupPdfToPersonal(file, replaceBackup);

  Logger.log('  [2/6] 讀取 PDF 並抽取原始超連結...');
  const pdfBytes  = file.getBlob().getBytes();
  const pdfBase64 = Utilities.base64Encode(pdfBytes);
  Logger.log('       ✓ PDF 大小：' + Math.round(pdfBytes.length / 1024) + ' KB');

  const extractedUrls = extractUrlsFromPdf(file);
  Logger.log('       ✓ 從 PDF 抽取真實網址數：' + extractedUrls.length + ' 個');
  if (extractedUrls.length > 0) {
    Logger.log('         真實連結清單：\n         ' + extractedUrls.join('\n         '));
  } else {
    Logger.log('       ⚠ 註解層沒有抽到網址（可能是 QR 圖而不是 PDF 超連結）。將改以關鍵字強制放入常設按鈕。');
  }

  const fallbackDateStr = extractDateFromFilename(file.getName());
  Logger.log('  [3/6] 檔名推估日期：' + fallbackDateStr);

  let result;
  if (useGemini) {
    Logger.log('  [4/6] 呼叫 Gemini AI 辨識內文與排版...');
    result = callGeminiWithPdf(pdfBase64, fallbackDateStr, geminiApiKey, extractedUrls);
  } else {
    throw new Error('processOneBulletin 缺少 HTML：補修請改走 repairPublishedWithoutGemini()');
  }

  Logger.log('  [5/6] 後處理：還原真實超連結 + 錯字／人名校正...');
  const resolvedUrls = resolveUrlsMetadata(extractedUrls);
  const finalHtml = finalizeBulletinHtml(result.html, resolvedUrls);

  const finalDate = result.date || fallbackDateStr;
  const volume    = parseInt(result.volume, 10) || 0;
  const issue     = parseInt(result.issue, 10) || 0;
  const title     = result.title || ('第 ' + volume + ' 卷第 ' + issue + ' 期');
  Logger.log('       ✓ 辨識卷期：第 ' + volume + ' 卷第 ' + issue + ' 期');
  Logger.log('       ✓ 辨識主日：' + finalDate);

  Logger.log('  [6/6] 上傳至 GitHub Gist（同一日期會覆蓋，不再開新 Gist）...');
  const gistFilename = 'tkch-bulletin-' + finalDate + '.html';
  const gistTitle    = '德光長老教會週報 ' + finalDate;
  const uploaded     = upsertHtmlGist(finalHtml, gistFilename, gistTitle, githubToken, finalDate);
  Logger.log('       ✓ 公開網址：' + uploaded.previewUrl);

  updateBulletinIndex({
    volume:      volume,
    issue:       issue,
    title:       title,
    url:         uploaded.previewUrl,
    date:        finalDate,
    publishedAt: finalDate + 'T00:00:00.000Z',
  }, githubToken);
  Logger.log('       ✓ 歷期目錄索引已更新！');
  markFileState(file, finalDate);

  // ★ 發布成功，自動寄送 Email 通知
  sendPublishNotification({
    date: finalDate,
    title: title,
    previewUrl: uploaded.previewUrl,
    fileName: file.getName()
  });
}

/**
 * 📧 寄送週報上架通知信至指定的管理員信箱
 */
function sendPublishNotification(data) {
  if (!NOTIFICATION_EMAILS || NOTIFICATION_EMAILS.length === 0) return;
  const recipient = NOTIFICATION_EMAILS.join(',');
  const subject = '【德光週報發布通知】' + data.date + ' (' + data.title + ')';

  const bodyText =
    '平安！\n\n' +
    '德光長老教會主日週報已自動完成 AI 排版與發布：\n\n' +
    '• 主日日期：' + data.date + '\n' +
    '• 週報卷期：' + data.title + '\n' +
    '• 原始檔案：' + data.fileName + '\n' +
    '• 線上閱讀：' + data.previewUrl + '\n' +
    '• 歷期目錄：https://tkch-weeknews-all.netlify.app/\n\n' +
    '系統已自動排除奉獻資料、校對專有名詞（劉娗坊、教界消息）並注入活動超連結。\n' +
    '此信件由德光週報自動化系統發送。';

  const htmlBody =
    '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, \'Helvetica Neue\', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 12px; background-color: #FFFFFF;">' +
      '<div style="text-align: center; margin-bottom: 20px;">' +
        '<span style="font-size: 28px;">✝</span>' +
        '<h2 style="margin: 8px 0 4px; color: #1E293B;">德光長老教會週報發布通知</h2>' +
        '<p style="color: #64748B; font-size: 14px; margin: 0;">自動化排程已完成新週報處理與上架</p>' +
      '</div>' +
      '<div style="background-color: #F8FAFC; border-radius: 8px; padding: 16px; margin-bottom: 20px; border-left: 4px solid #5850EC;">' +
        '<p style="margin: 6px 0; color: #334155;"><strong>📅 主日日期：</strong>' + data.date + '</p>' +
        '<p style="margin: 6px 0; color: #334155;"><strong>📖 週報卷期：</strong>' + data.title + '</p>' +
        '<p style="margin: 6px 0; color: #334155;"><strong>📄 原始檔案：</strong>' + data.fileName + '</p>' +
      '</div>' +
      '<div style="text-align: center; margin: 28px 0;">' +
        '<a href="' + data.previewUrl + '" target="_blank" style="display: inline-block; background-color: #5850EC; color: #FFFFFF; font-weight: bold; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; box-shadow: 0 4px 6px -1px rgba(88, 80, 236, 0.2);">' +
          '📖 立即閱讀本週週報 →' +
        '</a>' +
      '</div>' +
      '<div style="border-top: 1px solid #E2E8F0; padding-top: 16px; margin-top: 20px; font-size: 13px; color: #64748B; line-height: 1.6;">' +
        '<p style="margin: 4px 0;">🌐 歷期週報首頁：<a href="https://tkch-weeknews-all.netlify.app/" target="_blank" style="color: #5850EC;">tkch-weeknews-all.netlify.app</a></p>' +
        '<p style="margin: 4px 0;">✨ 系統已自動排除奉獻明細、正規化同工姓名（劉娗坊），並已植入活動報名超連結。</p>' +
      '</div>' +
    '</div>';

  try {
    MailApp.sendEmail({
      to: recipient,
      subject: subject,
      body: bodyText,
      htmlBody: htmlBody
    });
    Logger.log('       📧 已成功寄送通知信至：' + recipient);
  } catch (e) {
    Logger.log('       ⚠️ 寄送通知信失敗：' + e.message);
  }
}

/**
 * 🧪 測試郵件通知（可隨時在 Apps Script 執行，測試信箱能否收到）
 */
function testEmailNotification() {
  Logger.log('🧪 正在發送測試信至：' + NOTIFICATION_EMAILS.join(', '));
  sendPublishNotification({
    date: '2026-09-27',
    title: '第 33 卷第 39 期（測試通知）',
    fileName: '20260927教會周報鏈接檔.pdf',
    previewUrl: 'https://tkch-weeknews-all.netlify.app/'
  });
  Logger.log('🎉 測試郵件發送完成！請檢查您的收件匣（及垃圾郵件匣）。');
}

function backupPdfToPersonal(file, replaceBackup) {
  const personalFolder = DriveApp.getFolderById(PERSONAL_FOLDER_ID);
  const existing = personalFolder.getFilesByName(file.getName());
  if (existing.hasNext()) {
    if (!replaceBackup) {
      Logger.log('       ⏭ 備份已存在，略過複製');
      return;
    }
    while (true) {
      existing.next().setTrashed(true);
      if (!existing.hasNext()) break;
    }
    Logger.log('       ✓ 已換成新的個人備份');
  }
  file.makeCopy(file.getName(), personalFolder);
  if (!replaceBackup) Logger.log('       ✓ 備份完成');
}

function repairOneIndexEntry(entry, pdfIndex, githubToken) {
  const gistId = parseGistIdFromPreviewUrl(entry.url) || getGistIdByDate(entry.date);
  if (!gistId) throw new Error('找不到 Gist ID');
  const originalHtml = fetchGistHtml(gistId, githubToken);
  if (!originalHtml) throw new Error('Gist HTML 為空');

  let extractedUrls = [];
  const pdfFile = pdfIndex[entry.date];
  if (pdfFile) {
    extractedUrls = extractUrlsFromPdf(pdfFile);
    Logger.log('       PDF：' + pdfFile.getName() + '　抽出 ' + extractedUrls.length + ' 個網址');
  } else {
    Logger.log('       ⚠ 找不到對應 PDF，只修常設按鈕、假網址與錯字／人名');
  }
  const resolvedUrls = resolveUrlsMetadata(extractedUrls);
  const finalHtml = finalizeBulletinHtml(originalHtml, resolvedUrls);
  const changed = finalHtml !== originalHtml;
  const filename = 'tkch-bulletin-' + entry.date + '.html';
  if (changed) {
    patchGistHtml(gistId, filename, finalHtml, githubToken);
  }
  rememberGistId(entry.date, gistId);
  return {
    changed: changed,
    previewUrl: toStablePreviewUrl(gistId, filename)
  };
}

function callGeminiWithPdf(pdfBase64, fallbackDateStr, apiKey, extractedUrls) {
  const resolvedUrls = resolveUrlsMetadata(extractedUrls);
  const urlsContext = buildUrlsContext(resolvedUrls);

  const systemPrompt =
`你是德光長老教會週報的數位排版助理，也是嚴謹的繁體中文校對者。
任務：把這份週報 PDF 轉成適合手機與電腦閱讀的響應式 HTML。

═══════════════════════════════
【規則 1】嚴格排除奉獻資料
═══════════════════════════════
絕對不得包含任何與奉獻相關的內容，包括：
- 奉獻金額、奉獻總計、感謝奉獻、本週奉獻、各項基金收支
- 奉獻芳名錄、個人姓名搭配金額的表格或條目
請直接略過所有奉獻段落，不需留下任何省略提示。

${urlsContext}

═══════════════════════════════
【規則 2】回傳格式
═══════════════════════════════
你的回覆第一行必須是精確的 JSON 標頭，格式如下（不要加 markdown 標記）：
META:{"volume":33,"issue":24,"date":"2026-09-27","title":"第 33 卷第 24 期"}
（請從週報首頁印製的文字自動擷取：卷數 volume、期數 issue、主日西元日期 date）
第二行開始輸出完整的 HTML 代碼（包含 <!DOCTYPE html>、<html>、<head>、<body> 等）。
切勿在 HTML 頭尾加上 \`\`\`html 或 \`\`\` 符號。

═══════════════════════════════
【規則 3】排版、用語與錯字
═══════════════════════════════
1. 主要章節（教會消息、牧區消息、教界消息、本週事奉表、代禱事項、主日講道大綱等）使用 <details><summary> 做成可展開收合的摺疊框。
   【重要】所有 <details> 預設必須收合，不可加 open 屬性。
2. 【用詞必須完全一致】
   - 章節名稱是「教界消息」（台南中會、友會消息）。嚴禁「業界消息」「界界消息」「教際消息」。
   - 「事奉表」不是「侍奉表」或「事俸表」。
   - 「代禱事項」不是「帶禱事項」。
   - 「週報」不是「周報」。
   - 「慕道班」不是「慕道版」。
   - 「擘餅」不是「掰餅」。
   - 教會全名是「德光長老教會」。
3. 一律使用台灣繁體中文，禁止簡體字（会/学/礼/祷/经/长/圣/团 等）。
4. 【專有名詞白名單——OCR 幾乎一定會錯，必須照抄】
   - 事奉表人名「劉娗坊」（中間是女字旁＋廷，Unicode U+5A17）。
     嚴禁寫成 劉嫆坊、劉媞坊、劉婷坊、劉挺坊、劉廷坊、劉庭坊。
     週報裡凡是「劉○坊」都是同一人，輸出必須是「劉娗坊」。
5. 頂部 Header：優雅顯示「德光長老教會」、「主日禮拜週報」及主日日期。
6. 風格配色：白底、深灰文字 #334155、高雅金 #C9A84C、莫蘭迪藍 #5850EC。
7. 版面居中，最大寬度 650px，邊距適中，完美適應手機螢幕。
8. 事奉人員分配表需支援手機橫向滑動排版。
9. 超連結按鈕使用 class="qr-link"，並加 target="_blank" rel="noopener noreferrer"。
   禁止 href="#"、禁止 lin.ee/example、禁止 example.com、禁止把網址寫成省略號。`;

  const userPrompt = '請將這份週報 PDF 轉為 HTML。推估主日日期約為 ' + fallbackDateStr + '，請以 PDF 內文印製的實際日期與卷期為主。所有按鈕網址必須使用系統提供的完整網址，禁止省略。人名「劉娗坊」必須照抄。輸出前請再校對「教界消息」與繁體用字。';

  const requestBody = {
    contents: [{
      parts: [
        { text: systemPrompt },
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: userPrompt }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 32768
    }
  };

  const fetchOptions = {
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': apiKey.trim()
    },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  };

  for (const model of GEMINI_MODELS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey.trim());
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = UrlFetchApp.fetch(url, fetchOptions);
      const status   = response.getResponseCode();
      if (status === 429) {
        rememberGemini429();
        throw new Error('Gemini HTTP 429 配額已用盡，本次整批停止。請隔數小時再跑，或先執行 repairPublishedWithoutGemini()。');
      }
      if (status === 503 && attempt === 1) {
        Logger.log('       ⏳ ' + model + ' 暫時忙碌，等待 4 秒後重試...');
        Utilities.sleep(4000);
        continue;
      }
      if (status !== 200) {
        const errSnippet = response.getContentText().slice(0, 150);
        Logger.log('       ⚠️ ' + model + ' 回應 HTTP ' + status + '：' + errSnippet);
        break;
      }
      const resJson = JSON.parse(response.getContentText());
      const candidate = (resJson.candidates || [])[0] || {};
      const rawText = (candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
      if (!rawText) {
        Logger.log('       ⚠️ ' + model + ' 回傳內容為空');
        break;
      }
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        Logger.log('       ⚠️ 模型結束原因：' + candidate.finishReason + '（若為 MAX_TOKENS 將嘗試補上結尾標籤）');
      }
      Logger.log('       ✓ 成功使用模型：' + model);
      return parseGeminiResponse(rawText, fallbackDateStr);
    }
  }
  throw new Error('所有 Gemini 模型均調用失敗，請先執行 testGeminiConnection() 查看診斷資訊。');
}

function buildUrlsContext(resolvedUrls) {
  const knownList = KNOWN_ACTIVITY_BUTTONS.map(function (item, idx) {
    return (idx + 1) + '. ' + item.keys[0] + '：\n   必須放置：<p><a href="' + item.href + '" target="_blank" rel="noopener noreferrer" class="qr-link">' + item.label + '</a></p>';
  }).join('\n');

  const extraItems = (resolvedUrls || []).filter(function (item) {
    if (item.isOffering) return false;
    const alreadyKnown = KNOWN_ACTIVITY_BUTTONS.some(function (k) {
      return item.url.indexOf(k.match) !== -1;
    });
    return !alreadyKnown;
  });

  let extraBlock = '本次 PDF 未抽出額外新網址。若畫面有 QR Code，請對照上方常設清單，禁止自己發明或截斷網址。';
  if (extraItems.length > 0) {
    extraBlock = extraItems.map(function (item, idx) {
      return (idx + 1) + '. 【' + item.label + '】\n   真實網址：' + item.url + '\n   對應說明：' + item.desc;
    }).join('\n\n');
  }

  return (
    '═══════════════════════════════════════════════════════\n' +
    '【核心指令：超連結（有提到活動就必須放入完整網址）】\n' +
    '═══════════════════════════════════════════════════════\n' +
    '你禁止自己發明、改寫、縮短或加省略號（... 或 …）到任何網址。\n' +
    '禁止輸出 href="#"、https://lin.ee/example、https://example.com。\n' +
    'HTML 裡每一個 href 必須是下面提供的【完整字串】，一個字都不能少。\n' +
    '若 PDF 上的 QR Code 看不清，仍然必須使用下列完整網址，不要猜測。\n\n' +
    '【常設活動按鈕——內文只要出現關鍵字就必須放入】：\n' +
    knownList + '\n\n' +
    '【從 PDF 註解層抽出的其他網址】：\n' +
    extraBlock + '\n\n' +
    '【嚴格排版要求】：\n' +
    '- 只要週報內文有提到「慕道班」「中保代禱」「從懷疑到相信」「小步走」「愛相隨」，就必須在該項目後附上對應按鈕。\n' +
    '- 嚴格禁止輸出任何包含 "..." 或 "…" 的網址。\n' +
    '- 嚴格排除任何奉獻連結與奉獻 QR Code。\n'
  );
}

function parseGeminiResponse(rawText, fallbackDateStr) {
  let text = String(rawText || '').trim();
  if (text.startsWith('```html')) text = text.slice(7);
  else if (text.startsWith('```')) text = text.slice(3);
  if (text.endsWith('```')) text = text.slice(0, -3);
  text = text.trim();

  let volume = 0, issue = 0, date = fallbackDateStr, title = '';
  const metaMatch = text.match(/META:\s*(\{[\s\S]*?\})/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      volume = meta.volume || 0;
      issue  = meta.issue  || 0;
      date   = meta.date   || fallbackDateStr;
      title  = meta.title  || '';
    } catch (e) {
      Logger.log('       ⚠️ META 解析異常');
    }
  }

  let html = text;
  const doctypeAt = text.search(/<!DOCTYPE/i);
  const htmlAt = text.search(/<html/i);
  const start = doctypeAt >= 0 ? doctypeAt : htmlAt;
  if (start >= 0) {
    html = text.slice(start).trim();
  } else {
    const lines = text.split('\n');
    let htmlStart = 0;
    if (lines[0] && lines[0].indexOf('META:') === 0) htmlStart = 1;
    html = lines.slice(htmlStart).join('\n').trim();
  }
  return { html: html, volume: volume, issue: issue, date: date, title: title };
}

function extractDateFromFilename(filename) {
  const m8 = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (m8) return m8[1] + '-' + m8[2] + '-' + m8[3];
  const m4 = filename.match(/^(\d{2})[-_]?(\d{2})/);
  if (m4) return '2023-' + m4[1] + '-' + m4[2];
  return '2020-01-01';
}

function githubHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
    'User-Agent':    'TkchWeekNews-AppsScript',
    'Accept':        'application/vnd.github+json'
  };
}

function listAllUserGists(githubToken) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = UrlFetchApp.fetch(
      'https://api.github.com/users/' + GITHUB_USERNAME + '/gists?per_page=100&page=' + page,
      { headers: githubHeaders(githubToken), muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      throw new Error('列出 Gist 失敗 HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 160));
    }
    const batch = JSON.parse(res.getContentText());
    if (!batch.length) break;
    for (let i = 0; i < batch.length; i++) all.push(batch[i]);
    if (batch.length < 100) break;
    Utilities.sleep(200);
  }
  return all;
}

function toStablePreviewUrl(gistId, filename) {
  const raw = 'https://gist.githubusercontent.com/' + GITHUB_USERNAME + '/' + gistId + '/raw/' + encodeURIComponent(filename);
  return 'https://htmlpreview.github.io/?' + raw;
}

function parseGistIdFromPreviewUrl(url) {
  const m = String(url || '').match(/gist\.githubusercontent\.com\/[^/]+\/([a-f0-9]+)\//i)
    || String(url || '').match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
  return m ? m[1] : '';
}

function getGistMap() {
  const raw = PropertiesService.getScriptProperties().getProperty(GIST_MAP_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function rememberGistId(dateStr, gistId) {
  const map = getGistMap();
  map[dateStr] = gistId;
  PropertiesService.getScriptProperties().setProperty(GIST_MAP_KEY, JSON.stringify(map));
}

function getGistIdByDate(dateStr) {
  return getGistMap()[dateStr] || '';
}

function upsertHtmlGist(htmlContent, filename, description, githubToken, dateStr) {
  let gistId = getGistIdByDate(dateStr);
  if (!gistId) {
    const gists = listAllUserGists(githubToken);
    const found = gists.find(function (g) {
      return g.files && g.files[filename];
    });
    if (found) gistId = found.id;
  }
  if (gistId) {
    patchGistHtml(gistId, filename, htmlContent, githubToken);
    rememberGistId(dateStr, gistId);
    return { gistId: gistId, previewUrl: toStablePreviewUrl(gistId, filename), created: false };
  }
  const res = UrlFetchApp.fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: githubHeaders(githubToken),
    payload: JSON.stringify({
      description: description,
      public: true,
      files: { [filename]: { content: htmlContent } }
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 201) {
    throw new Error('GitHub Gist 上傳失敗: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  const data = JSON.parse(res.getContentText());
  rememberGistId(dateStr, data.id);
  return { gistId: data.id, previewUrl: toStablePreviewUrl(data.id, filename), created: true };
}

function patchGistHtml(gistId, filename, htmlContent, githubToken) {
  const res = UrlFetchApp.fetch('https://api.github.com/gists/' + gistId, {
    method: 'PATCH',
    headers: githubHeaders(githubToken),
    payload: JSON.stringify({
      files: { [filename]: { content: htmlContent } }
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Gist PATCH 失敗 HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
}

function fetchGistHtml(gistId, githubToken) {
  const res = UrlFetchApp.fetch('https://api.github.com/gists/' + gistId, {
    headers: githubHeaders(githubToken),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('讀取 Gist 失敗 HTTP ' + res.getResponseCode());
  }
  const detail = JSON.parse(res.getContentText());
  const files = detail.files || {};
  const names = Object.keys(files);
  for (let i = 0; i < names.length; i++) {
    if (/\.html$/i.test(names[i]) && files[names[i]].content) return files[names[i]].content;
  }
  return (files[names[0]] && files[names[0]].content) || '';
}

function findIndexGist(githubToken) {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(INDEX_GIST_ID_KEY);
  if (cached) return cached;
  const gists = listAllUserGists(githubToken);
  const found = gists.find(function (g) { return g.description === INDEX_DESCRIPTION; });
  if (!found) return '';
  props.setProperty(INDEX_GIST_ID_KEY, found.id);
  return found.id;
}

function loadIndexGist(githubToken) {
  const id = findIndexGist(githubToken);
  if (!id) return null;
  const res = UrlFetchApp.fetch('https://api.github.com/gists/' + id, {
    headers: githubHeaders(githubToken),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('讀取目錄 Gist 失敗 HTTP ' + res.getResponseCode());
  }
  const detail = JSON.parse(res.getContentText());
  const content = detail.files[INDEX_FILENAME] && detail.files[INDEX_FILENAME].content;
  let list = [];
  if (content) {
    try { list = JSON.parse(content); } catch (e) { list = []; }
  }
  return { id: id, list: Array.isArray(list) ? list : [] };
}

function saveIndexList(indexState, githubToken) {
  const list = dedupeIndexByDate(indexState.list);
  list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
  UrlFetchApp.fetch('https://api.github.com/gists/' + indexState.id, {
    method: 'PATCH',
    headers: githubHeaders(githubToken),
    payload: JSON.stringify({
      description: INDEX_DESCRIPTION,
      files: { [INDEX_FILENAME]: { content: JSON.stringify(list, null, 2) } }
    }),
    muteHttpExceptions: true
  });
  indexState.list = list;
}

function dedupeIndexByDate(list) {
  const byDate = {};
  (list || []).forEach(function (e) {
    if (!e || !e.date) return;
    const prev = byDate[e.date];
    if (!prev) {
      byDate[e.date] = e;
      return;
    }
    const prevScore = (Number(prev.volume) || 0) * 1000 + (Number(prev.issue) || 0);
    const nextScore = (Number(e.volume) || 0) * 1000 + (Number(e.issue) || 0);
    if (nextScore >= prevScore) byDate[e.date] = e;
  });
  return Object.keys(byDate).map(function (k) { return byDate[k]; });
}

function updateBulletinIndex(newEntry, githubToken) {
  let indexState = loadIndexGist(githubToken);
  if (!indexState) {
    const res = UrlFetchApp.fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: githubHeaders(githubToken),
      payload: JSON.stringify({
        description: INDEX_DESCRIPTION,
        public: true,
        files: { [INDEX_FILENAME]: { content: JSON.stringify([newEntry], null, 2) } }
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 201) {
      const data = JSON.parse(res.getContentText());
      PropertiesService.getScriptProperties().setProperty(INDEX_GIST_ID_KEY, data.id);
    }
    return;
  }
  const existing = indexState.list;
  let idx = existing.findIndex(function (e) { return e.date && e.date === newEntry.date; });
  if (idx === -1 && newEntry.volume > 0) {
    idx = existing.findIndex(function (e) { return e.volume === newEntry.volume && e.issue === newEntry.issue; });
  }
  if (idx !== -1) existing[idx] = newEntry;
  else existing.unshift(newEntry);
  saveIndexList(indexState, githubToken);
}

function sortCurrentIndexGist() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('❌ 尚未設定 GITHUB_TOKEN');
    return;
  }
  const indexState = loadIndexGist(token);
  if (!indexState) {
    Logger.log('❌ 找不到目錄 Gist');
    return;
  }
  indexState.list.forEach(function (item) {
    if (item.date) item.publishedAt = item.date + 'T00:00:00.000Z';
    const gistId = parseGistIdFromPreviewUrl(item.url);
    const filename = 'tkch-bulletin-' + item.date + '.html';
    if (gistId && item.date) item.url = toStablePreviewUrl(gistId, filename);
  });
  saveIndexList(indexState, token);
  Logger.log('🎉 排序完成，且目錄網址已改為穩定連結。最新：' +
    (indexState.list[0] ? (indexState.list[0].title + ' (' + indexState.list[0].date + ')') : '無'));
}

/**
 * dryRun=true 只列出重複 Gist；dryRun=false 才刪除「目錄沒有用到」的重複項。
 * 請先 true 看 Log，確認後再 false。
 */
function dedupeDuplicateGists(dryRun) {
  if (dryRun === undefined) dryRun = true;
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('❌ 尚未設定 GITHUB_TOKEN');
    return;
  }
  const indexState = loadIndexGist(token);
  const keepIds = {};
  if (indexState && indexState.id) keepIds[indexState.id] = 'index';
  (indexState && indexState.list ? indexState.list : []).forEach(function (e) {
    const id = parseGistIdFromPreviewUrl(e.url);
    if (id) keepIds[id] = e.date;
  });
  const gists = listAllUserGists(token);
  const byFile = {};
  gists.forEach(function (g) {
    const names = Object.keys(g.files || {});
    names.forEach(function (name) {
      if (!/^tkch-bulletin-\d{4}-\d{2}-\d{2}\.html$/.test(name)) return;
      if (!byFile[name]) byFile[name] = [];
      byFile[name].push(g);
    });
  });
  let deleteCount = 0;
  Object.keys(byFile).forEach(function (name) {
    const group = byFile[name];
    if (group.length < 2) return;
    Logger.log(name + ' 有 ' + group.length + ' 份重複');
    group.forEach(function (g) {
      const keep = !!keepIds[g.id];
      Logger.log('   ' + (keep ? '保留' : '多餘') + '  ' + g.id + '  ' + g.created_at);
      if (!keep && !dryRun) {
        UrlFetchApp.fetch('https://api.github.com/gists/' + g.id, {
          method: 'DELETE',
          headers: githubHeaders(token),
          muteHttpExceptions: true
        });
        deleteCount += 1;
        Utilities.sleep(400);
      }
    });
  });
  Logger.log(dryRun
    ? '這是預覽，沒有刪除。確認 Log 後再執行 dedupeDuplicateGists(false)'
    : ('已刪除多餘 Gist：' + deleteCount + ' 份'));
}

function getProcessedIds() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function markAsProcessed(fileId) {
  const ids = getProcessedIds();
  if (ids.indexOf(fileId) === -1) {
    ids.push(fileId);
    PropertiesService.getScriptProperties().setProperty(PROCESSED_KEY, JSON.stringify(ids));
  }
}

function getRepairedDates() {
  const raw = PropertiesService.getScriptProperties().getProperty(REPAIRED_DATES_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function markDateRepaired(dateStr) {
  const dates = getRepairedDates();
  if (dates.indexOf(dateStr) === -1) {
    dates.push(dateStr);
    PropertiesService.getScriptProperties().setProperty(REPAIRED_DATES_KEY, JSON.stringify(dates));
  }
}

function clearProcessedHistory() {
  PropertiesService.getScriptProperties().deleteProperty(PROCESSED_KEY);
  Logger.log('✅ 已清除已處理歷史記錄！');
}

function isGeminiCoolingDown() {
  const raw = PropertiesService.getScriptProperties().getProperty(LAST_GEMINI_429_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  return ts && (Date.now() - ts) < GEMINI_COOLDOWN_MS;
}

function rememberGemini429() {
  PropertiesService.getScriptProperties().setProperty(LAST_GEMINI_429_KEY, String(Date.now()));
}

function setupApiKeys() {
  PropertiesService.getScriptProperties().setProperties({
    'GEMINI_API_KEY': '在此貼上您的 Gemini API 金鑰',
    'GITHUB_TOKEN':   '在此貼上您的 GitHub Token',
  });
  Logger.log('✅ 請把上面兩組佔位文字改成您自己的金鑰後再執行一次 setupApiKeys()');
  Logger.log('⚠ 若金鑰曾貼在聊天或腳本裡公開過，請先到 Google AI Studio / GitHub 撤銷舊金鑰再換新的。');
}

function testGeminiConnection() {
  const props = PropertiesService.getScriptProperties();
  const key   = props.getProperty('GEMINI_API_KEY');
  if (!key) {
    Logger.log('❌ 尚未儲存 GEMINI_API_KEY，請先執行 setupApiKeys()');
    return;
  }
  Logger.log('🔍 正在檢測 Gemini API 金鑰狀態...');
  Logger.log('   金鑰前綴：' + key.slice(0, 10) + '... (長度: ' + key.length + ')');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key.trim());
  const options = {
    method: 'GET',
    headers: { 'x-goog-api-key': key.trim() },
    muteHttpExceptions: true
  };
  try {
    const res    = UrlFetchApp.fetch(url, options);
    const status = res.getResponseCode();
    Logger.log('   HTTP 回應狀態碼：' + status);
    if (status === 200) {
      const data = JSON.parse(res.getContentText());
      const models = (data.models || []).map(function (m) { return m.name.replace('models/', ''); });
      Logger.log('🎉 金鑰驗證成功！該金鑰支援的模型清單：');
      Logger.log('   ' + models.slice(0, 10).join(', '));
    } else {
      Logger.log('❌ API 回應錯誤訊息：');
      Logger.log(res.getContentText());
    }
  } catch (e) {
    Logger.log('❌ 連線發生例外：' + e.message);
  }
}

function diagnoseLatestPdf() {
  Logger.log('🔍 診斷最新週報 PDF 的原始超連結...');
  const deaconFolder = DriveApp.getFolderById(DEACON_FOLDER_ID);
  const allPdfFiles = getAllPdfFilesRecursive(deaconFolder);
  allPdfFiles.sort(function (a, b) {
    return extractDateFromFilename(b.getName()).localeCompare(extractDateFromFilename(a.getName()));
  });
  const latestFile = allPdfFiles[0];
  if (!latestFile) {
    Logger.log('❌ 找不到任何週報 PDF 檔案');
    return;
  }
  Logger.log('🎯 檔案：' + latestFile.getName());
  const urls = extractUrlsFromPdf(latestFile);
  Logger.log('📎 抽出 ' + urls.length + ' 個網址：');
  urls.forEach(function (u, i) { Logger.log('   ' + (i + 1) + '. ' + u); });
  const resolved = resolveUrlsMetadata(urls);
  resolved.forEach(function (item) {
    Logger.log('   → ' + item.label + (item.isOffering ? '（將排除）' : '') + ' | ' + item.url);
  });
  if (urls.length === 0) {
    Logger.log('⚠ 若週報上的連結其實是 QR 圖片而不是可點的 PDF 註解，這是正常的。會改用關鍵字強制放入常設按鈕。');
  }
}

function reprocessLatestBulletin() {
  Logger.log('🔄 開始重新處理最新一期週報...');
  const props = PropertiesService.getScriptProperties();
  const GEMINI_API_KEY = props.getProperty('GEMINI_API_KEY');
  const GITHUB_TOKEN   = props.getProperty('GITHUB_TOKEN');
  if (!GEMINI_API_KEY || !GITHUB_TOKEN) {
    Logger.log('❌ 請先執行 setupApiKeys()');
    return;
  }
  if (isGeminiCoolingDown()) {
    Logger.log('⏸ Gemini 冷卻中，請稍後再重跑最新一期。');
    return;
  }
  const deaconFolder = DriveApp.getFolderById(DEACON_FOLDER_ID);
  const allPdfFiles = getAllPdfFilesRecursive(deaconFolder);
  allPdfFiles.sort(function (a, b) {
    return extractDateFromFilename(b.getName()).localeCompare(extractDateFromFilename(a.getName()));
  });
  const latestFile = allPdfFiles[0];
  if (!latestFile) {
    Logger.log('❌ 找不到任何週報 PDF 檔案');
    return;
  }
  Logger.log('🎯 鎖定最新週報檔案：' + latestFile.getName());
  try {
    processOneBulletin(latestFile, GEMINI_API_KEY, GITHUB_TOKEN, { useGemini: true });
    markAsProcessed(latestFile.getId());
    sortCurrentIndexGist();
    Logger.log('🎉 最新週報已重新處理完成，並已自動置頂！請重新整理網頁查看！');
  } catch (e) {
    Logger.log('❌ 處理失敗：' + e.message);
  }
}

function buildPdfDateIndex() {
  const map = {};
  function ingest(folderId, label) {
    try {
      const folder = DriveApp.getFolderById(folderId);
      const files = getAllPdfFilesRecursive(folder);
      files.forEach(function (f) {
        const d = extractDateFromFilename(f.getName());
        if (!d || d < MIN_BULLETIN_DATE) return;
        if (!map[d] || f.getLastUpdated().getTime() > map[d].getLastUpdated().getTime()) {
          map[d] = f;
        }
      });
      Logger.log('   ' + label + ' PDF：' + files.length + ' 份');
    } catch (e) {
      Logger.log('   ⚠ 無法讀取' + label + '：' + e.message);
    }
  }
  ingest(PERSONAL_FOLDER_ID, '個人備份');
  ingest(DEACON_FOLDER_ID, '幹事資料夾');
  return map;
}

function detectHtmlIssues(html) {
  const issues = [];
  if (!html) {
    issues.push('HTML 為空');
    return issues;
  }
  if (/href\s*=\s*["']#["']/.test(html)) issues.push('有 href="#"');
  if (/lin\.ee\/example|example\.com/i.test(html)) issues.push('有假網址 example');
  if (/\.\.\.|…/.test(html) && /href\s*=\s*["'][^"']*(\.\.\.|…)[^"']*["']/.test(html)) issues.push('網址被截斷');
  if (html.indexOf('業界消息') !== -1) issues.push('業界消息');
  const nounHits = html.match(/[劉刘](?!娗坊)[\u4e00-\u9fff]坊/g);
  if (nounHits && nounHits.length) issues.push('人名誤辨：' + unique(nounHits).join('、'));
  const hasKeyword = KNOWN_ACTIVITY_BUTTONS.some(function (item) {
    return item.keys.some(function (k) { return html.indexOf(k) !== -1; });
  });
  const hasRealButton = KNOWN_ACTIVITY_BUTTONS.some(function (item) {
    return html.indexOf(item.href) !== -1;
  });
  if (hasKeyword && !hasRealButton) issues.push('內文有活動關鍵字但缺少真實按鈕網址');
  return issues;
}

function unique(arr) {
  const seen = {};
  const out = [];
  (arr || []).forEach(function (x) {
    if (!seen[x]) {
      seen[x] = true;
      out.push(x);
    }
  });
  return out;
}

// ============================================================
// 🔗 從 PDF 抽取原始超連結
// ============================================================
function extractUrlsFromPdf(file) {
  const urls = [];
  const seen = {};

  function addUrl(raw) {
    const u = normalizeExtractedUrl(raw);
    if (!u || seen[u]) return;
    if (!isUsefulBulletinUrl(u)) return;
    seen[u] = true;
    urls.push(u);
  }

  try {
    const rawContent = file.getBlob().getDataAsString('ISO-8859-1');
    scanPdfUriLiterals(rawContent, addUrl);
    scanPdfUriHex(rawContent, addUrl);
    scanPlainUrlsFromText(rawContent, addUrl);
    inflateFlateStreamsAndScan(rawContent, addUrl);
  } catch (e) {
    Logger.log('  ⚠️ 抽取 PDF 內嵌網址異常：' + e.message);
  }
  return urls;
}

function scanPdfUriLiterals(rawContent, addUrl) {
  const re = /\/URI\s*\(/gi;
  let match;
  while ((match = re.exec(rawContent)) !== null) {
    const extracted = readPdfLiteralString(rawContent, match.index + match[0].length - 1);
    if (extracted) addUrl(extracted);
  }
}

function readPdfLiteralString(content, openParenIndex) {
  if (content.charAt(openParenIndex) !== '(') return '';
  let i = openParenIndex + 1;
  let depth = 1;
  let out = '';
  while (i < content.length && depth > 0) {
    const ch = content.charAt(i);
    if (ch === '\\') {
      const next = content.charAt(i + 1);
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth > 0) out += ch;
    i += 1;
  }
  return unescapePdfLiteral(out);
}

function unescapePdfLiteral(s) {
  if (!s) return '';
  return s
    .replace(/\\\r\n/g, '')
    .replace(/\\\n/g, '')
    .replace(/\\\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\([0-7]{1,3})/g, function (_, oct) {
      return String.fromCharCode(parseInt(oct, 8));
    })
    .replace(/\\([()\\])/g, '$1');
}

function scanPdfUriHex(rawContent, addUrl) {
  const re = /\/URI\s*<([0-9A-Fa-f\s]+)>/g;
  let match;
  while ((match = re.exec(rawContent)) !== null) {
    addUrl(hexToString(match[1]));
  }
}

function hexToString(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return '';
  let s = '';
  if (clean.slice(0, 4).toUpperCase() === 'FEFF') {
    for (let i = 4; i + 3 < clean.length; i += 4) {
      s += String.fromCharCode(parseInt(clean.substr(i, 4), 16));
    }
    return s;
  }
  for (let i = 0; i + 1 < clean.length; i += 2) {
    s += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  }
  return s;
}

function scanPlainUrlsFromText(rawContent, addUrl) {
  const re = /https?:\/\/[a-zA-Z0-9.\-~:/?#\[\]@!$&'()*+,;=%_]+/gi;
  let match;
  while ((match = re.exec(rawContent)) !== null) {
    addUrl(match[0]);
  }
}

function inflateFlateStreamsAndScan(rawContent, addUrl) {
  const re = /\/Filter\s*(?:\[\s*)?\/FlateDecode[\s\S]{0,500}?stream\r?\n/g;
  let match;
  let count = 0;
  while ((match = re.exec(rawContent)) !== null && count < 60) {
    const start = match.index + match[0].length;
    const end = rawContent.indexOf('endstream', start);
    if (end < 0) continue;
    let data = rawContent.slice(start, end);
    if (data.charAt(data.length - 1) === '\n') data = data.slice(0, -1);
    if (data.charAt(data.length - 1) === '\r') data = data.slice(0, -1);
    try {
      const inflated = inflateZlibLatin1(data);
      if (inflated) {
        scanPdfUriLiterals(inflated, addUrl);
        scanPdfUriHex(inflated, addUrl);
        scanPlainUrlsFromText(inflated, addUrl);
      }
    } catch (e) {
      // 單一 stream 失敗不影響其他抽取
    }
    count += 1;
  }
}

function inflateZlibLatin1(latin1) {
  const bytes = [];
  for (let i = 0; i < latin1.length; i++) {
    bytes.push(latin1.charCodeAt(i) & 0xFF);
  }
  if (bytes.length < 6) return '';
  const hasZlibHeader = bytes[0] === 0x78 && (bytes[1] === 0x01 || bytes[1] === 0x9C || bytes[1] === 0xDA);
  const deflateBody = hasZlibHeader ? bytes.slice(2, bytes.length - 4) : bytes.slice(0, bytes.length);
  const gzipBytes = [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]
    .concat(deflateBody)
    .concat([0, 0, 0, 0, 0, 0, 0, 0]);
  try {
    const blob = Utilities.newBlob(gzipBytes, 'application/x-gzip', 'x.gz');
    const out = Utilities.ungzip(blob);
    return out.getDataAsString('ISO-8859-1');
  } catch (e) {
    return '';
  }
}

function decodePercentEncoding(str) {
  if (!str) return '';
  try {
    return decodeURIComponent(str.replace(/\+/g, '%20'));
  } catch (e) {
    try {
      return decodeURIComponent(str.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    } catch (e2) {
      return str;
    }
  }
}

function normalizeExtractedUrl(raw) {
  if (!raw) return '';
  let u = String(raw);
  u = unescapePdfLiteral(u);
  u = decodePercentEncoding(u);
  u = u.replace(/[\s\r\n\0]+/g, '');
  u = u.replace(/[.,;:!?）)\]>]+$/g, '');
  u = u.replace(/\\+$/g, '');
  if (u.indexOf('http://') !== 0 && u.indexOf('https://') !== 0) {
    const found = u.match(/https?:\/\/.+/i);
    u = found ? found[0] : '';
  }
  if (!u) return '';
  if (u.indexOf('...') !== -1 || u.indexOf('…') !== -1) return '';
  if (PLACEHOLDER_HREF_RE.test(u)) return '';
  return u;
}

function isUsefulBulletinUrl(u) {
  if (!u || u.length < 12 || u.length > 500) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  if (JUNK_URL_RE.test(u)) return false;
  if (PLACEHOLDER_HREF_RE.test(u)) return false;
  return true;
}

function resolveUrlsMetadata(urls) {
  if (!urls || urls.length === 0) return [];
  const dict = KNOWN_ACTIVITY_BUTTONS.map(function (item) {
    return {
      match: item.match,
      label: item.label,
      desc: '週報出現「' + item.keys[0] + '」時必須放入此按鈕。',
      isOffering: item.isOffering
    };
  }).concat(KNOWN_URL_META);

  const results = [];
  for (const u of urls) {
    let matched = null;
    for (const item of dict) {
      if (u.indexOf(item.match) !== -1) {
        matched = {
          url: u,
          label: item.label,
          desc: item.desc,
          isOffering: item.isOffering
        };
        break;
      }
    }
    if (matched) {
      results.push(matched);
      continue;
    }
    Logger.log('  🔍 發現全新網址，自動探測標題：' + u);
    const autoTitle = fetchPageTitle(u);
    Logger.log('     ✓ 探測到網頁標題：' + (autoTitle || '未知標題'));
    const isOff = (autoTitle && autoTitle.indexOf('奉獻') !== -1) ||
      u.indexOf('donation') !== -1 ||
      u.indexOf('giving') !== -1;
    results.push({
      url: u,
      label: autoTitle || '活動連結',
      desc: '自動探測網頁標題為「' + autoTitle + '」，請根據此標題放入週報中對應的相關段落。',
      isOffering: isOff
    });
  }
  return results;
}

function fetchPageTitle(url) {
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (res.getResponseCode() === 200) {
      const html = res.getContentText();
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (m && m[1]) {
        return m[1].trim().replace(/\s*[-|_|–]\s*.*$/, '').trim();
      }
    }
  } catch (e) {
    Logger.log('     ⚠️ 探測標題失敗：' + e.message);
  }
  return '';
}

// ============================================================
// ✏ HTML 後處理：真實網址 + 錯字 + 人名（不依賴模型有沒有聽話）
// ============================================================
function finalizeBulletinHtml(html, resolvedUrls) {
  let out = html || '';
  out = applyTypoFixes(out);
  out = applyProperNounFixes(out);
  out = remapPlaceholderAnchors(out, resolvedUrls);
  out = fixBrokenAnchors(out, resolvedUrls);
  out = injectKeywordButtons(out);
  out = injectKnownMetaButtons(out);
  out = stripOfferingLinks(out, resolvedUrls);
  out = repairTruncatedHtml(out);
  return out;
}

function applyTypoFixes(html) {
  const parts = String(html || '').split(/(href\s*=\s*["'][^"']*["'])/gi);
  for (let p = 0; p < parts.length; p++) {
    if (/^href\s*=/i.test(parts[p])) continue;
    let out = parts[p];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < TYPO_FIXES.length; i++) {
        const from = TYPO_FIXES[i][0];
        const to = TYPO_FIXES[i][1];
        if (from !== to) out = out.split(from).join(to);
      }
    }
    parts[p] = out;
  }
  return parts.join('');
}

function applyProperNounFixes(html) {
  let out = html;
  PROPER_NOUN_FIXES.forEach(function (pair) {
    out = out.split(pair[0]).join(pair[1]);
  });
  out = out.replace(/[劉刘](?!娗坊)[\u4e00-\u9fff]坊/g, function (m) {
    if (PROPER_NOUN_EXCEPTIONS.indexOf(m) !== -1) return m;
    Logger.log('       ✓ 人名正規化：' + m + ' → 劉娗坊');
    return '劉娗坊';
  });
  return out;
}

function collectCanonicalUrls(resolvedUrls) {
  const list = [];
  const seen = {};
  function push(u) {
    if (!u || seen[u] || u.indexOf('...') !== -1) return;
    if (PLACEHOLDER_HREF_RE.test(u)) return;
    seen[u] = true;
    list.push(u);
  }
  KNOWN_ACTIVITY_BUTTONS.forEach(function (item) {
    if (!item.isOffering) push(item.href);
  });
  KNOWN_URL_META.forEach(function (item) {
    if (!item.isOffering && item.href) push(item.href);
  });
  (resolvedUrls || []).forEach(function (item) {
    if (!item.isOffering) push(item.url);
  });
  return list;
}

function findBestUrlMatch(href, canonical) {
  if (!href) return '';
  const clean = href.replace(/\.\.\./g, '').replace(/[…]+/g, '').replace(/[.,;]+$/g, '');
  if (canonical.indexOf(href) !== -1) return href;
  if (canonical.indexOf(clean) !== -1) return clean;
  let best = '';
  for (let i = 0; i < canonical.length; i++) {
    const u = canonical[i];
    if (u.indexOf(clean) === 0 && clean.length >= 24) return u;
    if (clean.indexOf(u) === 0) return u;
    const stem = u.replace(/https?:\/\//, '').slice(0, 40);
    if (stem && href.indexOf(stem) !== -1) {
      if (u.length > best.length) best = u;
    }
  }
  return best;
}

function mapLabelToUrl(label, resolvedUrls) {
  const text = String(label || '').replace(/\s+/g, '');
  for (let i = 0; i < KNOWN_ACTIVITY_BUTTONS.length; i++) {
    const item = KNOWN_ACTIVITY_BUTTONS[i];
    if (item.isOffering) continue;
    if (text.indexOf(item.label.replace(/\s+/g, '')) !== -1) return item.href;
    if (item.keys.some(function (k) { return text.indexOf(k) !== -1; })) return item.href;
  }
  for (let j = 0; j < KNOWN_URL_META.length; j++) {
    const meta = KNOWN_URL_META[j];
    if (meta.isOffering || !meta.href) continue;
    if (text.indexOf(meta.label.replace(/\s+/g, '')) !== -1) return meta.href;
    if ((meta.keys || []).some(function (k) { return text.indexOf(k) !== -1; })) return meta.href;
  }
  const resolved = resolvedUrls || [];
  for (let k = 0; k < resolved.length; k++) {
    const item = resolved[k];
    if (item.isOffering) continue;
    if (item.label && text.indexOf(String(item.label).replace(/\s+/g, '')) !== -1) return item.url;
  }
  return '';
}

function remapPlaceholderAnchors(html, resolvedUrls) {
  return String(html || '').replace(/<a\b([^>]*?)href\s*=\s*(["'])([^"']*)\2([^>]*)>([\s\S]*?)<\/a>/gi, function (full, pre, q, href, post, inner) {
    const raw = String(href || '').trim();
    if (!PLACEHOLDER_HREF_RE.test(raw) && raw.indexOf('...') === -1 && raw.indexOf('…') === -1) {
      return full;
    }
    const label = inner.replace(/<[^>]+>/g, '');
    const mapped = mapLabelToUrl(label, resolvedUrls);
    if (mapped) {
      Logger.log('       ✓ 假網址已對上：' + label.replace(/\s+/g, ' ').slice(0, 40) + ' → ' + mapped);
      return '<a' + pre + 'href=' + q + mapped + q + post + '>' + inner + '</a>';
    }
    Logger.log('       ⚠ 移除無法對上的假連結：' + label.replace(/\s+/g, ' ').slice(0, 40));
    return '';
  });
}

function fixBrokenAnchors(html, resolvedUrls) {
  const canonical = collectCanonicalUrls(resolvedUrls);
  return html.replace(/href\s*=\s*(["'])([\s\S]*?)\1/gi, function (full, quote, href) {
    const raw = String(href || '').trim();
    if (!raw) return full;
    if (PLACEHOLDER_HREF_RE.test(raw) || raw.indexOf('...') !== -1 || raw.indexOf('…') !== -1 || /https?:\/\/\S+\.\.\./.test(raw)) {
      const matched = findBestUrlMatch(raw, canonical);
      if (matched) return 'href=' + quote + matched + quote;
    }
    if (/^https?:\/\//i.test(raw)) {
      const matched = findBestUrlMatch(raw, canonical);
      if (matched && matched !== raw && (raw.length < matched.length || raw.indexOf('...') !== -1)) {
        return 'href=' + quote + matched + quote;
      }
    }
    return full;
  });
}

function injectKeywordButtons(html) {
  let out = html;
  KNOWN_ACTIVITY_BUTTONS.forEach(function (item) {
    if (item.isOffering) return;
    const hasKeyword = item.keys.some(function (k) { return out.indexOf(k) !== -1; });
    if (!hasKeyword) return;
    if (out.indexOf(item.href) !== -1) return;
    const button = '<p><a href="' + item.href + '" target="_blank" rel="noopener noreferrer" class="qr-link">' + item.label + '</a></p>';
    let inserted = false;
    for (let i = 0; i < item.keys.length; i++) {
      const key = item.keys[i];
      const idx = out.indexOf(key);
      if (idx === -1) continue;
      const rest = out.slice(idx);
      const close = rest.match(/<\/(p|li|h[1-6]|div|td|blockquote|summary)>/i);
      if (close) {
        const at = idx + close.index + close[0].length;
        out = out.slice(0, at) + '\n' + button + out.slice(at);
        inserted = true;
        break;
      }
    }
    if (!inserted) out += '\n' + button;
    Logger.log('       ✓ 已補上按鈕：' + item.label);
  });
  return out;
}

function injectKnownMetaButtons(html) {
  let out = html;
  KNOWN_URL_META.forEach(function (item) {
    if (item.isOffering || !item.href) return;
    const keys = item.keys || [];
    if (!keys.length) return;
    const hasKeyword = keys.some(function (k) { return out.indexOf(k) !== -1; });
    if (!hasKeyword) return;
    if (out.indexOf(item.href) !== -1) return;
    const button = '<p><a href="' + item.href + '" target="_blank" rel="noopener noreferrer" class="qr-link">' + item.label + '</a></p>';
    let inserted = false;
    for (let i = 0; i < keys.length; i++) {
      const idx = out.indexOf(keys[i]);
      if (idx === -1) continue;
      const rest = out.slice(idx);
      const close = rest.match(/<\/(p|li|h[1-6]|div|td|blockquote|summary)>/i);
      if (close) {
        const at = idx + close.index + close[0].length;
        out = out.slice(0, at) + '\n' + button + out.slice(at);
        inserted = true;
        break;
      }
    }
    if (!inserted) out += '\n' + button;
    Logger.log('       ✓ 已補上按鈕：' + item.label);
  });
  return out;
}

function stripOfferingLinks(html, resolvedUrls) {
  let out = html;
  (resolvedUrls || []).forEach(function (item) {
    if (!item.isOffering) return;
    const escaped = item.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('<a\\b[^>]*href=["\']' + escaped + '["\'][^>]*>[\\s\\S]*?<\\/a>', 'gi'), '');
  });
  out = out.replace(/<a\b[^>]*href=["'][^"']*(Egm6bA|donation|giving)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '');
  return out;
}

function repairTruncatedHtml(html) {
  let out = html;
  if (!/<\/body>/i.test(out)) out += '\n</body>';
  if (!/<\/html>/i.test(out)) out += '\n</html>';
  return out;
}
