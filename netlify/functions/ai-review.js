// netlify/functions/ai-review.js
// Säker serverless-funktion: håller API-nycklar i environment variables.
// Anropas av dashboardens AI-granskningspanel. Stödjer både Anthropic (Claude)
// och Gemini beroende på "provider" i request-body.
//
// SÄTT DESSA I NETLIFY → Site settings → Environment variables:
//   ANTHROPIC_API_KEY  = sk-ant-...
//   GEMINI_API_KEY     = ...
//   OPENROUTER_API_KEY = sk-or-v1-...
//   OPENROUTER_MODEL   = <modell-id>        (valfri — se callOpenRouter nedan)
//   OPENROUTER_REASONING_EFFORT = low        (valfri — low/medium/high)
//   OPENROUTER_TIMEOUT_MS       = 7000       (valfri — höj om Netlify ger 26 s)
//   OPENROUTER_FALLBACK_MODELS  = a,b        (valfri — reserver vid 429/driftstopp)
//
// Lägg INTE nycklar i denna fil. De läses från process.env vid körning.

const { callOpenRouter: callOpenRouterLib } = require('./lib/openrouter');

exports.handler = async (event) => {
  // Netlifys 10 s börjar ticka HÄR — vid kallstarten, inte när vi ringer ut.
  // Budgeten måste räknas från denna punkt, annars kan en långsam kallstart
  // plus en full fetch-budget tillsammans passera taket och ge 504.
  const startedAt = Date.now();
  // CORS + metodkontroll
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const { provider = 'claude', system = '', code = '', context = '' } = payload;

  if (!code.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ingen kod att granska' }) };
  }

  // Begränsa indatastorlek (skydd mot orimliga anrop). Taket följer providerns
  // kontextfönster i stället för att vara ett för alla: 60k tecken klipper
  // sociala-medier.html (458k) till en åttondel, och då granskas inte filen —
  // bara dess början. OpenRouter pekar mot 1M-kontextmodeller och tål hela.
  // 500k tecken ≈ 125k tokens och rymmer varje faktisk källfil i repona.
  // OBS: taket är inte längre det som binder — Netlifys 10 s är. Riktigt stora
  // filer hinner inte klart, och callOpenRouter avbryter då med ett läsbart fel.
  const MAX = { openrouter: 500000 }[provider] || 60000;
  const codeClipped = code.length > MAX ? code.slice(0, MAX) + '\n…(avkortat)' : code;

  const userPrompt =
    `${context ? `Kontext: ${context}\n\n` : ''}` +
    `Granska följande kod/innehåll. Var konkret och prioritera de viktigaste punkterna.\n\n` +
    '```\n' + codeClipped + '\n```';

  try {
    let text, usedModel, elapsedMs;
    if (provider === 'gemini') {
      text = await callGemini(system, userPrompt);
    } else if (provider === 'openrouter') {
      ({ text, model: usedModel, ms: elapsedMs } = await callOpenRouter(system, userPrompt, startedAt));
    } else {
      text = await callAnthropic(system, userPrompt);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ text, provider, model: usedModel, ms: elapsedMs }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message, provider }) };
  }
};

// ── Anthropic (Claude) ────────────────────────────────────────
async function callAnthropic(system, userPrompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1200,
      system: system || 'Du är en hjälpsam kodgranskare. Svara på svenska.',
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Anthropic HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim() || '(tomt svar)';
}

// ── Gemini ────────────────────────────────────────────────────
async function callGemini(system, userPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY saknas i Netlify environment variables');

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system || 'Du är en hjälpsam kodgranskare. Svara på svenska.' }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 1200, temperature: 0.3 },
      }),
    }
  );
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Gemini HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return text.trim() || '(tomt svar)';
}

// ── OpenRouter ────────────────────────────────────────────────
// Själva anropet, modellkedjan och felmeddelandena bor i lib/openrouter.js —
// delat med ai-review-background.js så de inte kan glida isär. Här återstår
// bara det som är unikt för den SYNKRONA vägen: att hinna svara innan
// Netlifys 10 s.
//
// OPENROUTER_TIMEOUT_MS är taket för HELA anropet räknat från funktionens
// ingång, inte för fetch:en. En fast fetch-budget gav 504: kallstarten hade
// redan ätit flera sekunder innan timern ens startade.
async function callOpenRouter(system, userPrompt, startedAt) {
  const takMs = Number(process.env.OPENROUTER_TIMEOUT_MS) || 8500;
  const forbrukat = Date.now() - (startedAt || Date.now());
  const budgetMs = takMs - forbrukat;
  // Ett golv här skulle kunna spränga taket igen vid extrem kallstart. Är det
  // för lite kvar är det ärligare att svara direkt — och nyttigt, för nu är
  // funktionen varm och nästa försök startar utan kallstartskostnaden.
  if (budgetMs < 1200) {
    throw new Error(`Kallstarten åt upp budgeten (${(forbrukat / 1000).toFixed(1)} s av ${(takMs / 1000).toFixed(1)} s) innan anropet hann gå ut. Kör igen — funktionen är varm nu.`);
  }
  return callOpenRouterLib(system, userPrompt, { budgetMs });
}
