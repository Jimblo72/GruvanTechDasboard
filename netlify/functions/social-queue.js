// netlify/functions/social-queue.js
// Dashboardens API för sociala förslag (data/social-queue.json).
//
// GET  → { items, historik (senaste 20), lastRun, meta:{configured} }
// POST → { action, ... }:
//   { action:'approve', id, text }  godkänn med vald/redigerad text → 'godkänd'
//   { action:'discard', id }        kasta förslaget → 'kastad'
//   { action:'restore', id }        återöppna (ångra godkänn/kasta/irrelevant) → 'väntar'
//   { action:'watch' }              kör watchern nu (manuell "Hämta nu")
//   { action:'publish', id }        publicera en GODKÄND post på Mäklargruvans
//                                   Facebook-sida (systemanvändartoken, se
//                                   lib/social-meta.js) → 'publicerad'
//
// Publiceringsspärrar (det enda utåtriktade steget i hela kedjan):
//   * endast status 'godkänd' — och tillståndet läses FÄRSKT innan beslut
//   * redan publicerad → 409 (dubbelpostskydd; dubbelannons-lärdomen)
//   * 'restore' vägrar röra publicerade poster (ingen väg tillbaka till kön
//     som skulle möjliggöra omgodkännande + dubbelpost)
//   * Instagram kräver bild → körs bara när posten bär en imageUrl
//     (bildmotorn är inte byggd än, så FB-only tills vidare)
//
// Poster raderas aldrig — åtgärder ändrar bara status, och varje åtgärd loggas
// i append-only-historiken (lärdom från säljarrapportens historik-bugg).
//
// Miljövariabler: GH_TOKEN (+ GH_USER/GH_REPO); ANTHROPIC_API_KEY för 'watch';
// META_MG_SYSTEM_TOKEN för 'publish'.

const { readState, writeState, pushHistorik, runWatch } = require('./lib/social');
const { metaConfigured, publishToFacebook, publishToInstagram } = require('./lib/social-meta');

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
        body: JSON.stringify({
          items: state.items,
          historik: state.historik.slice(0, 20),
          lastRun: state.lastRun,
          meta: { configured: metaConfigured() },
        }),
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

    if (!['approve', 'discard', 'restore', 'publish'].includes(action)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd action: ${action || '(saknas)'}` }) };
    }

    const id = String(body.id || '');
    // Färsk läsning för VARJE muterande åtgärd — särskilt viktigt för publish
    // (skydd mot dubbelklick och två öppna flikar).
    const state = await readState();
    const item = state.items.find(it => it && it.id === id);
    if (!item) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `Hittar ingen köpost med id ${id}` }) };
    }

    // Publicering — det enda steget som lämnar huset.
    if (action === 'publish') {
      if (item.status === 'publicerad') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Redan publicerad — dubbelpostskyddet stoppade.' }) };
      }
      if (item.status !== 'godkänd') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: `Bara godkända poster kan publiceras (denna är '${item.status}').` }) };
      }
      const text = String(item.chosenText || '').trim();
      if (!text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Posten saknar godkänd text.' }) };
      }
      if (!metaConfigured()) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'META_MG_SYSTEM_TOKEN saknas i Netlify — publicering är inte konfigurerad än.' }) };
      }

      // Facebook först. Kastar vid fel → posten förblir 'godkänd' och felet
      // visas i UI:t (inget skrivs, inget halvt tillstånd).
      const fb = await publishToFacebook(text, item.imageUrl || null);

      // Instagram bara när en bild finns (IG kräver bild). Ett IG-fel får INTE
      // rulla tillbaka FB — rapportera partiellt i stället.
      let ig = null;
      let igError = null;
      if (item.imageUrl) {
        try {
          ig = await publishToInstagram(item.imageUrl, text);
        } catch (e) {
          igError = e.message;
        }
      }

      item.status = 'publicerad';
      item.publishedAt = new Date().toISOString();
      item.fb = fb;
      if (ig) item.ig = ig;
      if (igError) item.igError = igError;
      pushHistorik(state, { action: 'publicerad', id, note: `${item.title} → ${fb.postId}${igError ? ` (IG-fel: ${igError})` : ''}` });
      await writeState(state, `Sociala förslag: publicerad — ${item.title.slice(0, 60)}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, fb, ig, igError, items: state.items, historik: state.historik.slice(0, 20), lastRun: state.lastRun, meta: { configured: metaConfigured() } }),
      };
    }

    if (action === 'approve') {
      if (item.status === 'publicerad') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Posten är redan publicerad — omgodkännande skulle öppna för dubbelpost.' }) };
      }
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
      if (item.status === 'publicerad') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Publicerade poster kan inte kastas — hantera inlägget på Facebook.' }) };
      }
      item.status = 'kastad';
      item.decidedAt = new Date().toISOString();
      pushHistorik(state, { action: 'kastad', id, note: item.title });
    } else {
      if (item.status === 'publicerad') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Publicerade poster kan inte återöppnas (skulle öppna för dubbelpost) — hantera inlägget på Facebook.' }) };
      }
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
