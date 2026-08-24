// netlify/functions/ai-review.js
// Säker serverless-funktion: håller API-nycklar i environment variables.
// Anropas av dashboardens AI-granskningspanel. Stödjer både Anthropic (Claude)
// och Gemini beroende på "provider" i request-body.
//
// SÄTT DESSA I NETLIFY → Site settings → Environment variables:
//   ANTHROPIC_API_KEY  = sk-ant-...
//   GEMINI_API_KEY     = ...
//   OPENROUTER_API_KEY = sk-or-v1-...
//   OPENROUTER_MODEL   = stealth/ox-alpha   (valfri — se callOpenRouter nedan)
//   OPENROUTER_REASONING_EFFORT = low        (valfri — low/medium/high)
//
// Lägg INTE nycklar i denna fil. De läses från process.env vid körning.

exports.handler = async (event) => {
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

  // Begränsa indatastorlek (skydd mot orimliga anrop)
  const MAX = 60000;
  const codeClipped = code.length > MAX ? code.slice(0, MAX) + '\n…(avkortat)' : code;

  const userPrompt =
    `${context ? `Kontext: ${context}\n\n` : ''}` +
    `Granska följande kod/innehåll. Var konkret och prioritera de viktigaste punkterna.\n\n` +
    '```\n' + codeClipped + '\n```';

  try {
    let text, usedModel;
    if (provider === 'gemini') {
      text = await callGemini(system, userPrompt);
    } else if (provider === 'openrouter') {
      ({ text, model: usedModel } = await callOpenRouter(system, userPrompt));
    } else {
      text = await callAnthropic(system, userPrompt);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ text, provider, model: usedModel }) };
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

// ── OpenRouter (OpenAI-kompatibelt) ───────────────────────────
// Modellen sätts i ENV, aldrig i koden. Stealth-modeller som ox-alpha är
// förhandsvisningar från anonyma leverantörer och plockas bort utan förvarning
// — när den dagen kommer byter du OPENROUTER_MODEL i Netlify i stället för att
// deploya om. Samma anrop når varje annan modell på OpenRouter.
//
// ⚠ DATAPOLICY: OpenRouter anger att prompt och svar BEHÅLLS av leverantören
// (används ej för träning). Skicka därför bara kod hit — aldrig kundmail,
// persondata eller annat som hör hemma i mail-/triage-flödena.
//
// ⚠ TIDSTAK: Netlifys synkrona funktioner dör vid 10 s och taket går inte att
// höja i netlify.toml (se kommentaren där). Resonemangsmodeller tänker innan de
// svarar, så stora filer hinner inte klart. Vi avbryter själva strax innan och
// ger ett läsbart fel i stället för Netlifys tysta 502.
async function callOpenRouter(system, userPrompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY saknas i Netlify environment variables');

  const model = process.env.OPENROUTER_MODEL || 'stealth/ox-alpha';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);

  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-Title': 'Gruvan Tech Dashboard', // syns i OpenRouters aktivitetslogg
      },
      body: JSON.stringify({
        model,
        // Tankekedjan räknas mot output-budgeten hos resonemangsmodeller. 1200
        // som för de andra providrarna ger tomt eller avhugget svar.
        max_tokens: 4000,
        temperature: 0.3,
        // Låg tankenivå är ett medvetet val, inte snålhet: det är enda sättet
        // att hinna under Netlifys 10 s. Höj via env om taket någonsin försvinner
        // (ox-alpha stödjer low/medium/high). Ignoreras av modeller utan stöd.
        reasoning: { effort: process.env.OPENROUTER_REASONING_EFFORT || 'low' },
        messages: [
          { role: 'system', content: system || 'Du är en hjälpsam kodgranskare. Svara på svenska.' },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`${model} svarade inte inom 9 s (Netlifys funktionstak är 10 s). Testa en kortare fil, eller en snabbare modell i OPENROUTER_MODEL.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const errText = await r.text();
    // 404 här betyder oftast att stealth-modellen har avvecklats.
    const hint = r.status === 404 ? ' — modellen finns inte längre? Byt OPENROUTER_MODEL.' : '';
    throw new Error(`OpenRouter HTTP ${r.status}: ${errText.slice(0, 200)}${hint}`);
  }
  const data = await r.json();
  // OpenRouter kan svara 200 med ett fel i kroppen.
  if (data.error) {
    throw new Error(`OpenRouter: ${(data.error.message || JSON.stringify(data.error)).slice(0, 200)}`);
  }
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return { text: text || '(tomt svar)', model: data.model || model };
}
