// netlify/functions/mail-queue.js
// Läser godkännandekön som den schemalagda pollern (mail-poll.js) skrivit till
// data/mail-queue.json i GitHub-repot. Read-only för dashboarden.
//
// GET → { lastSeen, items: [...] }
//
// Miljövariabler: GH_TOKEN (+ GH_USER / GH_REPO). Se lib/store.js.

const { readJsonFile } = require('./lib/store');

const FILE_PATH = 'data/mail-queue.json';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { data } = await readJsonFile(FILE_PATH, { lastSeen: null, items: [] });
    const out = data || { lastSeen: null, items: [] };
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa kön: ${e.message}` }) };
  }
};
