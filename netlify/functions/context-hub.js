// netlify/functions/context-hub.js
// Kontext-hub: en central plats för delad projektkontext + handoffs som du
// klistrar mellan Claude Chatt / Code / Design så att inget går förlorat.
// Lagras versionerat som JSON i GitHub-repot: data/context-hub.json — samma
// GitHub-proxy-mönster som contacts.js / mail-queue.js (ingen databas).
//
// GET  → { entries: [...] }   (tom array om filen inte finns än — kastar inte)
// POST { action:"save", entry:{...} } → upsert på id (genererar id om saknas),
//        sätter updated, skriver tillbaka. Returnerar { entries }.
// POST { action:"delete", id } → tar bort posten. Returnerar { entries }.
//
// Datan är projektanteckningar du själv skriver — icke-känslig by design — men
// lagras i det (privata) repot via GH-proxyn, precis som kontaktnätverket.
//
// Miljövariabler (Netlify): GH_TOKEN (+ GH_USER / GH_REPO). Se lib/store.js.

const { readJsonFile, writeJsonFile } = require('./lib/store');

const FILE_PATH = 'data/context-hub.json';
const MAX_ENTRIES = 100;

function slugId(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  return (base ? base + '-' : 'k-') + suffix;
}

// Lätt sanering: behåll bara kända fält, kapa längder.
function cleanEntry(e) {
  return {
    id: String(e.id || '').slice(0, 60),
    title: String(e.title || '').slice(0, 200),
    project: String(e.project || '').slice(0, 120),
    body: String(e.body || '').slice(0, 20000),
    updated: String(e.updated || '').slice(0, 40),
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  if (!process.env.GH_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GH_TOKEN saknas i Netlify environment variables — Kontext-hub kan inte läsa/skriva utan den.' }) };
  }

  // ── GET: hämta alla poster ──────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const { data } = await readJsonFile(FILE_PATH, { entries: [] });
      const entries = Array.isArray(data && data.entries) ? data.entries.map(cleanEntry) : [];
      return { statusCode: 200, headers, body: JSON.stringify({ entries }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa Kontext-hub: ${e.message}` }) };
    }
  }

  // ── POST: spara (upsert) eller ta bort ──────────────────────
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

    const action = payload.action || 'save';

    try {
      const { data, sha } = await readJsonFile(FILE_PATH, { entries: [] });
      let entries = Array.isArray(data && data.entries) ? data.entries.map(cleanEntry) : [];

      if (action === 'delete') {
        const id = String(payload.id || '');
        if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Fältet "id" krävs för delete' }) };
        entries = entries.filter(e => e.id !== id);
        await writeJsonFile(FILE_PATH, { entries }, `Kontext-hub: ta bort post (${id})`, sha);
        return { statusCode: 200, headers, body: JSON.stringify({ entries }) };
      }

      if (action === 'save') {
        const raw = payload.entry || {};
        if (!String(raw.title || '').trim() && !String(raw.body || '').trim()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'En post behöver minst en titel eller en text.' }) };
        }
        const entry = cleanEntry(raw);
        if (!entry.id) entry.id = slugId(entry.title);
        entry.updated = new Date().toISOString();

        const idx = entries.findIndex(e => e.id === entry.id);
        if (idx >= 0) entries[idx] = entry;
        else entries.unshift(entry);

        // Tak: behåll de senast uppdaterade posterna.
        if (entries.length > MAX_ENTRIES) {
          entries.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
          entries = entries.slice(0, MAX_ENTRIES);
        }

        await writeJsonFile(FILE_PATH, { entries }, `Kontext-hub: spara "${entry.title || entry.id}"`, sha);
        return { statusCode: 200, headers, body: JSON.stringify({ entries }) };
      }

      return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd action: ${action}` }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte skriva Kontext-hub: ${e.message}` }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
