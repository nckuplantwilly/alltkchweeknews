/**
 * Netlify Function: ask-gemini.js
 * 德光長老教會 週報 AI 智慧問答代理
 * 負責在伺服器端安全呼叫 Gemini API，不向前端暴露 API Key。
 */

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'NO_API_KEY', message: '尚未設定 GEMINI_API_KEY，將啟用本地搜尋備援' })
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const question = payload.question || '';
    const bulletins = payload.bulletins || [];

    if (!question.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Question is required' })
      };
    }

    // 特會與重要報名表活動知識（由 PDF 抽出的真實表單標題）
    const eventForms = {
      '2026-10-04': ['德光教會社青&兒主野外禮拜報名表 (https://forms.gle/cQdSLqTaKDy32J5b7)', '慕道班報名表'],
      '2026-10-11': ['德光教會社青&兒主野外禮拜報名表 (https://forms.gle/cQdSLqTaKDy32J5b7)', '2026德光教會「閱讀・以賽亞」講座', '2027年全年讀經靈修書籍代訂購']
    };

    // 全文檢索補充：接收前端預取的近期完整週報純文字（去 HTML tag 後）
    const fullTexts = payload.fullTexts || {}; // { "2026-10-11": "純文字...", ... }

    // 將現有的週報摘要整理成簡明上下文
    const bulletinContext = bulletins.slice(0, 15).map((b, i) => {
      const extraEvents = eventForms[b.date] ? `，本週活動報名：${eventForms[b.date].join('、')}` : '';
      const fullText = fullTexts[b.date]
        ? `\n  【本期完整內文（包含事奉輪值表、教會消息、禱告事項）】：\n${fullTexts[b.date].slice(0, 10000)}`
        : '';
      return `【期數 ${b.volume} 卷 ${b.issue} 期】主日日期：${b.date}，標題：${b.title}，摘要：${b.summary || '（無特定摘要）'}${extraEvents}，週報閱讀網址：${b.url}${fullText}`;
    }).join('\n\n');

    const systemPrompt = `你是一位熱心、親切且溫暖的「德光長老教會週報 AI 小幫手」，主要服務視力退化或需要查找教會資訊的長者與會友。
請依據下方提供的【歷期週報資料】來回答會友的詢問。

回答守則：
1. 語氣溫暖親切、尊重大方，使用繁體中文。
2. 請仔細檢閱每期週報的【摘要】、【本週活動與報名表】以及【本期完整內文】（包含事奉輪值表、同工名單、聚會消息等）。
3. 若會友詢問某位兄姊的服事（如司會、值週執事、司琴、音控、招待等），請在完整內文中的事奉輪值表中仔細查找，明確回報該兄姊在第幾期、哪一天擔任什麼服事職務。
4. 提供連結時，請一律使用 Markdown 超連結語法（例如：[點此閱讀第 41 期週報](網址) 或 [點此填寫報名表](網址)），切勿直接貼出一整串落落長的原始網址，以方便長者直接點擊。
5. 盡量條理分明、簡明扼要，方便長者閱讀或聆聽。
6. 若資料中確實完全未提及或找不到相關紀錄，請誠懇告知並簡要列出最近一兩期的主題供會友參考。
7. 排除所有奉獻金額與明細相關的詢問。

【歷期週報資料】：
${bulletinContext}`;

    const modelsToTry = [
      'gemini-flash-latest',
      'gemini-1.5-flash-latest',
      'gemini-2.0-flash'
    ];

    let answer = '';
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: `${systemPrompt}\n\n會友的問題是：「${question}」` }] }
            ],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 2048
            }
          })
        });

        if (response.ok) {
          const data = await response.json();
          answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (answer) break;
        } else {
          lastError = await response.text();
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!answer) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'GEMINI_API_ERROR', details: lastError })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ answer: answer })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'SERVER_ERROR', message: err.message })
    };
  }
};
