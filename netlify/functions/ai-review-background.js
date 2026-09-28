// netlify/functions/ai-review-background.js
// Asynkron kodgranskning via OpenRouter.
//
// VARFÖR: den synkrona ai-review.js måste svara innan Netlifys 10 s, och det
// taket tvingar fram små, snabba modeller. Det var precis vad som gav en
// granskning som lät kunnig men vars "kritiska" fynd var påhittade. Taket är
// alltså kvalitetstaket. Bakgrundsfunktioner får 15 minuter, så här kan djupet
// väljas fritt: större modell, hög tankenivå, hela filen.
//
// KONTRAKT: Netlify svarar 202 direkt UTAN kropp — anroparen får aldrig något
// resultat den här vägen. Klienten skickar med ett eget jobId, och hämtar sedan
// svaret från ai-review-result.js. Samma mönster som trigger-knapparna i
// granskningspanelen, som pollar ett GitHub-issue tills det ändrats.
//
// KODEN ÅKER INTE I KROPPEN. Bakgrundsfunktioner kapar begäran vid 256 KB och
// svarar 413 på allt större — en normalstor fil plus systemprompten gick över.
// Klienten lägger därför först koden i datarepot via den synkrona
// ai-review-enqueue.js (6 MB tak), och hit skickas bara { jobId, agentId }.
// Funktionen läser själv data/review-jobs/<roll>.input.json och kontrollerar
// att jobId stämmer, så att ett gammalt jobb aldrig granskar fel kod.
//
// Miljövariabler: OPENROUTER_API_KEY (+ modellval, se lib/openrouter.js),
// GH_TOKEN/GH_USER/GH_REPO för persistensen (se lib/store.js).

const { callOpenRouter } = require('./lib/openrouter');
const { writeJsonFile, readJsonFileRaw } = require('./lib/store');

// Ett resultat per roll, inte per jobb: då kan filerna aldrig växa obegränsat
// och behöver ingen städning. Klienten avgör med jobId om svaret är dess eget
// eller en rest från en tidigare körning.
const jobPath = (agentId) => `data/review-jobs/${agentId}.json`;
const inputPath = (agentId) => `data/review-jobs/${agentId}.input.json`;

// Bara det som kan bli ett filnamn. Skyddar mot sökvägsinjektion i GitHub-API:t.
const RENT_ID = /^[a-z0-9-]{1,40}$/i;

// Taket för indata. Enqueue kapar redan vid samma gräns; kapningen här är ett
// skydd om indatafilen skulle ha skrivits på annat sätt.
const MAX_CHARS = 500000;

// Väl tilltaget men ändligt. 15 min är plattformens tak; fastnar anropet vill
// vi ändå skriva ett läsbart fel i stället för att dö tyst vid taket.
const BUDGET_MS = Number(process.env.OPENROUTER_BG_TIMEOUT_MS) || 240000;

// GitHubs contents-API kan några sekunder efter en skrivning fortfarande
// leverera den förra versionen av filen. Enqueue skrev precis, så ett jobId
// som inte stämmer i första läsningen är oftast bara fördröjning — försök
// några gånger innan det räknas som fel.
const LAS_FORSOK = 4;
const LAS_PAUS_MS = 1500;

async function lasIndata(agentId, jobId) {
  let senaste = null;
  let lasfel = null;
  for (let i = 0; i < LAS_FORSOK; i++) {
    if (i > 0) await new Promise(res => setTimeout(res, LAS_PAUS_MS));
    // Ett tillfälligt GitHub-fel (5xx, rate limit) ska inte avbryta
    // omförsöken — det är samma sorts fördröjning som loopen finns för.
    let data;
    try { ({ data } = await readJsonFileRaw(inputPath(agentId), null)); lasfel = null; }
    catch (e) { lasfel = e; continue; }
    senaste = data;
    if (data && data.jobId === jobId && typeof data.code === 'string') return data;
  }
  // Felade sista läsningen är det felet som säger mest, inte "saknas".
  if (lasfel) throw new Error(`Kunde inte läsa indata för jobbet: ${lasfel.message}`);
  if (!senaste) throw new Error('Indata för jobbet saknas i datarepot — kördes ai-review-enqueue först?');
  if (senaste.jobId !== jobId) throw new Error('Indatafilen tillhör ett annat jobb — en nyare granskning har troligen startats för samma roll.');
  throw new Error('Indatafilen för jobbet är redan förbrukad eller saknar kod.');
}

// Nolla indatafilen när den är förbrukad. Git-historiken har koden kvar, men
// arbetsträdet ska inte bära en halv megabyte mellan körningarna. Läser först:
// har en nyare granskning av samma roll lagt sin kod där under tiden får den
// ligga orörd, annars skulle det jobbet hitta en tom fil.
async function rensaIndata(agentId, jobId) {
  const { data } = await readJsonFileRaw(inputPath(agentId), null);
  if (!data || data.jobId !== jobId || typeof data.code !== 'string') return;
  await writeJsonFile(inputPath(agentId), { jobId, status: 'förbrukad', rensad: new Date().toISOString() },
    `Granskning: ${agentId} indata rensad (${jobId})`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Ogiltig JSON' }; }

  const { jobId = '', agentId = '' } = payload;

  if (!RENT_ID.test(agentId)) return { statusCode: 400, body: 'Ogiltigt agentId' };
  if (!RENT_ID.test(jobId))   return { statusCode: 400, body: 'Ogiltigt jobId' };

  const path = jobPath(agentId);
  const startedAt = new Date().toISOString();

  // Markera att jobbet lever. Skiljer "startade aldrig" från "arbetar än" när
  // något går fel — utan markören ser båda likadana ut för den som pollar.
  try {
    await writeJsonFile(path, { jobId, status: 'running', startedAt },
      `Granskning: ${agentId} startad (${jobId})`);
  } catch (e) {
    // Kan vi inte skriva kan vi inte heller leverera svaret. Avbryt direkt.
    return { statusCode: 500, body: `Kunde inte skriva jobbstatus: ${e.message}` };
  }

  let resultat;
  let lastIndata = false;
  try {
    const { system = '', code = '', context = '' } = await lasIndata(agentId, jobId);
    lastIndata = true;
    if (!code.trim()) throw new Error('Ingen kod att granska');

    const codeClipped = code.length > MAX_CHARS
      ? code.slice(0, MAX_CHARS) + '\n…(avkortat)'
      : code;

    const userPrompt =
      `${context ? `Kontext: ${context}\n\n` : ''}` +
      `Granska följande kod/innehåll. Var konkret och prioritera de viktigaste punkterna.\n\n` +
      '```\n' + codeClipped + '\n```';

    const { text, model, ms, kedja } = await callOpenRouter(system, userPrompt, {
      budgetMs: BUDGET_MS,
      // Här finns tiden. Hela poängen med den här vägen är att slippa välja
      // bort djup för att passa ett tidstak.
      effort: process.env.OPENROUTER_BG_REASONING_EFFORT || 'high',
      maxTokens: Number(process.env.OPENROUTER_BG_MAX_TOKENS) || 8000,
    });
    resultat = { jobId, status: 'done', text, model, ms, kedja, startedAt, finishedAt: new Date().toISOString() };
  } catch (e) {
    resultat = { jobId, status: 'error', error: e.message, startedAt, finishedAt: new Date().toISOString() };
  }

  try {
    await writeJsonFile(path, resultat, `Granskning: ${agentId} ${resultat.status} (${jobId})`);
  } catch (e) {
    // Sista utvägen: loggen. Klienten kommer att tajma ut, vilket är rätt —
    // men felet ska gå att hitta efteråt.
    console.error(`[ai-review-background] kunde inte skriva resultat för ${agentId}:`, e.message);
    return { statusCode: 500, body: e.message };
  }

  // Efter resultatet, så att ett misslyckande här aldrig kostar svaret.
  if (lastIndata) {
    try { await rensaIndata(agentId, jobId); }
    catch (e) { console.error(`[ai-review-background] kunde inte rensa indata för ${agentId}:`, e.message); }
  }

  return { statusCode: 200, body: resultat.status };
};
