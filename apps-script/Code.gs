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
 *  4) repairCurrentIssues()             // 一鍵修復目前網站週報（頁尾三大按鈕、消除重複、校正錯字人名，不花 Gemini）
 *  5) repairPublishedWithoutGemini()    // 批次補修舊週報連結／錯字
 *  6) checkAndProcessNewBulletins()     // 只處理還沒做過的新 PDF
 *  7) installScheduleTriggers()         // 只跑一次：裝台北時間 8/10/12/14/16/18/20 點排程
 *  8) startTestingPeriod()              // 測試期：網站只留 2026-09-27，並重辨識 2026-09-20
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

/** 舊週報補修（不呼叫 Gemini）每次最多幾份。GitHub Gist 配額很寬，設為 10 可一次修復所有已上架期數。 */
const REPAIR_BATCH_LIMIT = 10;

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
  },
  {
    keys: ['閱讀・以賽亞', '閱讀以賽亞', '以賽亞書與上帝的救贖歷史', '閱讀.以賽亞'],
    match: 'FAIpQLScTKbPgDybvtiup6yGJ5MwwS7I5Yhl5ERrsrSlNjWpbx3sWjw',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLScTKbPgDybvtiup6yGJ5MwwS7I5Yhl5ERrsrSlNjWpbx3sWjw/viewform',
    label: '2026德光教會「閱讀・以賽亞」講座報名',
    isOffering: false
  },
  {
    keys: ['2027全年讀經', '2027年全年讀經', '遵守生命令'],
    match: 'FAIpQLSeeA9OsHsJea5eDm4bW-uxTkD80bYfXc1u-SNjz9GyKwDu9JA',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLSeeA9OsHsJea5eDm4bW-uxTkD80bYfXc1u-SNjz9GyKwDu9JA/viewform?usp=header',
    label: '2027年全年讀經「遵守生命令」靈修書籍代訂購',
    isOffering: false
  },
  {
    keys: ['社青＆兒主野外禮拜', '社青&兒主野外禮拜', '粉牛樂園', '社青 ＆ 兒主野外禮拜'],
    match: 'cQdSLqTaKDy32J5b7',
    href: 'https://forms.gle/cQdSLqTaKDy32J5b7',
    label: '社青＆兒主野外禮拜報名表',
    isOffering: false
  },
  {
    keys: ['心靈成長工作坊', '走出心理遊戲迷霧'],
    match: 'FAIpQLSedD1BhCrBeok3wkca2OlYP0lxGHxVoohlZUVzpT43fXvu2xA',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLSedD1BhCrBeok3wkca2OlYP0lxGHxVoohlZUVzpT43fXvu2xA/viewform',
    label: '培育部「心靈成長工作坊」線上課程報名表',
    isOffering: false
  }
];

const CHURCH_FB_URL = 'https://www.facebook.com/profile.php?id=100068541559964&mibextid=LQQJ4d';
const BRANCH_FB_URL = 'https://www.facebook.com/tntklove062672323?mibextid=LQQJ4d';
const PARKING_URL   = 'https://reurl.cc/O56r6A';

const KNOWN_URL_META = [
  {
    match: 'O56r6A',
    keys: ['停車', '汽機車', '停車場'],
    href: PARKING_URL,
    label: '教會停車配置圖',
    desc: '教會汽機車停車公告與配置圖，由頁尾統一放置。',
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
    href: CHURCH_FB_URL,
    label: '德光長老教會粉絲頁',
    desc: '德光長老教會官方 Facebook 粉絲頁（QR Code 標籤：教會粉絲頁）！',
    isOffering: false
  },
  {
    match: 'tntklove',
    keys: ['教會據點粉絲頁', '據點粉絲頁', '社區據點粉絲頁', '據點FB', '據點粉專', '社區照顧關懷據點'],
    href: BRANCH_FB_URL,
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
  ['刘娗坊', '劉娗坊'],
  // ★ 牧者同工白名單（堯 vs 彝/統/僥 等視覺形近字）
  ['郭正彝', '郭正堯'],
  ['郭正統', '郭正堯'],
  ['郭正僥', '郭正堯'],
  ['郭正澆', '郭正堯'],
  // ★ 長老同工白名單（俊 vs 獲/護/進 等視覺形近字）
  ['陳雅獲', '陳雅俊'],
  ['陳雅護', '陳雅俊'],
  ['陳雅進', '陳雅俊']
];
const PROPER_NOUN_EXCEPTIONS = [];

/**
 * 德光長老教會 437 位正式會友與同工姓名錄（專有名詞白名單庫）
 */
const CHURCH_ROSTER = [
  "丁美鈴", "方美華", "方耀戎", "方櫻芳", "毛文秀", "王中吟", "王加安", "王光聖", "王全達", "王宗豪", "王宗寶", "王信喆", "王美月", "王美瑜", "王英哲",
  "王家健", "王浩萱", "王培翰", "王莉雅", "王凱賢", "王進裕", "王愛惠", "王靖婷", "王維安", "王麗雲", "王馨恩", "王馨愛", "石麗琴", "朱以恩", "朱志翰",
  "江安通", "江琳恩", "江語婕", "何麗萍", "吳沐昀", "吳孟芯", "吳宗翰", "吳昌坪", "吳牧凡", "吳玫瑛", "吳南烈", "吳美玲", "吳峻宇", "吳淑美", "吳淑鶯",
  "吳閔玄", "吳碧珊", "吳碧櫻", "呂孔文", "宋志華", "希•瑪巴諾", "李予新", "李文君", "李至軒", "李其恩", "李其軒", "李幸娟", "李旼瑄", "李昊恩", "李明親",
  "李芳綺", "李品佑", "李品謙", "李宥齊", "李建興", "李政逸", "李春金", "李貞樺", "李韋德", "李恩德", "李珮璽", "李凱屏", "李凱雯", "李華強", "李雅芬",
  "李雅玲", "李瑞香", "李慶成", "沈佳蓉", "邢宇生", "周李幸", "周秀貴", "周秉宏", "周倉榮", "周景惟", "周陽明", "周詹榮", "周耀南", "林子佑", "林子為",
  "林志威", "林佳萍", "林宜蓉", "林怡如", "林旻億", "林明燕", "林牧昕", "林信亮", "林南宏", "林盼", "林美雀", "林貞杏", "林原禾", "林素篦", "林淑碧",
  "林淑蕙", "林理心", "林理業", "林麥", "林萌", "林楊麗梅", "林聖貴", "林嘉昇", "林嫺娜", "林慧瑄", "林澄萱", "林邁", "林駿", "林麗吟", "邱百合",
  "邱秀菊", "邱奕傑", "邱瑞淵", "邱瑩純", "侯雅鈴", "施悅吟", "施悅欣", "施悅音", "施敏惠", "施惠安", "洪昕恬", "洪昕睿", "洪素蘋", "洪國雄", "洪淑敏",
  "洪瑛鍈", "胡志青", "胡哲維", "胡素貞", "胡國展", "胡博翔", "胡絮婷", "胡舒晴", "范財福", "夏曼•瑪巴諾", "孫巧鳳", "徐心柔", "徐心潔", "徐玉珠", "徐皓九",
  "徐慧玲", "翁錦雲", "馬淑慧", "高羽柔", "高毓謙", "高綺璘", "康碧珊", "張至君", "張秀卿", "張珈瑄", "張家銘", "張恩佳", "張恩祈", "張惠芳", "張筱宓",
  "張瑢瑢", "張慧津", "張樂樂", "張曜丞", "曹麗滿", "梁遠忱", "梁遠甯", "莊約達", "莊羍", "莊淑玲", "莊淑惠", "莊維仲", "許心怡", "許心樂", "許文如",
  "許禾樂", "許綺玲", "許慧玲", "郭月貞", "郭正堯", "郭羽辰", "郭育霖", "郭芳蓉", "郭芸希", "郭津如", "郭徛愛", "郭惠民", "郭慧嫻", "郭蔡阿峯", "郭豔源",
  "陳子育", "陳丰鐘", "陳以理", "陳巧翊", "陳永琪", "陳至恩", "陳艾琦", "陳艾嫈", "陳志旭", "陳育萍", "陳邦旭", "陳幸慧", "陳怡安", "陳怡蓁", "陳芯誼",
  "陳芳基", "陳俊達", "陳品伃", "陳品均", "陳姿君", "陳建明", "陳春龍", "陳昱均", "陳昱森", "陳昱菁", "陳昱維", "陳約伯", "陳美莉", "陳英崇", "陳貞樺",
  "陳述沛玲", "陳悦心", "陳振傑", "陳珮玲", "陳敏祥", "陳翊瑄", "陳尊龍", "陳惠珍", "陳惠華", "陳湘甯", "陳貴華", "陳雅俊", "陳雅貞", "陳雅郁", "陳塏杰",
  "陳暐博", "陳靜美", "陳麗兒", "陳耀生", "陳耀武", "曾振升", "曾偉祺", "曾啟峰", "曾張娜美", "曾慧婉", "程淑蓮", "買佳戀", "黃千晏", "黃千睿", "黃子祐",
  "黃予信", "黃友嵩", "黃友義", "黃安多", "黃安彤", "黃宏宇", "黃依婷", "黃俊蓉", "黃俊穎", "黃奐鄅", "黃彥雄", "黃律詠", "黃昭彰", "黃昭監", "黃偉峰",
  "黃偉翔", "黃婇琳", "黃淑卿", "黃淑敏", "黃清香", "黃祤辰", "黃登淵", "黃雅君", "黃雅慧", "黃楊玉環", "黃溫雅", "黃煦恩", "黃瑞柱", "黃鈺婷", "黃靖紜",
  "黃榮華", "黃碧蓮", "黃慧英", "黃慶輝", "黃耀辰", "黃顯榮", "楊秀雯", "楊怡和", "楊怡明", "楊欣蓉", "楊秉橙", "楊俊男", "楊政瑋", "楊致蒼", "楊涵晴",
  "楊蓂蓂", "楊靈耀", "葉宏明", "葉宣甫", "葉美珠", "葉益宏", "詹幸蓉", "詹東明", "詹惠琳", "詹慧雯", "鄒巧君", "廖秋霞", "趙芸亭", "趙悅欣", "趙麗雲",
  "劉永昕", "劉守仁", "劉佩貞", "劉怡慧", "劉娗坊", "劉峻瑋", "劉恩慈", "劉清惠", "劉榮輝", "劉穎熙", "劉麗珠", "歐佩綺", "潘瑋哲", "蔡予理", "蔡予晴",
  "蔡心恬", "蔡心嵐", "蔡存謙", "蔡宏恩", "蔡秀治", "蔡貝加", "蔡貝安", "蔡亞凡", "蔡佩樺", "蔡佳倚", "蔡佳倫", "蔡宛真", "蔡宜宏", "蔡政勳", "蔡政翰",
  "蔡榮成", "蔡維忠", "蔡瑩螢", "蔡燕昭", "蔡耀禎", "鄧以得", "鄧佳明", "鄧苡信", "鄭夙雯", "鄭佩芬", "鄭秉恩", "鄭郇", "鄭泰昇", "鄭翊宏", "鄭博文",
  "鄭富琪", "鄭詠和", "盧紀邦", "盧淑芳", "盧淑琍", "盧祺典", "盧祺音", "盧懿君", "蕭佩怡", "蕭幸枝", "蕭惠蘭", "賴辰歆", "賴建成", "賴柏元", "賴柏宏",
  "賴淑媛", "賴葉千惠", "錢佩君", "戴子沐", "戴劭恩", "戴沛欣", "戴家丰", "戴素惠", "戴嵐嵐", "戴惠娜", "戴朝雄", "戴菁菁", "戴瑛瑛", "戴瀚霖", "薛育如",
  "薛婉婷", "謝子文", "謝文卿", "謝以希", "謝以樂", "謝永恩", "謝旭峰", "謝吳碧蓮", "謝姃儀", "謝岳民", "謝昀真", "謝明錡", "謝欣蓉", "謝惠珠", "謝羅秀玉",
  "鍾玉倫", "藍素霙", "顏玉伶", "羅秀景", "羅秀靖", "羅佳美", "羅苡僑", "羅啟宗", "嚴沁瑜", "蘇文絹", "蘇朱雀", "蘇亮月", "蘇薈晴", "鐘秀鸞", "陳怡帆",
  "楊紫青", "陳立武", "戴友一", "洪昕碩", "莊翰佳", "洪柏聖", "張寧寧", "梁晉榮", "蔡明松", "蕭以忻", "劉牧澤", "劉予箴", "王昱勻", "陳季鋒", "李欣倫",
  "林映村", "鄭賀妮"
];

/** 長詞優先，避免部分替換造成二次錯字。單字簡轉繁放最後。 */
const TYPO_FIXES = [
  ['頌榮：五二二首', '頌榮：五一三首'],
  ['聖詩：三二五首', '聖詩：三三五首'],
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

const JUNK_URL_RE = /w3\.org|adobe\.com|purl\.org|color\.org|npes\.org|xml\.org|microsoft\.com|apple\.com\/DTDs|schemas\.openxmlformats|ns\.adobe|xmp\.iid|xmp\.did|pdfa\.org|ci\.org|iptc\.org|plus\.google\.com\/u\/0\/_|iec\.ch|icc\.org|eci\.org|iso\.org|pantone\.com|monotype\.com|linotype\.com/i;
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
      if (result.prayerText !== undefined || result.roasterText !== undefined || result.readingText !== undefined || result.sermonText !== undefined) {
        entry.readingText = result.readingText || '';
        entry.sermonText = result.sermonText || '';
        entry.prayerText = result.prayerText || '';
        entry.roasterText = result.roasterText || '';
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

/**
 * 一鍵修復目前網站上所有已發布週報（包含 9/27 與 9/20 的頁尾三大按鈕、消除重複、校正錯字人名）
 * 0 消耗 Gemini 配額，直接修復 Gist 內容並更新網站！
 */
function repairCurrentIssues() {
  Logger.log('=== 一鍵修復目前網站已發布週報 ===');
  resetRepairCursor();
  repairPublishedWithoutGemini();
  Logger.log('🎉 目前已發布週報已全數修復完成！請重新整理網頁查看。');
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
  Logger.log('🎉 請重新整理 https://nckuplantwilly.github.io/alltkchweeknews/ 應只剩 9/27 與剛上架的 9/20。');
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
  const summary   = result.summary || '';
  Logger.log('       ✓ 辨識卷期：第 ' + volume + ' 卷第 ' + issue + ' 期');
  Logger.log('       ✓ 辨識主日：' + finalDate);
  Logger.log('       ✓ 週報摘要：' + (summary ? summary.slice(0, 50) + (summary.length > 50 ? '…' : '') : '（未擷取到摘要）'));

  Logger.log('  [6/6] 上傳至 GitHub Gist（同一日期會覆蓋，不再開新 Gist）...');
  const gistFilename = 'tkch-bulletin-' + finalDate + '.html';
  const gistTitle    = '德光長老教會週報 ' + finalDate;
  const uploaded     = upsertHtmlGist(finalHtml, gistFilename, gistTitle, githubToken, finalDate);
  Logger.log('       ✓ 公開網址：' + uploaded.previewUrl);

  const keyTexts = extractKeyTextFromHtml(finalHtml);

  updateBulletinIndex({
    volume:      volume,
    issue:       issue,
    title:       title,
    summary:     summary,
    url:         uploaded.previewUrl,
    date:        finalDate,
    publishedAt: finalDate + 'T00:00:00.000Z',
    readingText: keyTexts.readingText,
    sermonText:  keyTexts.sermonText,
    prayerText:  keyTexts.prayerText,
    roasterText: keyTexts.roasterText
  }, githubToken);
  Logger.log('       ✓ 歷期目錄索引已更新（含代禱與事奉內文快取）！');
  markFileState(file, finalDate);

  // ★ 發布成功，自動寄送 Email 通知
  sendPublishNotification({
    date: finalDate,
    title: title,
    previewUrl: uploaded.previewUrl,
    fileName: file.getName(),
    html: finalHtml
  });
}

/**
 * 📝 從 HTML 中提取代禱事項與事奉輪值表純文字，存入目錄索引供 AI 高速檢索
 */
function extractKeyTextFromHtml(html) {
  if (!html) return { readingText: '', sermonText: '', prayerText: '', roasterText: '' };
  
  // 1. 全年讀經進度
  let readingText = '';
  const rdMatch = html.match(/全年讀經進度[：:]\s*(?:<\/strong>)?\s*([^<\n]+)/i);
  if (rdMatch) {
    readingText = rdMatch[1].trim();
  }

  // 2. 講道大綱與經文要點
  let sermonText = '';
  const smMatch = html.match(/<(?:h[2-4]|summary|p)[^>]*>.*?(?:主日講道大綱|講道大綱|主日講道筆記).*?<\/(?:h[2-4]|summary|p)>([\s\S]{20,800}?)(?:<details|<h[2-3]|<!--|\n\n|$)/i);
  if (smMatch) {
    sermonText = smMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);
  }

  const clean = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. 代禱事項
  let prayerText = '';
  const prayerIdx = clean.indexOf('教會消息') !== -1 ? clean.indexOf('教會消息') : (clean.indexOf('代禱事項') !== -1 ? clean.indexOf('代禱事項') : clean.indexOf('禱告園地'));
  if (prayerIdx !== -1) {
    prayerText = clean.substring(prayerIdx, prayerIdx + 2800).trim(); // 含教會消息最多 10 點，需 2800 字
  }

  // 4. 事奉輪值表
  let roasterText = '';
  const roasterIdx = clean.indexOf('事奉輪值表');
  if (roasterIdx !== -1) {
    roasterText = clean.substring(roasterIdx, roasterIdx + 800).trim();
  } else {
    const tableIdx = clean.indexOf('值週');
    if (tableIdx !== -1) {
      roasterText = clean.substring(Math.max(0, tableIdx - 100), tableIdx + 700).trim();
    }
  }

  return {
    readingText: readingText,
    sermonText:  sermonText,
    prayerText:  prayerText,
    roasterText: roasterText
  };
}

/**
 * 🔍 分析 HTML 內文中的活動按鈕超連結，以及是否有提及「報名/登記/QR Code」卻缺漏連結的項目
 */
function inspectHtmlLinksAndWarnings(html) {
  const result = {
    validLinks: [],
    suspiciousItems: []
  };
  if (!html) return result;

  // 1. 抓出所有活動按鈕超連結
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let m;
  const seenUrls = {};
  while ((m = anchorRegex.exec(html)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (url && !seenUrls[url] && !/facebook\.com|reurl\.cc\/O56r6A/i.test(url)) {
      seenUrls[url] = true;
      result.validLinks.push({ label: text || '活動連結', url: url });
    }
  }

  // 2. 檢查內文中提及「報名/登記/QR Code/掃描」，但該區塊沒有 <a> 標籤的條目
  const itemRegex = /<(li|p)>([\s\S]*?)<\/\1>/gi;
  while ((m = itemRegex.exec(html)) !== null) {
    const content = m[2];
    const textOnly = content.replace(/<[^>]+>/g, '').trim();
    const hasCallToAction = /(報名|登記|QR\s*Code|掃描)/i.test(textOnly);
    const hasLink = /<a\s+[^>]*href=/i.test(content);
    if (hasCallToAction && !hasLink) {
      // 排除單純說明或非活動報名的例行文字
      if (/歡迎索取|一樓副堂最後一扇門|代禱箱|奉獻/.test(textOnly)) continue;
      const summary = textOnly.slice(0, 45).replace(/\s+/g, ' ');
      if (summary && result.suspiciousItems.indexOf(summary) === -1) {
        result.suspiciousItems.push(summary + (textOnly.length > 45 ? '…' : ''));
      }
    }
  }

  return result;
}

/**
 * 📧 寄送週報上架通知信至指定的管理員信箱（含超連結清單與缺漏提醒）
 */
function sendPublishNotification(data) {
  if (!NOTIFICATION_EMAILS || NOTIFICATION_EMAILS.length === 0) return;
  const recipient = NOTIFICATION_EMAILS.join(',');
  const subject = '【德光週報發布通知】' + data.date + ' (' + data.title + ')';

  const check = inspectHtmlLinksAndWarnings(data.html || '');
  let linkSummaryText = '';
  let linkSummaryHtml = '';

  if (check.validLinks.length > 0) {
    linkSummaryText += '\n• 本期已植入活動連結 (' + check.validLinks.length + ' 個)：\n' +
      check.validLinks.map(function (l) { return '  - ' + l.label + '：' + l.url; }).join('\n') + '\n';
    linkSummaryHtml +=
      '<div style="background-color: #F0FDF4; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #16A34A;">' +
        '<p style="margin: 0 0 6px; font-weight: bold; color: #166534; font-size: 14px;">🔗 本期已自動植入活動連結 (' + check.validLinks.length + ' 個)：</p>' +
        '<ul style="margin: 0; padding-left: 20px; color: #15803D; font-size: 13px; line-height: 1.6;">' +
          check.validLinks.map(function (l) {
            return '<li><a href="' + l.url + '" target="_blank" style="color: #15803D; font-weight: 500; text-decoration: underline;">' + l.label + '</a></li>';
          }).join('') +
        '</ul>' +
      '</div>';
  }

  if (check.suspiciousItems.length > 0) {
    linkSummaryText += '\n⚠️【待確認缺漏提醒】下列內容提及報名/登記/QR Code，但未發現超連結：\n' +
      check.suspiciousItems.map(function (item) { return '  - ' + item; }).join('\n') + '\n';
    linkSummaryHtml +=
      '<div style="background-color: #FFFBEB; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #D97706;">' +
        '<p style="margin: 0 0 6px; font-weight: bold; color: #92400E; font-size: 14px;">⚠️【重複確認提醒】下列內容提及「報名/登記/QR Code」，但未發現超連結：</p>' +
        '<ul style="margin: 0; padding-left: 20px; color: #B45309; font-size: 13px; line-height: 1.5;">' +
          check.suspiciousItems.map(function (item) { return '<li>' + item + '</li>'; }).join('') +
        '</ul>' +
        '<p style="margin: 8px 0 0; font-size: 12px; color: #78350F;">💡 說明：若上述活動需提供線上報名，可在 Code.gs 的 KNOWN_ACTIVITY_BUTTONS 加入關鍵字與網址，或請幹事在 Word 貼上 QR Code 時為圖片加上超連結。</p>' +
      '</div>';
  }

  const bodyText =
    '平安！\n\n' +
    '德光長老教會主日週報已自動完成 AI 排版與發布：\n\n' +
    '• 主日日期：' + data.date + '\n' +
    '• 週報卷期：' + data.title + '\n' +
    '• 原始檔案：' + data.fileName + '\n' +
    '• 線上閱讀：' + data.previewUrl + '\n' +
    '• 歷期目錄：https://nckuplantwilly.github.io/alltkchweeknews/\n' +
    linkSummaryText + '\n' +
    '系統已自動排除奉獻資料、校對專有名詞與教界消息，並注入活動超連結。\n' +
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
      linkSummaryHtml +
      '<div style="text-align: center; margin: 28px 0;">' +
        '<a href="' + data.previewUrl + '" target="_blank" style="display: inline-block; background-color: #5850EC; color: #FFFFFF; font-weight: bold; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; box-shadow: 0 4px 6px -1px rgba(88, 80, 236, 0.2);">' +
          '📖 立即閱讀本週週報 →' +
        '</a>' +
      '</div>' +
      '<div style="border-top: 1px solid #E2E8F0; padding-top: 16px; margin-top: 20px; font-size: 13px; color: #64748B; line-height: 1.6;">' +
        '<p style="margin: 4px 0;">🌐 歷期週報首頁：<a href="https://nckuplantwilly.github.io/alltkchweeknews/" target="_blank" style="color: #5850EC;">nckuplantwilly.github.io/alltkchweeknews</a></p>' +
        '<p style="margin: 4px 0;">✨ 系統已自動排除奉獻明細，並已植入活動報名超連結。</p>' +
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
    date: '2026-10-18',
    title: '第 33 卷第 42 期（測試通知）',
    fileName: '20261018教會周報鏈接檔.pdf',
    previewUrl: 'https://nckuplantwilly.github.io/alltkchweeknews/',
    html: '<p>「閱讀・以賽亞」講座請掃描 QR Code 報名</p><p><a href="https://reurl.cc/r30vKE" class="qr-link">中保代禱專頁</a></p>'
  });
  Logger.log('🎉 測試郵件發送完成！請檢查您的收件匣（及垃圾郵件匣）。');
}

/**
 * 🛠 一鍵修復第 42 期（2026-10-18）週報連結（0 消耗 Gemini 額度）
 */
function repairIssue42() {
  Logger.log('=== 專門補修第 42 期（2026-10-18）連結 ===');
  repairOneDate('2026-10-18');
  Logger.log('🎉 第 42 期補修完畢！請重新整理歷期週報網站確認。');
}

/**
 * 🛠️ 專門一鍵修復第 44 期（2026-11-01）
 * 1. 移除誤植的 ICC 規範連結 (http://www.iec.ch)
 * 2. 修正禮拜程序中的聖詩曲目（三二五首 -> 三三五首）
 * 3. 修正禮拜程序中的頌榮曲目（五二二首 -> 五一三首）
 * 0 消耗 Gemini 配額！
 */
function repairIssue44() {
  Logger.log('=== 專門補修第 44 期（2026-11-01）===');
  repairOneDate('2026-11-01');
  Logger.log('🎉 第 44 期補修完畢！請重新整理週報網頁確認。');
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
  const keyTexts = extractKeyTextFromHtml(finalHtml);
  rememberGistId(entry.date, gistId);
  return {
    changed: changed,
    previewUrl: toStablePreviewUrl(gistId, filename),
    readingText: keyTexts.readingText,
    sermonText: keyTexts.sermonText,
    prayerText: keyTexts.prayerText,
    roasterText: keyTexts.roasterText
  };
}

/**
 * ⚡ 一鍵為目前目錄已上架的所有週報回填【代禱事項】與【事奉輪值】內文快取至 JSON Index
 * 完全不呼叫 Gemini API，速度快且不耗配額！
 */
function backfillKeyText() {
  const props = PropertiesService.getScriptProperties();
  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken) {
    Logger.log('❌ 尚未設定 GITHUB_TOKEN');
    return;
  }
  const indexState = loadIndexGist(githubToken);
  if (!indexState || !indexState.list || indexState.list.length === 0) {
    Logger.log('❌ 找不到目錄 Gist 或目錄為空');
    return;
  }
  Logger.log('=== 開始為歷期週報回填代禱與事奉內文快取（共 ' + indexState.list.length + ' 期）===');
  let updatedCount = 0;
  for (const entry of indexState.list) {
    if (!entry || !entry.date) continue;
    const gistId = parseGistIdFromPreviewUrl(entry.url) || getGistIdByDate(entry.date);
    if (!gistId) {
      Logger.log('⚠ ' + entry.date + ' 無法取得 Gist ID，跳過');
      continue;
    }
    Logger.log('▶ 讀取 ' + entry.date + ' HTML...');
    try {
      const html = fetchGistHtml(gistId, githubToken);
      if (html) {
        const keyTexts = extractKeyTextFromHtml(html);
        entry.readingText = keyTexts.readingText || '';
        entry.sermonText = keyTexts.sermonText || '';
        entry.prayerText = keyTexts.prayerText || '';
        entry.roasterText = keyTexts.roasterText || '';
        updatedCount++;
        Logger.log('   ✓ 讀經：' + (entry.readingText ? entry.readingText.substring(0, 25) : '無') + '，代禱 ' + entry.prayerText.length + ' 字，事奉 ' + entry.roasterText.length + ' 字');
      }
    } catch (e) {
      Logger.log('   ❌ 讀取失敗：' + e.message);
    }
    Utilities.sleep(500);
  }
  saveIndexList(indexState, githubToken);
  Logger.log('🎉 歷期目錄索引更新完畢！共更新 ' + updatedCount + ' 期週報。');
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
META:{"volume":33,"issue":24,"date":"2026-09-27","title":"第 33 卷第 24 期","summary":"本週主日講道主題為「...」（經文：...），由...牧師/長老主講。教會消息包含：...等。"}
（請從週報首頁印製的文字自動擷取：卷數 volume、期數 issue、主日西元日期 date）
summary 欄位規範：
- 限 100 字以內的繁體中文純文字（無 HTML 標記）
- 必須包含：① 主日講道題目與經文 ② 主講者姓名 ③ 1～2 條重要教會消息
- 排除所有奉獻相關內容
- 此摘要供長者語音朗讀與搜尋使用，措辭須口語化、清晰易懂
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
4. 【專有名詞與會友/同工姓名白名單——OCR 容易看錯，必須嚴格照抄對照】
   - 團隊牧師：「郭正堯」（嚴禁寫成 郭正彝、郭正統、郭正僥）。
   - 長老同工：「陳雅俊」（嚴禁寫成 陳雅獲、陳雅護）。
   - 事奉表人名：「劉娗坊」（中間是女字旁＋廷，Unicode U+5A17）。
     嚴禁寫成 劉嫆坊、劉媞坊、劉婷坊、劉挺坊、劉廷坊、劉庭坊。
     週報裡凡是「劉○坊」都是同一人，輸出必須是「劉娗坊」。
   - 主任牧師：「羅啓宗」/「羅啟宗」、團隊牧師：「郭正堯」、「楊秀雯」。
   - 【全教會正式會友與同工名冊白名單】：凡事奉表、主日服事、代禱信、消息報告中出現之同工姓名，必須嚴格以此名冊為準，嚴禁同音錯字或形近錯字：
     ${CHURCH_ROSTER.join('、')}
   - 【主日禮拜程序表（直書漢字數字）防呆校對】：
     台語禮拜程序的「聖詩」與「頌榮」通常為直書漢字數字（如：一七八、三三五、五一三）。
     【嚴重警告】：漢字數字下方緊連著長串引導虛線（……/……），OCR 視覺極容易受虛線筆畫干擾，誤把「三」看成「二」（例如把「三三五」誤看成「三二五」），或把「一三」看成「二二」（例如把「五一三」誤看成「五二二」）。
     請仔細辨識字形實體筆畫。長老教會禮拜結尾的「頌榮」通常固定為 510～515 首（五一一、五一二、五一三、五一四、五一五），嚴禁輸出五二二首等非頌榮曲目！請交叉核對週報其他頁面的聚會預告（橫書阿拉伯數字）。
5. 頂部 Header：優雅顯示「德光長老教會」、「主日禮拜週報」及主日日期。
6. 風格配色：白底、深灰文字 #334155、高雅金 #C9A84C、莫蘭迪藍 #5850EC。
7. 版面居中，最大寬度 650px，邊距適中，完美適應手機螢幕。
8. 事奉人員分配表需支援手機橫向滑動排版。
9. 超連結按鈕使用 class="qr-link"，並加 target="_blank" rel="noopener noreferrer"。
   禁止 href="#"、禁止 lin.ee/example、禁止 example.com、禁止把網址寫成省略號。
10. 頁尾 Footer 規範：
    - 包含：教會全銜、牧者團隊、地址、電話、關懷站電話、E-mail、主日禮拜時間。
    - 底部使用 <div class="footer-links"> 放置三個橫向並排按鈕：
      1) <a href="https://reurl.cc/O56r6A" target="_blank" rel="noopener noreferrer" class="qr-link">教會停車配置圖</a>
      2) <a href="https://www.facebook.com/profile.php?id=100068541559964&mibextid=LQQJ4d" target="_blank" rel="noopener noreferrer" class="qr-link">德光長老教會粉絲頁</a>
      3) <a href="https://www.facebook.com/tntklove062672323?mibextid=LQQJ4d" target="_blank" rel="noopener noreferrer" class="qr-link">德光教會據點粉絲頁</a>
    - 嚴禁重複輸出相同的粉絲頁按鈕，禁止在 footer 外部或內部輸出多餘的重複連結。`;

  const userPrompt = '請將這份週報 PDF 轉為 HTML。推估主日日期約為 ' + fallbackDateStr + '，請以 PDF 內文印製的實際日期與卷期為主。所有按鈕網址必須使用系統提供的完整網址，禁止省略。同工姓名「郭正堯」、「陳雅俊」、「劉娗坊」必須嚴格照抄校對。輸出前請再校對「教界消息」與繁體用字。';

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

  let volume = 0, issue = 0, date = fallbackDateStr, title = '', summary = '';
  const metaMatch = text.match(/META:\s*(\{[\s\S]*?\})/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      volume  = meta.volume  || 0;
      issue   = meta.issue   || 0;
      date    = meta.date    || fallbackDateStr;
      title   = meta.title   || '';
      summary = meta.summary || '';
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
  return { html: html, volume: volume, issue: issue, date: date, title: title, summary: summary };
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
  const re = /\/Filter\s*(?:\[\s*)?\/FlateDecode[\s\S]{0,500}?stream(?:\r\n|\n|\r)/g;
  let match;
  let count = 0;
  while ((match = re.exec(rawContent)) !== null && count < 300) {
    const start = match.index + match[0].length;
    const end = rawContent.indexOf('endstream', start);
    if (end < 0) continue;
    let data = rawContent.slice(start, end);
    while (data.length > 0 && (data.charAt(data.length - 1) === '\n' || data.charAt(data.length - 1) === '\r')) {
      data = data.slice(0, -1);
    }
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
  if (!latin1 || latin1.length < 2) return '';
  const u8 = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) {
    u8[i] = latin1.charCodeAt(i) & 0xFF;
  }
  let out;
  try {
    if (typeof fflateUnzlibSync === 'function') {
      out = fflateUnzlibSync(u8);
    }
  } catch (e1) {
    try {
      if (typeof fflateInflateSync === 'function') {
        out = fflateInflateSync(u8);
      }
    } catch (e2) {
      return '';
    }
  }
  if (!out) return '';
  let str = '';
  const chunk = 8192;
  for (let i = 0; i < out.length; i += chunk) {
    str += String.fromCharCode.apply(null, out.subarray(i, Math.min(i + chunk, out.length)));
  }
  return str;
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
  if (/iec\.ch|w3\.org|adobe\.com|color\.org|schema\.org/i.test(u)) return false;
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
  out = injectMissingResolvedUrls(out, resolvedUrls);
  out = stripJunkLinks(out);
  out = correctLiturgyHymns(out);
  out = normalizeFooterLinks(out);
  out = stripOfferingLinks(out, resolvedUrls);
  out = injectAccessibilityAndTTS(out);
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

  // 自動依 437 人名冊校正事奉表與同工職稱人名（單一字形差且名冊唯一匹配者自動校正）
  const localPastors = ['郭正堯', '楊秀雯', '羅啓宗', '羅啟宗'];
  out = out.replace(/([\u4e00-\u9fa5]{2,3})(長老|執事|牧師)/g, function (full, name, title) {
    if (CHURCH_ROSTER.indexOf(name) !== -1) return full;
    if (/^(德光|值週|值周|主任|團隊|友會|本會|各位|請假|教界)$/.test(name)) return full;
    const candidates = CHURCH_ROSTER.filter(function (rName) {
      if (rName.length !== name.length) return false;
      let diff = 0;
      for (let i = 0; i < name.length; i++) {
        if (name[i] !== rName[i]) diff++;
      }
      return diff === 1;
    });
    if (candidates.length === 1) {
      // 若為牧師稱謂，僅允許校正為德光長老教會常駐牧師，避免誤改外請或友會牧師
      if (title === '牧師' && localPastors.indexOf(candidates[0]) === -1) {
        return full;
      }
      Logger.log('       ✓ 名冊單一候選校正：' + name + title + ' → ' + candidates[0] + title);
      return candidates[0] + title;
    }
    return full;
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
    // 停車配置圖與兩大粉絲頁由 normalizeFooterLinks 統一管理在頁尾，避免在內文被關鍵字誤觸發造成重複按鈕
    if (item.match === 'O56r6A' || item.match === '100068541559964' || item.match === 'tntklove') {
      return;
    }
    const keys = item.keys || [];
    if (!keys.length) return;
    const hasKeyword = keys.some(function (k) { return out.indexOf(k) !== -1; });
    if (!hasKeyword) return;
    if (out.indexOf(item.match) !== -1 || out.indexOf(item.href) !== -1) return;
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

/**
 * 頁尾按鈕標準化與去重機制：
 * 1. 統一所有 Facebook 粉絲頁連結為官方標準網址
 * 2. 徹底清除頁尾內部或外部遺留的重複、懸掛粉絲頁按鈕
 * 3. 確保 <footer> 內具備標準三大多按鈕：停車配置圖、教會粉絲頁、教會據點粉絲頁
 */
/**
 * ★ 全自動智慧按鈕防漏機制：
 * 若從 PDF 成功抽出了有效超連結（或線上表單），但 Gemini 生成的 HTML 中卻漏掉了此連結，
 * 本機制會自動比對內文相關段落並強制植入按鈕，杜絕任何按鈕遺漏！
 */
function injectMissingResolvedUrls(html, resolvedUrls) {
  let out = html || '';
  if (!resolvedUrls || !resolvedUrls.length) return out;

  resolvedUrls.forEach(function (item) {
    if (!item || !item.url || item.isOffering) return;
    // 排除粉絲頁與停車圖等已由 normalizeFooterLinks 管理之固定項目，及技術垃圾網址
    if (/facebook\.com|O56r6A|iec\.ch|w3\.org|adobe\.com/i.test(item.url)) return;
    if (JUNK_URL_RE.test(item.url)) return;

    // 若 HTML 中已經含有此網址（不論是完整或前綴匹配），代表已有按鈕，不重複插入
    if (out.indexOf(item.url) !== -1) return;
    const urlStem = item.url.split('?')[0];
    if (urlStem.length >= 25 && out.indexOf(urlStem) !== -1) return;

    const label = item.label || '線上報名與詳情';
    const cleanLabel = label.replace(/(線上|報名表|報名|課程|講座|活動|專頁|表單)/g, '').trim();

    // 1. 優先尋找標題關鍵字匹配的段落
    let matchIdx = -1;
    if (cleanLabel && cleanLabel.length >= 2) {
      matchIdx = out.indexOf(cleanLabel);
    }

    // 2. 若無精確標題匹配，尋找提及「報名/登記/QR Code/掃描」但尚未包含 <a> 按鈕的段落
    if (matchIdx === -1) {
      const pRegex = /<(p|li)>([\s\S]*?)<\/\1>/gi;
      let pm;
      while ((pm = pRegex.exec(out)) !== null) {
        const pContent = pm[2];
        if (/(報名|登記|QR\s*Code|掃描)/i.test(pContent) && !/<a\s+[^>]*href=/i.test(pContent)) {
          if (!/歡迎索取|一樓副堂最後一扇門|代禱箱|奉獻/.test(pContent)) {
            matchIdx = pm.index;
            break;
          }
        }
      }
    }

    const buttonHtml = '<p><a href="' + item.url + '" target="_blank" rel="noopener noreferrer" class="qr-link">' + label + '</a></p>';

    if (matchIdx !== -1) {
      const rest = out.slice(matchIdx);
      const close = rest.match(/<\/(p|li|h[1-6]|div|td|blockquote|summary)>/i);
      if (close) {
        const at = matchIdx + close.index + close[0].length;
        out = out.slice(0, at) + '\n' + buttonHtml + out.slice(at);
        Logger.log('       ✓ [防漏機制] 已自動為 PDF 抽出網址補上按鈕：' + label + ' (' + item.url + ')');
        return;
      }
    }

    // 3. 若都對不上特定段落，自動插入於「教會消息」或「牧區消息」
    const sectionMatch = out.match(/<summary[^>]*>(教會消息|牧區消息)<\/summary>/i);
    if (sectionMatch) {
      const at = sectionMatch.index + sectionMatch[0].length;
      out = out.slice(0, at) + '\n' + buttonHtml + out.slice(at);
      Logger.log('       ✓ [防漏機制] 已於消息章節自動補上按鈕：' + label);
    }
  });

  return out;
}

function normalizeFooterLinks(html) {
  let out = String(html || '');

  // 1. 全局清理：將所有指向 100068541559964 的舊網址或簡短網址統一為官方標準網址
  out = out.replace(/href=["']https?:\/\/(?:www\.)?facebook\.com\/(?:profile\.php\?id=)?100068541559964[^"']*["']/gi, 'href="' + CHURCH_FB_URL + '"');
  out = out.replace(/href=["']https?:\/\/(?:www\.)?facebook\.com\/tntklove062672323[^"']*["']/gi, 'href="' + BRANCH_FB_URL + '"');

  // 2. 標準化頁尾 <footer> 內的 .footer-links 區塊與三大按鈕
  const standardFooterLinks = 
    '    <div class="footer-links">\n' +
    '      <a href="' + PARKING_URL + '" target="_blank" rel="noopener noreferrer" class="qr-link">教會停車配置圖</a>\n' +
    '      <a href="' + CHURCH_FB_URL + '" target="_blank" rel="noopener noreferrer" class="qr-link">德光長老教會粉絲頁</a>\n' +
    '      <a href="' + BRANCH_FB_URL + '" target="_blank" rel="noopener noreferrer" class="qr-link">德光教會據點粉絲頁</a>\n' +
    '    </div>';

  if (/<footer\b/i.test(out)) {
    out = out.replace(/(<footer\b[^>]*>)([\s\S]*?)(<\/footer>)/i, function (all, pre, body, post) {
      let cleanBody = body;
      // 移除現有的 footer-links
      cleanBody = cleanBody.replace(/<div\s+class=["']footer-links["']>[\s\S]*?<\/div>/gi, '');
      // 移除 footer 內可能遺留的 dangling 按鈕（包含多餘的 <p><a ...>...</a></p>）
      cleanBody = cleanBody.replace(/<p>\s*<a\b[^>]*class=["']qr-link["'][^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');
      cleanBody = cleanBody.replace(/<p>\s*<a\b[^>]*(?:facebook\.com|O56r6A)[^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');
      cleanBody = cleanBody.replace(/\s+$/, '');
      return pre + cleanBody + '\n' + standardFooterLinks + '\n  ' + post;
    });
  }

  return out;
}



/**
 * 🎵 智慧校正禮拜程序中的聖詩與頌榮曲目
 * 徹底解決直書排版時引導虛線（點點）干擾 OCR 導致的形近誤判（如把三看成二、一三看成二二）
 */
function correctLiturgyHymns(html) {
  let out = html || '';

  // 1. 常見引導虛線干擾導致的直書形近錯字更正
  out = out.replace(/頌榮[：:]\s*五二二首/g, '頌榮：五一三首');
  out = out.replace(/聖詩[：:]\s*三二五首/g, '聖詩：三三五首');
  out = out.replace(/頌榮[：:]\s*522\s*首?/g, '頌榮：513首');
  out = out.replace(/聖詩[：:]\s*325\s*首?/g, '聖詩：335首');

  // 2. 頌榮合理性檢驗（長老教會主日禮拜結尾頌榮固定為 510~515 系列）
  out = out.replace(/頌榮[：:]\s*五([一二三四五六七八九〇]+)首/g, function (match, p1) {
    // 若出現非 510~515 之異常數字，針對常見 OCR 筆畫黏合做還原
    if (p1 === '二二') return '頌榮：五一三首';
    if (p1 === '一')   return '頌榮：五一一首';
    if (p1 === '二')   return '頌榮：五一二首';
    if (p1 === '三')   return '頌榮：五一三首';
    if (p1 === '四')   return '頌榮：五一四首';
    return match;
  });

  return out;
}

function stripJunkLinks(html) {
  let out = html || '';
  // 徹底移除連向 JUNK_URL_RE（如 iec.ch、adobe.com 等）的超連結標籤或段落
  out = out.replace(/<p\b[^>]*>\s*<a\b[^>]*href=["'][^"']*(iec\.ch|w3\.org|adobe\.com|color\.org)[^"']*["'][^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');
  out = out.replace(/<a\b[^>]*href=["'][^"']*(iec\.ch|w3\.org|adobe\.com|color\.org)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '');
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

/**
 * ★ 為每篇週報 HTML 自動注入無障礙字體縮放與語音朗讀 (TTS) 功能
 */
function injectAccessibilityAndTTS(html) {
  let out = String(html || '');
  // 清理可能已經存在的舊版注入標記，確保修復時能重新套用最新樣式與位置
  out = out.replace(/<style\s+id=["']tkch-a11y-styles["']>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<div\s+class=["']tkch-a11y-bar["']\s+id=["']tkch-a11y-toolbar["'][\s\S]*?<\/div>/gi, '');
  out = out.replace(/<script\s+id=["']tkch-a11y-script["']>[\s\S]*?<\/script>/gi, '');

  const a11yStyle = `
<style id="tkch-a11y-styles">
  :root {
    --font-scale: 1.0;
  }
  html {
    font-size: calc(16px * var(--font-scale)) !important;
  }
  body {
    font-size: 1rem !important;
    line-height: 1.75 !important;
    padding: 12px !important;
    margin: 0 auto !important;
  }
  .container, main {
    display: block !important;
    margin-left: auto !important;
    margin-right: auto !important;
    max-width: 680px !important;
    width: 100% !important;
  }
  /* 階梯式長輩字體：正文最高達 30px，程序表 26px，表格 22px，標題優雅自適應 */
  header h1 { font-size: 1.45rem !important; line-height: 1.3 !important; }
  header .subtitle { font-size: 1.05rem !important; }
  header .date-info { font-size: 0.88rem !important; }
  h1 { font-size: 1.45rem !important; }
  h2 { font-size: 1.25rem !important; }
  h3 { font-size: 1.1rem !important; }
  details summary {
    font-size: 0.95rem !important;
    line-height: 1.4 !important;
    font-weight: 600 !important;
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    gap: 8px !important;
    flex-wrap: wrap !important;
  }
  .theme-banner, .theme-banner p { font-size: 0.95rem !important; line-height: 1.6 !important; }
  .program-step {
    font-size: 0.88rem !important;
    line-height: 1.6 !important;
    display: flex !important;
    justify-content: space-between !important;
    align-items: baseline !important;
    gap: 8px !important;
    flex-wrap: wrap !important;
    padding: 6px 0 !important;
  }
  .program-step span {
    font-size: 0.88rem !important;
  }
  .program-step span:first-child {
    font-weight: 500;
    flex: 1 1 auto;
    word-break: break-word;
  }
  .program-step span:last-child {
    flex-shrink: 0;
    font-weight: 600;
  }
  .table-container {
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
    margin: 8px 0 !important;
  }
  table {
    font-size: 0.75rem !important;
    width: 100% !important;
  }
  table th, table td {
    font-size: 0.75rem !important;
    line-height: 1.45 !important;
    padding: 8px 10px !important;
  }
  p, li, blockquote {
    font-size: 1rem !important;
    line-height: 1.75 !important;
  }
  footer, footer p { font-size: 0.85rem !important; line-height: 1.6 !important; }
  .tkch-a11y-bar {
    position: sticky;
    top: 10px;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1.5px solid #5850ec;
    border-radius: 30px;
    padding: 6px 16px;
    margin: 10px auto 16px;
    box-shadow: 0 4px 16px rgba(88, 80, 236, 0.15);
    max-width: 95%;
    width: fit-content;
  }
  .tkch-a11y-label {
    font-size: 14px;
    font-weight: bold;
    color: #1e293b;
    user-select: none;
  }
  .tkch-btn {
    border: 1px solid #cbd5e1;
    background: #ffffff;
    color: #1e293b;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s;
  }
  .tkch-btn:hover {
    border-color: #5850ec;
    color: #5850ec;
  }
  .tkch-btn.active {
    background: #5850ec;
    color: #ffffff;
    border-color: #5850ec;
  }
  .tkch-btn-tts {
    background: #eff6ff;
    border-color: #3b82f6;
    color: #1d4ed8;
    border-radius: 20px;
    padding: 4px 14px;
  }
  .tkch-btn-tts.playing {
    background: #fff7ed;
    border-color: #ea580c;
    color: #ea580c;
  }
  .section-tts-btn {
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    color: #334155;
    border-radius: 14px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
    margin-left: 8px;
    vertical-align: middle;
  }
  .section-tts-btn.playing {
    background: #fff7ed;
    border-color: #ea580c;
    color: #ea580c;
  }
</style>
`;

  const a11yToolbar = `
  <div class="tkch-a11y-bar" id="tkch-a11y-toolbar" role="toolbar" aria-label="無障礙輔助工具">
    <span class="tkch-a11y-label">字體：</span>
    <button type="button" class="tkch-btn" onclick="adjustWeeklyFont(-0.15)" title="縮小字體">A-</button>
    <button type="button" class="tkch-btn active" id="btn-font-reset" onclick="adjustWeeklyFont(0)" title="標準字體">A</button>
    <button type="button" class="tkch-btn" onclick="adjustWeeklyFont(0.15)" title="放大字體（正文最高達 30px）">A+</button>
    <span style="color:#cbd5e1;margin:0 2px;">|</span>
    <button type="button" class="tkch-btn tkch-btn-tts" id="btn-read-all" onclick="toggleReadAll()">🔊 語音朗讀整篇</button>
  </div>
`;

  const a11yScript = `
<script id="tkch-a11y-script">
  let weeklyFontScale = 1.0;
  const FONT_KEY = 'tkch-font-scale';

  function initWeeklyFont() {
    try {
      const saved = localStorage.getItem(FONT_KEY);
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= 0.85 && val <= 1.88) weeklyFontScale = val;
      }
    } catch(e) {}
    applyWeeklyFont();
  }

  function adjustWeeklyFont(delta) {
    if (delta === 0) weeklyFontScale = 1.0;
    else {
      weeklyFontScale = Math.round((weeklyFontScale + delta) * 100) / 100;
      if (weeklyFontScale < 0.85) weeklyFontScale = 0.85;
      if (weeklyFontScale > 1.88) weeklyFontScale = 1.88;
    }
    try { localStorage.setItem(FONT_KEY, weeklyFontScale.toString()); } catch(e) {}
    applyWeeklyFont();
  }

  function applyWeeklyFont() {
    document.documentElement.style.setProperty('--font-scale', weeklyFontScale);
    const rBtn = document.getElementById('btn-font-reset');
    if (rBtn) {
      if (Math.abs(weeklyFontScale - 1.0) < 0.01) rBtn.classList.add('active');
      else rBtn.classList.remove('active');
    }
  }

  // === 語音朗讀 TTS ===
  let isSpeakingAll = false;
  let currentUtterance = null;

  function stopAllSpeech() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    isSpeakingAll = false;
    currentUtterance = null;
    const btnAll = document.getElementById('btn-read-all');
    if (btnAll) {
      btnAll.textContent = '🔊 語音朗讀整篇';
      btnAll.classList.remove('playing');
    }
    document.querySelectorAll('.section-tts-btn').forEach(b => {
      b.textContent = '🔊 朗讀';
      b.classList.remove('playing');
    });
  }

  function toggleReadAll() {
    if (!('speechSynthesis' in window)) {
      alert('您的瀏覽器不支援語音朗讀功能');
      return;
    }
    const synth = window.speechSynthesis;
    const btnAll = document.getElementById('btn-read-all');

    if (isSpeakingAll) {
      if (synth.speaking) {
        if (synth.paused) {
          synth.resume();
          btnAll.textContent = '⏸ 暫停朗讀';
          btnAll.classList.add('playing');
        } else {
          synth.pause();
          btnAll.textContent = '▶ 繼續朗讀';
          btnAll.classList.remove('playing');
        }
        return;
      }
    }

    stopAllSpeech();

    // 展開所有 details 以便長者查看，並收集文字
    document.querySelectorAll('details').forEach(d => d.open = true);

    // 擷取主要內容文字（排除工具列、footer 連結）
    const clone = document.body.cloneNode(true);
    const tb = clone.querySelector('#tkch-a11y-toolbar');
    if (tb) tb.remove();
    const ft = clone.querySelector('footer');
    if (ft) ft.remove();
    const st = clone.querySelectorAll('style, script');
    st.forEach(s => s.remove());

    const textToRead = clone.innerText.replace(/\\s+/g, ' ').trim();
    if (!textToRead) return;

    isSpeakingAll = true;
    btnAll.textContent = '⏸ 暫停朗讀';
    btnAll.classList.add('playing');

    const utter = new SpeechSynthesisUtterance(textToRead);
    utter.lang = 'zh-TW';
    utter.rate = 0.85; // 稍慢，適合長者
    utter.onend = () => stopAllSpeech();
    utter.onerror = () => stopAllSpeech();
    currentUtterance = utter;
    synth.speak(utter);
  }

  function readSection(summaryEl, btn) {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    const details = summaryEl.closest('details');

    if (btn.classList.contains('playing')) {
      stopAllSpeech();
      return;
    }

    stopAllSpeech();

    if (details) details.open = true;

    // 取得該區塊文字
    const clone = (details || summaryEl).cloneNode(true);
    clone.querySelectorAll('.section-tts-btn, style, script').forEach(el => el.remove());
    const text = clone.innerText.replace(/\\s+/g, ' ').trim();

    btn.textContent = '⏹ 停止';
    btn.classList.add('playing');

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-TW';
    utter.rate = 0.85;
    utter.onend = () => {
      btn.textContent = '🔊 朗讀';
      btn.classList.remove('playing');
    };
    utter.onerror = () => {
      btn.textContent = '🔊 朗讀';
      btn.classList.remove('playing');
    };
    synth.speak(utter);
  }

  // 為每一個 details > summary 自動添加小喇叭按鈕
  function attachSectionTTS() {
    if (!('speechSynthesis' in window)) return;
    document.querySelectorAll('details > summary').forEach(sum => {
      if (sum.querySelector('.section-tts-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'section-tts-btn';
      btn.textContent = '🔊 朗讀';
      btn.setAttribute('aria-label', '朗讀本區塊');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        readSection(sum, btn);
      });
      sum.appendChild(btn);
    });
  }

  window.addEventListener('beforeunload', stopAllSpeech);
  document.addEventListener('DOMContentLoaded', () => {
    initWeeklyFont();
    attachSectionTTS();
  });
  // 若 DOM 已載入
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    initWeeklyFont();
    attachSectionTTS();
  }
</script>
`;

  // 1. 注入 CSS 至 </head> 前
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, a11yStyle + '\n</head>');
  } else {
    out = a11yStyle + '\n' + out;
  }

  // 2. 注入工具列：優先放入 .container 開頭，避免與外層 flex 容器產生並排衝突
  if (/<div\b[^>]*class=["'][^"']*\bcontainer\b[^"']*["'][^>]*>/i.test(out)) {
    out = out.replace(/(<div\b[^>]*class=["'][^"']*\bcontainer\b[^"']*["'][^>]*>)/i, '$1\n' + a11yToolbar);
  } else if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/(<body[^>]*>)/i, '$1\n' + a11yToolbar);
  } else {
    out = a11yToolbar + '\n' + out;
  }

  // 3. 注入 JS 至 </body> 前
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, a11yScript + '\n</body>');
  } else {
    out = out + '\n' + a11yScript;
  }

  return out;
}



// ==========================================
// 🗜️ 輕量純 JavaScript Deflate / Zlib 解壓縮引擎（免依賴 Apps Script Utilities.ungzip 的 Java CRC 限制）
// 確保 100% 能解開 PDF 所有壓縮串流並抽出原始超連結
// ==========================================
(()=>{var xr=(r,n,t)=>()=>{if(t)throw t[0];try{return r&&(n=r(r=0)),n}catch(a){throw t=[a],a}};var zr=(r,n)=>()=>{try{return n||r((n={exports:{}}).exports,n),n.exports}catch(t){throw n=0,t}};function J(r,n){return vr(r,{i:2},n&&n.out,n&&n.dictionary)}function K(r,n){return vr(r.subarray(Zr(r,n&&n.dictionary),-4),{i:2},n&&n.out,n&&n.dictionary)}var h,M,Ar,ar,or,Sr,sr,fr,hr,Mr,ur,Ur,Lr,j,g,o,I,B,o,o,o,o,lr,o,Tr,Fr,W,u,Y,Dr,Cr,Ir,l,vr,Br,Zr,Er,Gr,cr=xr(()=>{h=Uint8Array,M=Uint16Array,Ar=Int32Array,ar=new h([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),or=new h([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),Sr=new h([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),sr=function(r,n){for(var t=new M(31),a=0;a<31;++a)t[a]=n+=1<<r[a-1];for(var i=new Ar(t[30]),a=1;a<30;++a)for(var c=t[a];c<t[a+1];++c)i[c]=c-t[a]<<5|a;return{b:t,r:i}},fr=sr(ar,2),hr=fr.b,Mr=fr.r;hr[28]=258,Mr[258]=28;ur=sr(or,0),Ur=ur.b,Lr=ur.r,j=new M(32768);for(o=0;o<32768;++o)g=(o&43690)>>1|(o&21845)<<1,g=(g&52428)>>2|(g&13107)<<2,g=(g&61680)>>4|(g&3855)<<4,j[o]=((g&65280)>>8|(g&255)<<8)>>1;I=(function(r,n,t){for(var a=r.length,i=0,c=new M(n);i<a;++i)r[i]&&++c[r[i]-1];var y=new M(n);for(i=1;i<n;++i)y[i]=y[i-1]+c[i-1]<<1;var p;if(t){p=new M(1<<n);var z=15-n;for(i=0;i<a;++i)if(r[i])for(var U=i<<4|r[i],w=n-r[i],e=y[r[i]-1]++<<w,s=e|(1<<w)-1;e<=s;++e)p[j[e]>>z]=U}else for(p=new M(a),i=0;i<a;++i)r[i]&&(p[i]=j[y[r[i]-1]++]>>15-r[i]);return p}),B=new h(288);for(o=0;o<144;++o)B[o]=8;for(o=144;o<256;++o)B[o]=9;for(o=256;o<280;++o)B[o]=7;for(o=280;o<288;++o)B[o]=8;lr=new h(32);for(o=0;o<32;++o)lr[o]=5;Tr=I(B,9,1),Fr=I(lr,5,1),W=function(r){for(var n=r[0],t=1;t<r.length;++t)r[t]>n&&(n=r[t]);return n},u=function(r,n,t){var a=n/8|0;return(r[a]|r[a+1]<<8)>>(n&7)&t},Y=function(r,n){var t=n/8|0;return(r[t]|r[t+1]<<8|r[t+2]<<16)>>(n&7)},Dr=function(r){return(r+7)/8|0},Cr=function(r,n,t){return(n==null||n<0)&&(n=0),(t==null||t>r.length)&&(t=r.length),new h(r.subarray(n,t))},Ir=["unexpected EOF","invalid block type","invalid length/literal","invalid distance","stream finished","no stream handler",,"no callback","invalid UTF-8 data","extra field too long","date not in range 1980-2099","filename too long","stream finishing","invalid zip data"],l=function(r,n,t){var a=new Error(n||Ir[r]);if(a.code=r,Error.captureStackTrace&&Error.captureStackTrace(a,l),!t)throw a;return a},vr=function(r,n,t,a){var i=r.length,c=a?a.length:0;if(!i||n.f&&!n.l)return t||new h(0);var y=!t,p=y||n.i!=2,z=n.i;y&&(t=new h(i*3));var U=function(tr){var er=t.length;if(tr>er){var ir=new h(Math.max(er*2,tr));ir.set(t),t=ir}},w=n.f||0,e=n.p||0,s=n.b||0,x=n.l,Z=n.d,T=n.m,F=n.n,O=i*8;do{if(!x){w=u(r,e,1);var q=u(r,e+1,3);if(e+=3,q)if(q==1)x=Tr,Z=Fr,T=9,F=5;else if(q==2){var $=u(r,e,31)+257,Q=u(r,e+10,15)+4,X=$+u(r,e+5,31)+1;e+=14;for(var D=new h(X),H=new h(19),f=0;f<Q;++f)H[Sr[f]]=u(r,e+f*3,7);e+=Q*3;for(var d=W(H),pr=(1<<d)-1,gr=I(H,d,1),f=0;f<X;){var k=gr[u(r,e,pr)];e+=k&15;var v=k>>4;if(v<16)D[f++]=v;else{var A=0,E=0;for(v==16?(E=3+u(r,e,3),e+=2,A=D[f-1]):v==17?(E=3+u(r,e,7),e+=3):v==18&&(E=11+u(r,e,127),e+=7);E--;)D[f++]=A}}var b=D.subarray(0,$),m=D.subarray($);T=W(b),F=W(m),x=I(b,T,1),Z=I(m,F,1)}else l(1);else{var v=Dr(e)+4,L=r[v-4]|r[v-3]<<8,P=v+L;if(P>i){z&&l(0);break}p&&U(s+L),t.set(r.subarray(v,P),s),n.b=s+=L,n.p=e=P*8,n.f=w;continue}if(e>O){z&&l(0);break}}p&&U(s+131072);for(var yr=(1<<T)-1,wr=(1<<F)-1,N=e;;N=e){var A=x[Y(r,e)&yr],S=A>>4;if(e+=A&15,e>O){z&&l(0);break}if(A||l(2),S<256)t[s++]=S;else if(S==256){N=e,x=null;break}else{var _=S-254;if(S>264){var f=S-257,C=ar[f];_=u(r,e,(1<<C)-1)+hr[f],e+=C}var R=Z[Y(r,e)&wr],V=R>>4;R||l(3),e+=R&15;var m=Ur[V];if(V>3){var C=or[V];m+=Y(r,e)&(1<<C)-1,e+=C}if(e>O){z&&l(0);break}p&&U(s+131072);var rr=s+_;if(s<m){var nr=c-m,mr=Math.min(m,rr);for(nr+s<0&&l(3);s<mr;++s)t[s]=a[nr+s]}for(;s<rr;++s)t[s]=t[s-m]}}n.l=x,n.p=N,n.b=s,n.f=w,x&&(w=1,n.m=T,n.d=Z,n.n=F)}while(!w);return s!=t.length&&y?Cr(t,0,s):t.subarray(0,s)},Br=new h(0),Zr=function(r,n){return((r[0]&15)!=8||r[0]>>4>7||(r[0]<<8|r[1])%31)&&l(6,"invalid zlib data"),(r[1]>>5&1)==+!n&&l(6,"invalid zlib data: "+(r[1]&32?"need":"unexpected")+" dictionary"),(r[1]>>3&4)+2};Er=typeof TextDecoder!="undefined"&&new TextDecoder,Gr=0;try{Er.decode(Br,{stream:!0}),Gr=1}catch(r){}});var Or=zr(G=>{cr();typeof globalThis!="undefined"&&(globalThis.fflateUnzlibSync=K,globalThis.fflateInflateSync=J);typeof G!="undefined"&&(G.fflateUnzlibSync=K,G.fflateInflateSync=J)});Or();})();

