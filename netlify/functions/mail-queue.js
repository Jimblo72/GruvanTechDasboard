// netlify/functions/mail-queue.js
// Läser godkännandekön som den schemalagda pollern (mail-poll.js) skrivit till
// data/mail-queue.json i GitHub-repot. Read-only för dashboarden.
//
// GET [?mailbox=<adress>] → { lastSeen, items: [...] }
//   - Utan ?mailbox: alla köposter (bakåtkompatibelt).
//   - Med ?mailbox: bara poster för den brevlådan. Gamla, otaggade poster
//     räknas som dagens enda brevlåda (defaultMailbox) så de fortfarande syns
//     under legacy-brevlådan efter migreringen.
//
// Miljövariabler: GH_TOKEN (+ GH_USER / GH_REPO). Se lib/store.js.

const { readJsonFile } = require('./lib/store');
const { defaultMailbox } = require('./lib/mailboxes');

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
    const state = data || { lastSeen: null, items: [] };
    let items = Array.isArray(state.items) ? state.items : [];

    const q = String((event.queryStringParameters && event.queryStringParameters.mailbox) || '').trim();
    if (q) {
      const def = defaultMailbox().address.toLowerCase();
      const want = q.toLowerCase();
      items = items.filter(it => String(it.mailbox || def).toLowerCase() === want);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ...state, items }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa kön: ${e.message}` }) };
  }
};
