// netlify/functions/seo-scan-background.js
// Kör en hel SEO-genomgång för en sajt: hämta läge → jämför mot förra → låt
// Claude föreslå åtgärder → lägg förslagen i godkännandekön.
//
// VARFÖR BAKGRUND: en körning hämtar upp till 25 sidor, mäter PageSpeed (som
// ensamt kan ta en halv minut) och gör ett Claude-anrop. Netlifys synkrona tak
// är 10 sekunder. Bakgrundsfunktioner får 15 minuter.
//
// KONTRAKT: Netlify svarar 202 UTAN kropp. Klienten skickar ett eget jobId och
// pollar seo-result.js. Exakt samma mönster som ai-review-background.js.
//
// PUBLICERAR INGENTING. Förslagen landar som 'väntar' i kön och blir aldrig
// verklighet utan att någon godkänner dem — samma princip som sociala förslag.

const { SAJTER, byggOgonblicksbild, jamfor } = require('./lib/seo');
const { analysera } = require('./lib/seo-analys');
const { readJsonFile, writeJsonFile } = require('./lib/store');

const RENT_ID = /^[a-z0-9-]{1,40}$/i;

const bildPath = s => `data/seo/${s}-senaste.json`;
const jobbPath = s => `data/seo/jobb/${s}.json`;
const KO_PATH = 'data/seo/queue.json';

// Ett jobbresultat per SAJT, inte per körning: filerna kan då aldrig växa
// obegränsat. Klienten matchar jobId för att skilja sitt eget svar från en rest.
async function skrivJobb(sajtId, data) {
  try { await writeJsonFile(jobbPath(sajtId), data, `SEO-jobb ${sajtId}: ${data.status}`); }
  catch (e) { console.error('kunde inte skriva jobbstatus:', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Ogiltig JSON' }; }

  const { jobId = '', sajt: sajtId = '' } = payload;
  if (!RENT_ID.test(jobId)) return { statusCode: 400, body: 'Ogiltigt jobId' };
  if (!SAJTER[sajtId]) return { statusCode: 400, body: 'Okänd sajt' };

  const sajt = SAJTER[sajtId];
  const startad = new Date().toISOString();
  await skrivJobb(sajtId, { status: 'kor', jobId, sajt: sajtId, startad, steg: 'hämtar sidor' });

  try {
    // 1. Läge
    const bild = await byggOgonblicksbild(sajtId);
    await skrivJobb(sajtId, { status: 'kor', jobId, sajt: sajtId, startad, steg: 'jämför mot förra körningen' });

    // 2. Jämförelse mot förra körningen
    const { data: forra } = await readJsonFile(bildPath(sajtId), null);
    const diff = jamfor(bild, forra);

    // Spara läget INNAN analysen. Faller Claude-anropet har vi ändå kvar
    // mätningen, och nästa körning får något att jämföra mot.
    await writeJsonFile(bildPath(sajtId), bild, `SEO-läge ${sajt.namn}`);
    await skrivJobb(sajtId, { status: 'kor', jobId, sajt: sajtId, startad, steg: 'Claude analyserar' });

    // 3. Analys
    const resultat = await analysera(sajt, bild, diff);

    // 4. Kö. Förslagen läggs till, gamla väntande för samma sajt markeras
    // 'ersatt' i stället för att raderas — historiken är append-only, samma
    // lärdom som säljarrapportens historik-bugg.
    const { data: koRaw, sha } = await readJsonFile(KO_PATH, null);
    const ko = koRaw && Array.isArray(koRaw.poster) ? koRaw : { poster: [], historik: [] };
    const nu = new Date().toISOString();

    for (const p of ko.poster) {
      if (p.sajt === sajtId && p.status === 'väntar') p.status = 'ersatt';
    }

    const nya = (resultat.atgarder || []).map((a, i) => ({
      id: `${sajtId}-${Date.now().toString(36)}-${i}`,
      sajt: sajtId,
      status: 'väntar',
      skapad: nu,
      utforare: sajt.utforare,
      ...a,
    }));
    ko.poster = [...nya, ...ko.poster].slice(0, 300);
    ko.historik = [{ tid: nu, sajt: sajtId, handelse: `analys gav ${nya.length} förslag`, modell: resultat.modell }, ...(ko.historik || [])].slice(0, 200);
    ko.senasteAnalys = { ...(ko.senasteAnalys || {}), [sajtId]: { tid: nu, sammanfattning: resultat.sammanfattning } };

    await writeJsonFile(KO_PATH, ko, `SEO-kö: ${nya.length} förslag för ${sajt.namn}`, sha);

    await skrivJobb(sajtId, {
      status: 'klar', jobId, sajt: sajtId, startad, klar: new Date().toISOString(),
      sammanfattning: resultat.sammanfattning,
      antalForslag: nya.length,
      antalSidor: bild.sidor.length,
      antalAndringar: diff.andringar.length,
      forstaKorningen: !!diff.forsta,
      gscKopplad: !!(bild.gsc && !bild.gsc.fel),
      modell: resultat.modell,
    });

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    await skrivJobb(sajtId, {
      status: 'fel', jobId, sajt: sajtId, startad,
      klar: new Date().toISOString(), fel: e.message,
    });
    return { statusCode: 200, body: 'fel loggat' };
  }
};
