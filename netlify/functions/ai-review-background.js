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
// Miljövariabler: OPENROUTER_API_KEY (+ modellval, se lib/openrouter.js),
// GH_TOKEN/GH_USER/GH_REPO för persistensen (se lib/store.js).

const { callOpenRouter } = require('./lib/openrouter');
const { writeJsonFile } = require('./lib/store');

// Ett resultat per roll, inte per jobb: då kan filerna aldrig växa obegränsat
// och behöver ingen städning. Klienten avgör med jobId om svaret är dess eget
// eller en rest från en tidigare körning.
const jobPath = (agentId) => `data/review-jobs/${agentId}.json`;

// Bara det som kan bli ett filnamn. Skyddar mot sökvägsinjektion i GitHub-API:t.
const RENT_ID = /^[a-z0-9-]{1,40}$/i;

// Taket för indata. Samma 500k som den synkrona vägen: rymmer varje faktisk
// källfil i repona (störst är sociala-medier.html på ~446k tecken).
const MAX_CHARS = 500000;

// Väl tilltaget men ändligt. 15 min är plattformens tak; fastnar anropet vill
// vi ändå skriva ett läsbart fel i stället för att dö tyst vid taket.
const BUDGET_MS = Number(process.env.OPENROUTER_BG_TIMEOUT_MS) || 240000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Ogiltig JSON' }; }

  const { jobId = '', agentId = '', system = '', code = '', context = '' } = payload;

  if (!RENT_ID.test(agentId)) return { statusCode: 400, body: 'Ogiltigt agentId' };
  if (!RENT_ID.test(jobId))   return { statusCode: 400, body: 'Ogiltigt jobId' };
  if (!code.trim())           return { statusCode: 400, body: 'Ingen kod att granska' };

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

  const codeClipped = code.length > MAX_CHARS
    ? code.slice(0, MAX_CHARS) + '\n…(avkortat)'
    : code;

  const userPrompt =
    `${context ? `Kontext: ${context}\n\n` : ''}` +
    `Granska följande kod/innehåll. Var konkret och prioritera de viktigaste punkterna.\n\n` +
    '```\n' + codeClipped + '\n```';

  let resultat;
  try {
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

  return { statusCode: 200, body: resultat.status };
};
