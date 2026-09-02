// netlify/functions/seo-result.js
// Läser jobbstatusen som seo-scan-background.js skriver. Bakgrundsfunktioner
// svarar 202 utan kropp, så det här är enda vägen tillbaka till klienten.
//
// GET ?sajt=maklargruvan → { status: 'kor' | 'klar' | 'fel' | 'ingen', ... }
//
// 'ingen' = ingen fil finns än. Normalt de första sekunderna: bakgrundsjobbet
// hinner inte alltid skriva startmarkören innan klienten pollar första gången.

const { SAJTER } = require('./lib/seo');
const { readJsonFile } = require('./lib/store');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    // Pollning måste se färsk data — en mellanliggande cache skulle få klienten
    // att vänta på ett svar som redan ligger där.
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const sajtId = (event.queryStringParameters || {}).sajt || '';
  if (!SAJTER[sajtId]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Okänd sajt' }) };
  }

  try {
    const { data } = await readJsonFile(`data/seo/jobb/${sajtId}.json`, null);
    if (!data) return { statusCode: 200, headers, body: JSON.stringify({ status: 'ingen' }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
