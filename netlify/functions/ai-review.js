// netlify/functions/ai-review.js
// Säker serverless-funktion: håller API-nycklar i environment variables.
// Anropas av dashboardens AI-granskningspanel. Stödjer både Anthropic (Claude)
// och OpenAI (GPT) beroende på "provider" i request-body.
//
// SÄTT DESSA I NETLIFY → Site settings → Environment variables:
//   ANTHROPIC_API_KEY = sk-ant-...
//   OPENAI_API_KEY    = sk-...
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
    if (provider === 'gpt') {
      text = await callOpenAI(system, userPrompt);
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

// ── OpenAI (GPT) ──────────────────────────────────────────────
async function callOpenAI(system, userPrompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY saknas i Netlify environment variables');

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1200,
      messages: [
        { role: 'system', content: system || 'You are a helpful code reviewer. Respond in Swedish.' },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || '(tomt svar)';
}
