// netlify/functions/ai-review.js
// Säker serverless-funktion: håller API-nycklar i environment variables.
// Anropas av dashboardens AI-granskningspanel. Stödjer både Anthropic (Claude)
// och Gemini beroende på "provider" i request-body.
//
// SÄTT DESSA I NETLIFY → Site settings → Environment variables:
//   ANTHROPIC_API_KEY = sk-ant-...
//   GEMINI_API_KEY    = ...
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
    let text;
    if (provider === 'gemini') {
      text = await callGemini(system, userPrompt);
    } else {
      text = await callAnthropic(system, userPrompt);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ text, provider }) };
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
