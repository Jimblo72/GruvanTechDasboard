// netlify/functions/ai-review-result.js
// Läser resultatet som ai-review-background.js skrivit. Bakgrundsfunktioner
// svarar 202 utan kropp, så det här är enda vägen tillbaka till klienten.
//
// GET /.netlify/functions/ai-review-result?agent=external2
//   → { status: 'running' | 'done' | 'error' | 'none', jobId, text, model, ms, error }
//
// status 'none' = ingen fil finns än. Det är normalt de första sekunderna:
// bakgrundsfunktionen hinner inte alltid skriva startmarkören innan klienten
// pollar första gången.

const { readJsonFile } = require('./lib/store');

const RENT_ID = /^[a-z0-9-]{1,40}$/i;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    // Pollning måste se färsk data — mellanliggande cache skulle få klienten
    // att vänta på ett svar som redan ligger där.
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const agentId = (event.queryStringParameters || {}).agent || '';
  if (!RENT_ID.test(agentId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltigt agent-id' }) };
  }

  try {
    const { data } = await readJsonFile(`data/review-jobs/${agentId}.json`, null);
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'none' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
