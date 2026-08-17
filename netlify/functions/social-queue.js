// netlify/functions/social-queue.js
// Dashboardens API för sociala förslag (data/social-queue.json).
//
// GET  → { items, historik (senaste 20), lastRun }
// POST → { action, ... }:
//   { action:'approve', id, text }  godkänn med vald/redigerad text → 'godkänd'
//   { action:'discard', id }        kasta förslaget → 'kastad'
//   { action:'restore', id }        återöppna (ångra godkänn/kasta/irrelevant) → 'väntar'
//   { action:'watch' }              kör watchern nu (manuell "Hämta nu")
//
// Poster raderas aldrig — åtgärder ändrar bara status, och varje åtgärd loggas
// i append-only-historiken (lärdom från säljarrapportens historik-bugg).
// Publicering sker INTE här; ett senare publiceringssteg konsumerar 'godkänd'.
//
// Miljövariabler: GH_TOKEN (+ GH_USER/GH_REPO); ANTHROPIC_API_KEY för 'watch'.

const { readState, writeState, pushHistorik, runWatch } = require('./lib/social');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (event.httpMethod === 'GET') {
      const state = await readState();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ items: state.items, historik: state.historik.slice(0, 20), lastRun: state.lastRun }),
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON i request body' }) };
    }
    const action = String(body.action || '');

    // Manuell watcher-körning från dashboarden ("Hämta nu").
    if (action === 'watch') {
      const log = await runWatch();
      const state = await readState();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ log, items: state.items, historik: state.historik.slice(0, 20), lastRun: state.lastRun }),
      };
    }

    if (!['approve', 'discard', 'restore'].includes(action)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd action: ${action || '(saknas)'}` }) };
    }

    const id = String(body.id || '');
    const state = await readState();
    const item = state.items.find(it => it && it.id === id);
    if (!item) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `Hittar ingen köpost med id ${id}` }) };
    }

    if (action === 'approve') {
      // Texten kommer från UI:t (vald variant, ev. redigerad). Fallback: första
      // varianten — men tom text godkänns aldrig.
      const text = String(body.text || '').trim() || String((item.variants && item.variants[0] && item.variants[0].text) || '').trim();
      if (!text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ingen text att godkänna' }) };
      }
      item.status = 'godkänd';
      item.chosenText = text;
      item.decidedAt = new Date().toISOString();
      pushHistorik(state, { action: 'godkänd', id, note: item.title });
    } else if (action === 'discard') {
      item.status = 'kastad';
      item.decidedAt = new Date().toISOString();
      pushHistorik(state, { action: 'kastad', id, note: item.title });
    } else {
      item.status = 'väntar';
      delete item.decidedAt;
      pushHistorik(state, { action: 'återöppnad', id, note: item.title });
    }

    await writeState(state, `Sociala förslag: ${action} — ${item.title.slice(0, 60)}`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, items: state.items, historik: state.historik.slice(0, 20), lastRun: state.lastRun }),
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Sociala kön: ${e.message}` }) };
  }
};
