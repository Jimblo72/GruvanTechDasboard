// netlify/functions/seo-queue.js
// Dashboardens API för SEO-förslagen (data/seo/queue.json) och för att starta
// en genomgång.
//
// GET  → { poster, historik, senasteAnalys, sajter, gscKopplad, senasteLage }
// POST → { handling, ... }:
//   { handling:'starta', sajt }        starta en genomgång (bakgrundsjobb) → { jobId }
//   { handling:'godkann', id, text }   markera förslaget som godkänt, ev. redigerat
//   { handling:'kasta', id }           lägg undan förslaget
//   { handling:'aterstall', id }       ångra godkänn/kasta → tillbaka till 'väntar'
//
// VAD "GODKÄNN" BETYDER HÄR: ingenting utåt. Statusen ändras och posten hamnar i
// listan över godkända. Utförarsteget — PR för maklargruvan.se, mejlunderlag
// till Prowebb för peakfast.se — byggs separat och konsumerar bara status
// 'godkänd'. Samma uppdelning som sociala förslag, av samma skäl: det som når
// utsidan ska vara ett eget, granskat steg.
//
// Poster raderas aldrig. Åtgärder byter status och loggas i append-only-
// historiken (lärdomen från säljarrapportens historik-bugg).

const { SAJTER, gscKonfigurerad } = require('./lib/seo');
const { readJsonFile, writeJsonFile } = require('./lib/store');

const KO_PATH = 'data/seo/queue.json';
const RENT_ID = /^[a-z0-9-]{1,60}$/i;

const tomKo = () => ({ poster: [], historik: [], senasteAnalys: {} });

async function lasKo() {
  const { data, sha } = await readJsonFile(KO_PATH, null);
  const ko = data && Array.isArray(data.poster) ? data : tomKo();
  if (!Array.isArray(ko.historik)) ko.historik = [];
  if (!ko.senasteAnalys) ko.senasteAnalys = {};
  return { ko, sha };
}

function logga(ko, handelse) {
  ko.historik = [{ tid: new Date().toISOString(), ...handelse }, ...ko.historik].slice(0, 200);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (event.httpMethod === 'GET') {
      const { ko } = await lasKo();
      // Läget per sajt tas med så vyn kan visa nyckeltal utan en andra rundtur.
      const lagen = {};
      for (const id of Object.keys(SAJTER)) {
        const { data } = await readJsonFile(`data/seo/${id}-senaste.json`, null);
        if (data) {
          lagen[id] = {
            tid: data.tid,
            antalSidor: (data.sidor || []).length,
            robots: !!data.robots?.finns,
            sitemap: !!data.sitemap?.finns,
            sitemapAntal: data.sitemap?.antal || 0,
            pagespeed: data.pagespeed && !data.pagespeed.fel ? data.pagespeed : null,
            gsc: data.gsc && !data.gsc.fel ? { klick: data.gsc.summa.klick, visningar: data.gsc.summa.visningar } : null,
          };
        }
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          poster: ko.poster,
          historik: ko.historik.slice(0, 30),
          senasteAnalys: ko.senasteAnalys,
          senasteLage: lagen,
          sajter: Object.values(SAJTER).map(s => ({ id: s.id, namn: s.namn, bas: s.bas, utforare: s.utforare })),
          gscKopplad: gscKonfigurerad(),
        }),
      };
    }

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

    const { handling } = body;

    // Att starta en genomgång görs INTE härifrån. Sajten är lösenordsskyddad i
    // Netlify, och skyddet gäller även funktionernas adresser — ett anrop från
    // den här funktionen till seo-scan-background får 401 och dör tyst, vilket
    // ser ut som ett jobb som aldrig blir klart. Webbläsaren har lösenordskakan,
    // funktionen har den inte. Klienten anropar därför bakgrundsfunktionen
    // direkt, precis som granskningspanelen gör med ai-review-background.

    // ── åtgärder på en post ────────────────────────────────────────────────
    const id = body.id || '';
    if (!RENT_ID.test(id)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltigt id' }) };

    const { ko, sha } = await lasKo();
    const post = ko.poster.find(p => p.id === id);
    if (!post) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Förslaget finns inte' }) };

    if (handling === 'godkann') {
      // Den redigerade texten vinner över modellens förslag. Att kunna justera
      // innan godkännande är hela poängen med kön.
      if (typeof body.text === 'string' && body.text.trim()) post.foreslaget = body.text.trim();
      post.status = 'godkänd';
      post.godkand = new Date().toISOString();
      logga(ko, { sajt: post.sajt, handelse: 'godkänd', rubrik: post.rubrik });
    } else if (handling === 'kasta') {
      post.status = 'kastad';
      logga(ko, { sajt: post.sajt, handelse: 'kastad', rubrik: post.rubrik });
    } else if (handling === 'aterstall') {
      post.status = 'väntar';
      delete post.godkand;
      logga(ko, { sajt: post.sajt, handelse: 'återställd', rubrik: post.rubrik });
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Okänd handling' }) };
    }

    await writeJsonFile(KO_PATH, ko, `SEO-kö: ${handling} ${id}`, sha);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, post }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
