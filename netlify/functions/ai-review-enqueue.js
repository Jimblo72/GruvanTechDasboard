// netlify/functions/ai-review-enqueue.js
// Tar emot koden som ska granskas i bakgrunden och lägger den i datarepot.
//
// VARFÖR: bakgrundsfunktioner anropas asynkront och Netlify kapar deras
// begäran vid 256 KB — större kroppar får HTTP 413 innan funktionen ens
// startar. Synkrona funktioner får 6 MB. En normalstor fil (planritningar.html,
// ~250 000 tecken) plus systemprompten går över 256 KB. Koden får därför inte
// åka i bakgrundsfunktionens kropp: den åker hit, till en SYNKRON funktion, som
// skriver den till data/review-jobs/<roll>.input.json. Bakgrundsfunktionen får
// sedan bara { jobId, agentId } och läser resten själv.
//
// FLÖDE (klienten gör båda anropen):
//   1. POST ai-review-enqueue    { jobId, agentId, system, code, context } → 200
//   2. POST ai-review-background { jobId, agentId }                       → 202
//   3. GET  ai-review-result?agent=<roll>  (pollas tills jobId är klart)
//
// Varför inte anropa bakgrundsfunktionen härifrån: sajten är lösenordsskyddad
// i Netlify och skyddet gäller även funktionernas adresser. Ett anrop från en
// funktion till en annan får 401 och dör tyst — samma fälla som SEO-verktyget
// gick i (se seo-queue.js). Webbläsaren har lösenordskakan, funktionen har den
// inte.
//
// Miljövariabler: GH_TOKEN/GH_USER/GH_REPO för persistensen (se lib/store.js).

const { writeJsonFile } = require('./lib/store');

// Indatafilen skrivs över per roll, precis som resultatfilen, så datarepots
// arbetsträd växer inte. Bakgrundsfunktionen nollar den när jobbet är klart.
const inputPath = (agentId) => `data/review-jobs/${agentId}.input.json`;

// Bara det som kan bli ett filnamn. Skyddar mot sökvägsinjektion i GitHub-API:t.
const RENT_ID = /^[a-z0-9-]{1,40}$/i;

// Samma tak som bakgrundsvägen och den synkrona OpenRouter-vägen: rymmer varje
// faktisk källfil i repona (störst är sociala-medier.html på ~446k tecken).
// Kapas här, så att det som sparas är exakt det som granskas.
const MAX_CHARS = 500000;

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

  // Netlifys 10 s börjar ticka vid ingången. Tiden returneras så att det går
  // att se hur nära taket en stor fil ligger.
  const startedAt = Date.now();

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const { jobId = '', agentId = '', system = '', code = '', context = '' } = payload;

  if (!RENT_ID.test(agentId)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltigt agentId' }) };
  if (!RENT_ID.test(jobId))   return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltigt jobId' }) };
  if (typeof code !== 'string' || !code.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ingen kod att granska' }) };
  }

  const codeClipped = code.length > MAX_CHARS
    ? code.slice(0, MAX_CHARS) + '\n…(avkortat)'
    : code;

  const indata = {
    jobId,
    agentId,
    system: String(system || ''),
    context: String(context || ''),
    code: codeClipped,
    avkortad: code.length > MAX_CHARS,
    tecken: code.length,
    skapad: new Date().toISOString(),
  };

  try {
    await writeJsonFile(inputPath(agentId), indata, `Granskning: ${agentId} indata (${jobId})`);
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte spara koden för granskning: ${e.message}` }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, jobId, tecken: code.length, avkortad: indata.avkortad, ms: Date.now() - startedAt }),
  };
};
