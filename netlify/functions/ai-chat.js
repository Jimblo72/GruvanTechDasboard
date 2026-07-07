// netlify/functions/ai-chat.js
// Konversationsfunktion för den flytande chatt-widgeten. Hanterar full
// meddelandehistorik (till skillnad från ai-review som tar en kodblob).
// Stödjer Claude (Anthropic) och GPT (OpenAI) via "provider".
//
// Nycklar läses från Netlify environment variables — aldrig i frontend:
//   ANTHROPIC_API_KEY = sk-ant-...
//   OPENAI_API_KEY    = sk-...

exports.handler = async (event) => {
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

  const { provider = 'claude', system = '', messages = [] } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inga meddelanden' }) };
  }

  // Sanera: behåll bara role + content, begränsa historiklängd och storlek
  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-30)
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!clean.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inga giltiga meddelanden' }) };
  }

  try {
    let text;
    if (provider === 'gpt') {
      text = await callOpenAI(system, clean);
    } else {
      text = await callAnthropic(system, clean);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ text, provider }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message, provider }) };
  }
};

// ── Anthropic (Claude) ────────────────────────────────────────
async function callAnthropic(system, messages) {
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
      max_tokens: 1500,
      system: system || 'Du är en hjälpsam assistent. Svara på svenska.',
      messages,   // [{role, content}] — Anthropic accepterar user/assistant direkt
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
async function callOpenAI(system, messages) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY saknas i Netlify environment variables');

  // OpenAI vill ha system som första meddelande i arrayen
  const oaMessages = [
    { role: 'system', content: system || 'Du är en hjälpsam assistent. Svara på svenska.' },
    ...messages,
  ];

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1500,
      messages: oaMessages,
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || '(tomt svar)';
}
