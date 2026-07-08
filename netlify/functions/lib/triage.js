// netlify/functions/lib/triage.js
// Delad triage-logik: klassificera ett inkorgsmeddelande (Claude Haiku, med
// Gemini som opt-in-fallback) och generera ett svarsutkast i Jimmys röst
// (Claude Haiku), samt skapa utkastet i Outlook-tråden via Microsoft Graph
// (createReply + PATCH). Skickar ALDRIG.
//
// Används av både mail-triage.js (på klick från dashboarden) och mail-poll.js
// (schemalagd poller). CommonJS, zero-dependency.
//
// Modellval:
//   * Klassificering → Claude Haiku via tool-use (forcerat function calling ger
//     garanterat giltig strukturerad JSON). Provider konfigurerbar via
//     MAIL_CLASSIFY_PROVIDER (default 'anthropic'; 'gemini' återanvänder den
//     gamla, billigare Gemini-vägen). Modell via MAIL_CLASSIFY_MODEL.
//     Bakgrund: Gemini classify gav upprepade HTTP 503 ("high demand") i
//     livetester, och under Netlifys hårda 10 s-gräns åt retryerna upp tiden
//     så hela kedjan timeoutade (502 med HTML-body). Anthropic har aldrig varit
//     det felande steget → vi flyttar båda LLM-stegen till en snabb, pålitlig
//     provider.
//   * Utkastgenerering → Claude Haiku (snabb; ett kort svarsmejl kräver inte
//     Opus). Modell via MAIL_DRAFT_MODEL, default claude-haiku-4-5-20251001.

const { graphJson } = require('./graph');
const { readJsonFile } = require('./store');
const { loadAndelMall, buildAndelOffertText, insertOffertBlock, OFFERT_TOKEN } = require('./offert-text');
const {
  fetchThread,
  fetchOtherThreadsFromSender,
  buildOtherThreadsSummary,
  buildThreadContextBlock,
} = require('./thread');
const { getMailbox, defaultMailbox } = require('./mailboxes');

const MAILBOX = () => process.env.MAILBOX_USER || 'jimmy@peakfast.se';

// Fil där den inlärda mejlstilen (från Jimmys skickade mejl) sparas.
// Skrivs av mail-learn-style.js (on-demand), läses här vid utkastgenerering.
const STYLE_FILE_PATH = 'data/mail-style.json';

// Default-modeller. Haiku 4.5 är snabb nog för både klassificering och korta
// svarsmejl och håller oss väl under funktionens timeout.
const DEFAULT_DRAFT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';

// ── Retry/backoff för transienta LLM-överbelastningar ─────────
// Kör fn(); vid HTTP 429/503/529 (identifierat via err.status eller texten i
// felmeddelandet) väntas kort innan nytt försök. Övriga fel kastas direkt.
// `delays` är en array med backoff-tider i ms; antalet omförsök = delays.length.
// Anroparen väljer budget så den synkrona on-click-vägen kan hållas snäv
// (~0,4 s) medan den schemalagda pollern (lång timeout) kan retrya mer.
//
//   * Synkron väg (mail-triage.js, 10 s-gräns): 1 omförsök, 400 ms.
//   * Poller (mail-poll.js, lång timeout): 2 omförsök, 500 ms + 1200 ms.
const SYNC_RETRY_DELAYS = [400];       // 1 omförsök, ~0,4 s extra
const POLL_RETRY_DELAYS = [500, 1200]; // 2 omförsök, ~1,7 s extra

// Anthropic returnerar 529 (overloaded), Gemini/Google 503 vid överbelastning.
function isTransientError(e) {
  const s = e && e.status;
  if (s === 429 || s === 503 || s === 529) return true;
  const msg = String((e && e.message) || '');
  return /HTTP\s+(429|503|529)\b/.test(msg);
}

async function withRetry(fn, delays = SYNC_RETRY_DELAYS) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length && isTransientError(e)) {
        await new Promise(res => setTimeout(res, delays[attempt]));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const CATEGORIES = ['offert_andelsratt', 'offert_forsaljning', 'support', 'abonnemang', 'privat', 'kalender', 'brus'];

// Kalender-/mötesmeddelanden (mötesinbjudan, -svar, -avbokning) ska ALDRIG
// besvaras med ett mejlutkast — de hanteras i kalendern. Vi upptäcker dem
// DETERMINISTISKT via Graphs meddelandetyp (inte via LLM, som kan missförstå ett
// kalendermeddelande som ett vanligt mejl). Graph returnerar @odata.type för
// härledda typer (eventMessage / eventMessageRequest / eventMessageResponse) även
// när man $select:ar, och eventMessages har meetingMessageType != 'none'.
function isCalendarMessage(m) {
  const t = String((m && (m.odataType || m['@odata.type'])) || '').toLowerCase();
  if (t.includes('eventmessage') || t.includes('calendarsharing')) return true;
  const mt = m && m.meetingMessageType;
  if (mt && String(mt).toLowerCase() !== 'none') return true;
  return false;
}

// ── Signatur / röstprofil ─────────────────────────────────────
// VIKTIGT: Outlook lägger själv till Jimmys fullständiga signatur (titel,
// telefon, adress) när utkastet öppnas för svar. Utkasttexten ska därför INTE
// upprepa hela signaturblocket — då blir det dubbel signatur. Vi avslutar
// utkastet med sign-off + namn på sin höjd.
const SIGN_OFF = 'Med vänlig hälsning\nJimmy';

// Baslinje-röstprofil. Används om data/mail-style.json ännu inte har genererats
// (dvs. innan Jimmy kört "Lär in min mejlstil"). Bygger på tidigare observation
// av hans faktiska ton; den inlärda profilen förfinar/bekräftar den sedan.
const DEFAULT_STYLE_PROFILE = {
  style_guide:
    'Jimmy skriver vardagligt, varmt och vänligt — som ett mejl till en bekant, inte ett företagsbrev. ' +
    'Hälsning: "Hej [Förnamn]" (utan kommatecken), sedan blankrad och rakt på sak. ' +
    'Han förklarar gärna kort VARFÖR när det behövs, ofta i långa flytande meningar med "så", "dvs" och "bl.a." invävt. ' +
    'Han avslutar oftast med en fråga eller ett tydligt nästa steg, t.ex. "Hör av dig om du undrar något!". ' +
    'Ingen fet stil, inga rubriker, inga punktlistor som dekoration — rena stycken. Undvik stela företagsöppningar som ' +
    '"Tack för att jag får möjligheten…". Håll det kort och personligt.',
  examples: [
    'Tack Catrin! Hör av er om det är några frågor eller någonting mer jag kan hjälpa er med.',
    'Hej Anna\n\nVad roligt att du hörde av dig! Jag återkommer så snart jag kollat upp det här.',
    'Absolut, det fixar vi. Jag hör av mig igen så fort jag vet mer så du inte behöver undra.',
  ],
  generated_at: null,
  sample_count: 0,
  is_default: true,
};

// Strippar HTML → ren text. Delas av fetchFullMessage (inkorg) och
// mail-learn-style (skickade mejl). Tar bort style/script, taggar och entiteter.
function htmlToText(raw, contentType) {
  const s = String(raw || '');
  const isHtml = contentType === 'html' || /<[a-z][\s\S]*>/i.test(s);
  if (!isHtml) return s.replace(/\r\n/g, '\n').trim();
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Läser den inlärda stilprofilen. `styleFile` är brevlådans egen profil-fil
// (multi-mailbox); utelämnad → dagens data/mail-style.json (bakåtkompatibelt,
// EN liten GitHub-läsning). Ordning: given fil → legacy data/mail-style.json →
// baslinjeprofilen. Den andra läsningen sker BARA om en per-brevlåde-fil angetts
// och saknas/är tom, så legacy-vägen aldrig får extra latens.
async function loadStyleProfile(styleFile) {
  const path = styleFile || STYLE_FILE_PATH;
  try {
    const { data } = await readJsonFile(path, null);
    if (data && data.style_guide) return data;
  } catch (_) { /* ignorera — faller tillbaka nedan */ }
  if (path !== STYLE_FILE_PATH) {
    try {
      const { data } = await readJsonFile(STYLE_FILE_PATH, null);
      if (data && data.style_guide) return data;
    } catch (_) { /* ignorera — faller tillbaka på baslinjen */ }
  }
  return DEFAULT_STYLE_PROFILE;
}

// ── Klassificering: schema + systemprompt ─────────────────────
// Delas mellan Anthropic-tool-use (input_schema) och Gemini (responseSchema).
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    reason: { type: 'string' },
    confidence: { type: 'number' },
    suggested_action: { type: 'string' },
  },
  required: ['category', 'reason', 'confidence', 'suggested_action'],
};

const CLASSIFY_SYSTEM = `Du är en assistent åt fastighetsmäklaren Jimmy Blomgren (PeakFast). Klassificera ETT inkommande mejl i exakt EN kategori:

- offert_andelsratt: EN KUND vill sälja sin andel/andelsrätt och Jimmy ska förmedla den (fast pris 37 500 / 40 000 kr-fallet).
- offert_forsaljning: Jimmy ombeds agera MÄKLARE åt en KUND — värdera eller sälja KUNDENS bostad/fastighet. Gäller BARA när Jimmy är den säljande mäklaren åt någon annan.
- support: fråga om ett pågående ärende eller allmän support.
- abonnemang: en Mäklargruvan-kund vill lägga till eller säga upp ett abonnemangstillägg. FLAGGA endast — vidta ingen åtgärd.
- privat: personlig/privat korrespondens där Jimmy INTE agerar säljande mäklare — t.ex. Jimmys egna ärenden, familj, privata inköp (som eget husbygge), eller när en leverantör/säljare kontaktar JIMMY SJÄLV som kund/köpare. Svara naturligt och personligt.
- brus: nyhetsbrev, spam, notifieringar eller annat som inte kräver svar.

AVGÖRANDE FRÅGA för offert_forsaljning vs privat: agerar Jimmy MÄKLARE åt en kund i detta mejl (dvs. hjälper någon ANNAN att sälja sin bostad)? Om JA → offert_forsaljning. Om NEJ — Jimmy är själv köpare/privatperson, eller någon säljer/pitchar TILL Jimmy → privat. Ett husföretag/leverantör som mejlar Jimmy om HANS EGET husbygge är alltså privat, INTE offert_forsaljning, även om det handlar om fastighet/hus.

Regler:
- Svara på svenska.
- confidence är 0–1 (hur säker du är).
- reason: kort motivering (1–2 meningar).
- suggested_action: kort förslag på nästa steg för Jimmy.
- Använd HELA TRÅDEN (om den finns med) för att avgöra vem som är köpare/säljare.
- Hitta inte på — om osäkert, välj den rimligaste kategorin och sänk confidence.`;

// Injicerar brevlådans roll-hint (multi-mailbox) i klassificeringssystemet så
// klassningen passar just den inkorgens verksamhet (t.ex. info@maklargruvan.se =
// supportinkorg för SaaS-tjänsten → abonnemang/support mer sannolikt). Tom
// roleHint → EXAKT dagens prompt (bakåtkompatibelt).
function classifySystemFor(roleHint) {
  const rh = String(roleHint || '').trim();
  if (!rh) return CLASSIFY_SYSTEM;
  return CLASSIFY_SYSTEM + `\n\nDenna brevlåda: ${rh}`;
}

function classifyUserText(message, context) {
  const base =
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `Innehåll (senaste meddelandet):\n${(message.text || '').slice(0, 8000)}`;
  const ctx = String(context || '').trim();
  // Hela tråden + ev. andra trådar från samma avsändare hjälper klassificeringen
  // (t.ex. känna igen 'privat' från sammanhanget, inte bara det sista mejlet).
  return ctx ? `${base}\n\n${ctx}` : base;
}

function normalizeClassification(parsed) {
  const out = parsed && typeof parsed === 'object' ? parsed : {};
  if (!CATEGORIES.includes(out.category)) out.category = 'support';
  out.confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
  out.reason = String(out.reason || '');
  out.suggested_action = String(out.suggested_action || '');
  return out;
}

// ── Anthropic Claude Haiku: klassificering via tool-use ───────
// Vi tvingar modellen att anropa ETT verktyg (report_classification) vars
// input_schema matchar CLASSIFY_SCHEMA. tool_choice låser anropet, så svaret
// är garanterat giltig strukturerad JSON — inga ```json-staket att skala bort.
const CLASSIFY_TOOL = {
  name: 'report_classification',
  description: 'Rapportera klassificeringen av mejlet enligt schemat.',
  input_schema: CLASSIFY_SCHEMA,
};

async function classifyAnthropic(message, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');
  const model = process.env.MAIL_CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL;
  const delays = opts.retryDelays || SYNC_RETRY_DELAYS;

  const data = await withRetry(async () => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: classifySystemFor(opts.roleHint),
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'report_classification' },
        messages: [{ role: 'user', content: classifyUserText(message, opts.context) }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      const err = new Error(`Anthropic HTTP ${r.status}: ${errText.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }, delays);

  const toolUse = (data.content || []).find(
    b => b.type === 'tool_use' && b.name === 'report_classification'
  );
  if (!toolUse || !toolUse.input) {
    throw new Error('Anthropic gav inget tool_use-svar vid klassificering.');
  }
  return normalizeClassification(toolUse.input);
}

// ── Gemini: klassificering (opt-in fallback) ──────────────────
// Behålls bakom MAIL_CLASSIFY_PROVIDER=gemini. Gemini har responseSchema för
// strukturerad JSON men gav 503 vid överbelastning i livetester → ej default.
async function classifyGemini(message, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY saknas i Netlify environment variables');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const delays = opts.retryDelays || SYNC_RETRY_DELAYS;

  // Nätverksanropet retry:as vid transient 429/503; JSON-parsning sker efteråt
  // (parse-fel ska inte trigga omförsök).
  const data = await withRetry(async () => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: classifySystemFor(opts.roleHint) }] },
          contents: [{ role: 'user', parts: [{ text: classifyUserText(message, opts.context) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: CLASSIFY_SCHEMA,
            temperature: 0.2,
          },
        }),
      }
    );
    if (!r.ok) {
      const errText = await r.text();
      const err = new Error(`Gemini HTTP ${r.status}: ${errText.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }, delays);
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Tomt svar från Gemini vid klassificering.');
  return normalizeClassification(JSON.parse(text));
}

// Router: väljer klassificerings-provider. Default 'anthropic' (snabb+pålitlig);
// sätt MAIL_CLASSIFY_PROVIDER=gemini för den gamla billiga vägen.
async function classify(message, opts = {}) {
  const provider = (process.env.MAIL_CLASSIFY_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'gemini') return classifyGemini(message, opts);
  return classifyAnthropic(message, opts);
}

// ── Claude: utkastgenerering ──────────────────────────────────
function draftCategoryHint(category) {
  if (category === 'offert_andelsratt') {
    // Avsändaren har uttryckligen frågat om pris/villkor — därför är det RÄTT
    // att inkludera offerten här (ingen konflikt med återhållsamhetsregeln).
    // Själva offertblocket (priser + vad som ingår) är deterministiskt och
    // byggs från data/offert-mall-andel.json — LLM:en skriver det ALDRIG själv.
    return (
      'Detta gäller andelsförsäljning (avsändaren vill sälja sin andel och frågar om pris/villkor — offerten ska med i svaret). ' +
      'Strukturera utkastet så här: (1) en kort personlig inledning som bekräftar förfrågan, ' +
      `(2) därefter EXAKT tokenen ${OFFERT_TOKEN} helt ensam på en egen rad — den ersätts automatiskt med vårt färdiga offertblock, ` +
      '(3) sedan en kort avslutning där du erbjuder dig att svara på frågor eller boka ett samtal. ' +
      'VIKTIGT: skriv INTE några priser, belopp eller uppräkningar av vad som ingår — offertblocket innehåller redan allt det. Nämn inga siffror alls.'
    );
  }
  if (category === 'offert_forsaljning') {
    return 'Detta gäller en vanlig försäljning/värdering (avsändaren efterfrågar hjälp). Tacka kort för förfrågan, erbjud en kostnadsfri värdering och föreslå att boka en tid.';
  }
  if (category === 'support') {
    return 'Behandla detta enligt återhållsamhetsregeln: svara konkret BARA på det avsändaren uttryckligen frågar om. Om inget frågas (t.ex. de skickar in ett dokument eller bekräftar något) → skriv bara en kort bekräftelse på att du mottagit mejlet + att de är välkomna att höra av sig.';
  }
  if (category === 'abonnemang') {
    return 'Detta gäller ett abonnemangstillägg (Mäklargruvan). Bekräfta kort att du tagit emot önskemålet och att det hanteras. Lova INTE att ändringen redan är gjord — Jimmy måste bekräfta den manuellt.';
  }
  if (category === 'privat') {
    return 'Detta är privat korrespondens där Jimmy inte agerar mäklare. Skriv ledigt och personligt som till en bekant — gärna med en emoji (🙂/;)) och en liten lättsam personlig kommentar när det känns naturligt. Håll det kort. Inga mäklar-erbjudanden, ingen värdering, inga priser. Besvara det som faktiskt frågas, men upprepa inte sådant du redan berättat tidigare i tråden.';
  }
  return '';
}

// Bygger systemprompten för utkastet. Injicerar Jimmys inlärda (eller baslinje-)
// röstprofil så att texten låter som HAN: kort, varm, "Hej [Förnamn]" utan komma,
// rakt på sak, avsluta med fråga/nästa steg, inga dekorativa punktlistor, och
// UTAN att upprepa hela signaturen (Outlook lägger till den).
function draftSystemFor(category, styleProfile, mbOpts = {}) {
  const hint = draftCategoryHint(category);
  const guide = (styleProfile && styleProfile.style_guide) || DEFAULT_STYLE_PROFILE.style_guide;
  const examples = ((styleProfile && styleProfile.examples) || DEFAULT_STYLE_PROFILE.examples)
    .slice(0, 3)
    .map((e, i) => `${i + 1}. ${e}`)
    .join('\n');

  // Multi-mailbox: brevlådans egen signatur (default = dagens SIGN_OFF) och en
  // valfri roll-hint som sätter affärskontexten för denna inkorg. Tom roleHint +
  // utelämnad signatur → EXAKT dagens prompt (bakåtkompatibelt).
  const signature = (mbOpts.signature && String(mbOpts.signature).trim()) ? mbOpts.signature : SIGN_OFF;
  const roleHint = String(mbOpts.roleHint || '').trim();

  return (
    (roleHint ? 'OM DENNA BREVLÅDA: ' + roleHint + '\n\n' : '') +
    'Du skriver ett svarsutkast åt fastighetsmäklaren Jimmy Blomgren (PeakFast), i första person ("jag"), på svenska.\n\n' +
    'SKRIV I JIMMYS RÖST enligt denna stilguide:\n' + guide + '\n\n' +
    (examples ? 'Exempel på hur Jimmy faktiskt skriver (härma tonen, kopiera inte ordagrant):\n' + examples + '\n\n' : '') +
    'INNEHÅLL — VAR ÅTERHÅLLSAM (allra viktigast):\n' +
    '- Standardsvaret är en KORT, artig bekräftelse: att du mottagit mejlet och att de är välkomna att höra av sig vid frågor. Oftast räcker 1–2 meningar.\n' +
    '- Avgör först: ställer avsändaren en KONKRET fråga eller ber uttryckligen om något? Om NEJ (de skickar in ett dokument, bekräftar, tackar, återkopplar) → skriv BARA bekräftelsen ovan. Lägg INTE till instruktioner, nästa steg, checklistor eller sammanfattningar som de inte bett om.\n' +
    '- Om JA → svara kort och konkret på just det de frågar om, inget mer.\n' +
    '- VIKTIGT: även om det finns KVARSTÅENDE STEG i ärendet (t.ex. att något ska skickas vidare, registreras eller arkiveras) — nämn dem INTE om avsändaren inte uttryckligen frågar efter dem. Räkna INTE upp vad som händer härnäst självmant. Bekräfta bara mottagandet.\n' +
    '- Upprepa ALDRIG instruktioner eller nästa steg som redan står i mejltråden (det som citeras längre ner är oftast sådant Jimmy själv redan skrivit — ta inte om det).\n' +
    '- Använd HELA TRÅDEN för att FÖRSTÅ sammanhanget — men ÅTERBERÄTTA inte information du (Jimmy) redan delat med mottagaren tidigare i tråden. Har du t.ex. redan nämnt en resa, ett datum eller ett besked → ta INTE om det. Trådkontexten är för din förståelse, inte för att upprepas tillbaka till den som redan vet.\n' +
    '- Skriv INTE återberättande meningar om vad avsändaren gjort (t.ex. "Jag ser att du skickade..." eller "Jag ser att du mailade vidare från..."). Det är onödigt och får mejlet att kännas som en mall.\n' +
    '- Hitta inte på fakta, åtgärder eller detaljer du inte har stöd för i mejlet.\n\n' +
    'KONKRETA FRÅGOR MÅSTE ALLTID BESVARAS (går före återhållsamheten ovan):\n' +
    '- Om avsändaren ställer en eller flera KONKRETA frågor (tid, plats, pris, ja/nej, datum, adress m.m.) MÅSTE du besvara ALLA i utkastet. Att bara skriva en artig bekräftelse när en konkret fråga ställts är FEL.\n' +
    '- Återhållsamheten gäller OMBEDDA nästa steg och tillägg — den får ALDRIG få dig att hoppa över en fråga som avsändaren faktiskt ställt.\n' +
    '- Använd HELA TRÅDEN (om den finns med nedan) för att lösa referenser i frågan — t.ex. VILKEN fredag, VILKEN adress eller tid som åsyftas — så svaret blir konkret.\n' +
    '- Litet exempel: avsändaren skriver "Funkar kl 10, och är det vid Häste 217 vi ses?" → utkastet MÅSTE bekräfta BÅDE tiden (kl 10) OCH platsen (Häste 217), t.ex. "Ja, kl 10 vid Häste 217 fungerar fint."\n\n' +
    'EXEMPEL på rätt återhållsamhet (gäller när INGEN konkret fråga ställts):\n' +
    'Inkommande: kunden skickar in ett signerat dokument utan att fråga något (och nästa steg har redan getts tidigare i tråden).\n' +
    'RÄTT svar (bekräfta bara):\n' +
    '"Hej Catrin\n\nTack, jag har mottagit det signerade gåvobrevet! Hör gärna av er om det är något mer jag kan hjälpa till med.\n\nMed vänlig hälsning\nJimmy"\n' +
    'FEL svar (räknar upp oombedda nästa steg): att lägga till "Nästa steg är att ni mailar en kopia till Holiday Club ... och skickar en kopia till mig ...". Gör INTE så när inget efterfrågats.\n\n' +
    'TON/REGISTER — låt det låta som Jimmy privat, inte som en mall:\n' +
    '- Till folk Jimmy har en relation med (privat korrespondens, bekanta, pågående personlig dialog) skriver han LEDIGT och lekfullt. Det är helt okej — och önskvärt — med en och annan emoji (🙂, ;)) och en liten personlig eller lättsam kommentar när det passar naturligt (t.ex. en vardagsdetalj). Exempel på Jimmys lediga ton: "Toppen 🙂 kl. 10.00 på fredag blir perfekt och adressen stämmer, möjligt att jag har en 4-åring som byggkonsult med mig ;)".\n' +
    '- Håll däremot en sober, professionell ton (INGA emojis) i formella eller juridiska ärenden — myndigheter, avtal, domstol, fakturor och liknande.\n' +
    '- Tvinga aldrig in emoji/skämt där det inte passar; det ska kännas naturligt, inte påklistrat.\n\n' +
    'STIL/FORM:\n' +
    '- Var kort och personlig. Hellre få korta meningar än en lång utläggning.\n' +
    '- Hälsning "Hej [Förnamn]" utan kommatecken, sedan blankrad och rakt på sak. Använd mottagarens förnamn om det framgår. (I lediga/personliga svar går det också bra att öppna direkt med t.ex. "Toppen 🙂" utan formell hälsning om det känns naturligt.)\n' +
    '- Avsluta med en öppen inbjudan att höra av sig, eller (om något faktiskt efterfrågats) ett tydligt nästa steg.\n' +
    '- INGA fetstilta rubriker och INGA numrerade/punktade listor som dekoration — rena stycken. (Använd bara en lista om avsändaren uttryckligen bett om konkreta steg.)\n' +
    '- Undvik stela företagsöppningar som "Tack för att jag får möjligheten…".\n' +
    (hint ? '\nOm ärendetypen: ' + hint + '\n' : '') +
    '\nAvsluta med denna sign-off (och INGET mer — upprepa INTE titel, telefon eller adress, Outlook lägger till full signatur automatiskt):\n' +
    signature +
    '\n\nSkriv ENDAST själva mejltexten (hälsning, brödtext, sign-off) — ingen ämnesrad, inga meta-kommentarer.'
  );
}

async function generateDraft(message, category, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');

  // Läs den precomputerade stilprofilen (en liten GitHub-läsning). Ingen
  // hämtning av skickade mejl sker här — det håller triage under 10 s-gränsen.
  // För andelsoffert läses även offertmallen — parallellt (Promise.all) så de
  // två GitHub-läsningarna inte adderar latens ovanpå varandra.
  const isAndelOffert = category === 'offert_andelsratt';
  const [styleProfile, andelMall] = await Promise.all([
    opts.styleProfile ? Promise.resolve(opts.styleProfile) : loadStyleProfile(opts.styleFile),
    isAndelOffert ? loadAndelMall() : Promise.resolve(null),
  ]);

  const ctx = String(opts.context || '').trim();
  const userPrompt =
    `Inkommande mejl att besvara (senaste meddelandet):\n\n` +
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `${(message.text || '').slice(0, 6000)}` +
    // Hela tråden + ev. andra trådar från samma avsändare ger utkastet fullt
    // sammanhang så det kan lösa referenser och besvara konkreta frågor rätt.
    (ctx ? `\n\n${ctx}` : '');

  const model = process.env.MAIL_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;
  const delays = opts.retryDelays || SYNC_RETRY_DELAYS;

  // Nätverksanropet retry:as vid transient 429/503/529.
  const data = await withRetry(async () => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system: draftSystemFor(category, styleProfile, { signature: opts.signature, roleHint: opts.roleHint }),
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      const err = new Error(`Anthropic HTTP ${r.status}: ${errText.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }, delays);
  let text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  // Andelsoffert: byt [OFFERT]-tokenen mot det deterministiska offertblocket
  // (byggt från data/offert-mall-andel.json — priserna kommer ALDRIG från
  // LLM:en). Saknar utkastet tokenen läggs blocket in före sign-offen så
  // offerten aldrig tappas — och aldrig dupliceras.
  if (isAndelOffert && text) {
    text = insertOffertBlock(text, buildAndelOffertText(andelMall));
  }

  return text || '(tomt svar)';
}

// ── Outlook: skapa utkast i tråden ────────────────────────────
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Skapar ett svarsutkast (createReply) och lägger vår genererade text överst,
// med originalmeddelandets citerade innehåll kvar under. Returnerar draftId +
// webLink. Skickar aldrig.
async function createOutlookDraft(messageId, draftText, mailbox) {
  const mb = mailbox || MAILBOX();
  // 1) createReply → returnerar ett utkast (draft) inkl. citerat original i body.
  const draft = await graphJson(
    `/users/${encodeURIComponent(mb)}/messages/${encodeURIComponent(messageId)}/createReply`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
  );
  if (!draft || !draft.id) throw new Error('createReply gav inget utkast-ID.');

  const bodyHtml = escapeHtml(draftText).replace(/\n/g, '<br>');
  const original = draft.body?.content || '';
  const combined = `<div>${bodyHtml}</div><br><hr>${original}`;

  // 2) PATCH utkastets body med vår text (behåller citerat original under).
  await graphJson(
    `/users/${encodeURIComponent(mb)}/messages/${encodeURIComponent(draft.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { contentType: 'HTML', content: combined } }),
    }
  );

  return { draftId: draft.id, draftWebLink: draft.webLink || '' };
}

// Hämtar fullt meddelande (för LLM-kontext) och normaliserar body → text.
async function fetchFullMessage(messageId, mailbox) {
  const mb = mailbox || MAILBOX();
  const select = 'subject,body,bodyPreview,from,toRecipients,receivedDateTime,conversationId';
  const m = await graphJson(
    `/users/${encodeURIComponent(mb)}/messages/${encodeURIComponent(messageId)}?$select=${select}`
  );
  const raw = m.body?.content || m.bodyPreview || '';
  const text = htmlToText(raw, m.body?.contentType);
  return {
    id: messageId,
    subject: m.subject || '',
    fromName: m.from?.emailAddress?.name || '',
    fromAddress: m.from?.emailAddress?.address || '',
    received: m.receivedDateTime || '',
    conversationId: m.conversationId || '',
    // För kalender-detektering (isCalendarMessage). @odata.type kommer automatiskt
    // för härledda typer (mötesmeddelanden) även med $select.
    odataType: m['@odata.type'] || '',
    meetingMessageType: m.meetingMessageType || '',
    text,
  };
}

// Full orkestrering: klassificera → (om ej brus och autodraft) generera + skapa
// utkast. `opts.autodraft` styr om utkast faktiskt skapas i Outlook.
// `opts.message` kan skickas in för att slippa en extra Graph-hämtning (poller).
async function triageMessage(messageId, opts = {}) {
  // Retry-budget: den synkrona on-click-vägen (mail-triage.js) använder default
  // (snäv, ~0,4 s) så retryerna inte spränger 10 s-gränsen; pollern skickar in
  // POLL_RETRY_DELAYS via opts.retryDelays.
  const retryDelays = opts.retryDelays || SYNC_RETRY_DELAYS;
  const force = !!opts.force;

  // Multi-mailbox: vilken brevlåda triageras. Anroparen (funktionerna) skickar in
  // en validerad adress via opts.mailbox; utelämnad → dagens enda brevlåda
  // (defaultMailbox, env/fallback). Brevlådans konfig (signatur/roll-hint/
  // stilprofil) läses PARALLELLT med Graph-anropen så den inte staplar latens —
  // vi behöver bara själva adressen (mb) för Graph-vägen direkt.
  const mb = opts.mailbox || defaultMailbox().address;
  const mbConfigP = getMailbox(mb).catch(() => null);

  const message = opts.message || (await fetchFullMessage(messageId, mb));

  // KALENDER/MÖTESMEDDELANDE → inget mejlsvar. Kortslut FÖRE tråd-hämtning och
  // LLM: en mötesinbjudan/-svar/-avbokning besvaras i kalendern, inte med mejl,
  // och ska aldrig matas till klassificeraren (som kan missförstå den som ett
  // vanligt mejl). Deterministiskt via Graphs meddelandetyp.
  if (isCalendarMessage(message)) {
    return {
      messageId,
      subject: message.subject,
      fromName: message.fromName,
      fromAddress: message.fromAddress,
      conversationId: message.conversationId,
      category: 'kalender',
      reason: 'Kalender-/mötesmeddelande (inbjudan, svar eller avbokning) — besvaras i kalendern, inte med mejl.',
      confidence: 1,
      suggested_action: 'Svara ja/nej i kalendern om det behövs. Inget mejlutkast skapas.',
      needsManualConfirm: false,
      draftId: null,
      draftWebLink: null,
      draftText: null,
      autodraft: !!opts.autodraft,
      alreadyReplied: false,
      duplicateDraft: false,
      skipReason: 'mötesinbjudan/kalender — inget mejlsvar',
      timestamp: new Date().toISOString(),
      _debug: { calendar: true },
    };
  }

  // Latens: den synkrona on-click-vägen håller kontexten lätt (ingen tvärtråds-
  // sökning, mindre transkription) så vi ryms under Netlifys 10 s-gräns. Pollern
  // (opts.includeCrossThread=true) har lång timeout och tar full kontext.
  const includeCrossThread = !!opts.includeCrossThread;
  const threadCaps = includeCrossThread
    ? { maxMessages: 12, maxChars: 6000, mailbox: mb }
    : { maxMessages: 8, maxChars: 3000, mailbox: mb };

  // Hämta hela tråden (+ i pollern: andra trådar från samma avsändare) PARALLELLT
  // så de extra Graph-anropen inte staplar latens. Saknas conversationId →
  // degradera tyst (bara senaste meddelandet, precis som förr).
  let thread = { transcript: '', messages: [], latestNonDraft: null, latestIsFromJimmy: false, hasDraftReply: false, ok: false, threadCount: 0 };
  let otherThreads = [];
  if (message.conversationId) {
    try {
      const [t, others] = await Promise.all([
        fetchThread(message.conversationId, threadCaps),
        includeCrossThread
          ? fetchOtherThreadsFromSender(message.fromAddress, message.conversationId, mb)
          : Promise.resolve([]),
      ]);
      if (t) thread = t;
      otherThreads = others || [];
    } catch (_) { /* degradera tyst */ }
  }
  const contextBlock = buildThreadContextBlock(thread.transcript, buildOtherThreadsSummary(otherThreads));

  // Brevlådans konfig (redan startad ovan, parallellt med Graph). Faller tillbaka
  // på defaultMailbox() om adressen inte var konfigurerad (säkerhet).
  const mbConfig = (await mbConfigP) || defaultMailbox();

  // Klassificera MED trådkontext (hjälper t.ex. att känna igen 'privat') + brevlådans roll-hint.
  const classification = await classify(message, { retryDelays, context: contextBlock, roleHint: mbConfig.roleHint });
  const category = classification.category;
  const needsReply = category !== 'brus';
  const needsManualConfirm = category === 'abonnemang';

  const result = {
    messageId,
    mailbox: mb,
    subject: message.subject,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    conversationId: message.conversationId,
    category,
    reason: classification.reason,
    confidence: classification.confidence,
    suggested_action: classification.suggested_action,
    needsManualConfirm,
    draftId: null,
    draftWebLink: null,
    draftText: null,
    autodraft: !!opts.autodraft,
    alreadyReplied: false,
    duplicateDraft: false,
    skipReason: null,
    timestamp: new Date().toISOString(),
    // TILLFÄLLIG diagnostik (tas bort när tråd/guard är verifierade live).
    _debug: {
      threadFetchOk: !!thread.ok,
      threadCount: thread.threadCount || 0,
      hasDraftReply: !!thread.hasDraftReply,
      latestFromJimmy: !!thread.latestIsFromJimmy,
      otherThreadCount: otherThreads.length,
      includeCrossThread,
    },
  };

  if (!needsReply) return result; // brus → inget utkast

  // Guard 1 — REDAN BESVARAT: om Jimmy redan skickat ett svar efter kundens
  // senaste meddelande (senaste icke-utkast i tråden är från Jimmy) → skapa
  // inget utkast. Returnera ändå klassificeringen så kön kan visa den flaggad.
  // Ingen utkasttext genereras (onödigt LLM-anrop). opts.force kringgår guarden.
  if (!force && thread.latestIsFromJimmy) {
    result.alreadyReplied = true;
    result.skipReason = 'redan besvarat';
    return result;
  }

  // Generera utkasttexten MED trådkontext (billigt nog och nyttigt i kön) och
  // brevlådans signatur/roll-hint/stilprofil, men skapa bara i Outlook om
  // autodraft är på OCH ingen guard slår till.
  const draftText = await generateDraft(message, category, {
    retryDelays,
    context: contextBlock,
    styleFile: mbConfig.styleFile,
    signature: mbConfig.signature,
    roleHint: mbConfig.roleHint,
  });
  result.draftText = draftText;

  // Guard 2 — DUBBLETT-UTKAST: om det redan finns ett osänt svarsutkast i tråden
  // → skapa inte ännu ett. Visa den genererade texten i kön men hoppa över
  // createOutlookDraft. opts.force kringgår guarden.
  if (!force && thread.hasDraftReply) {
    result.duplicateDraft = true;
    result.skipReason = 'utkast finns redan';
    return result;
  }

  if (opts.autodraft) {
    const created = await createOutlookDraft(messageId, draftText, mb);
    result.draftId = created.draftId;
    result.draftWebLink = created.draftWebLink;
  }

  return result;
}

module.exports = {
  CATEGORIES,
  SYNC_RETRY_DELAYS,
  POLL_RETRY_DELAYS,
  STYLE_FILE_PATH,
  DEFAULT_STYLE_PROFILE,
  htmlToText,
  loadStyleProfile,
  classify,
  classifyAnthropic,
  classifyGemini,
  generateDraft,
  createOutlookDraft,
  fetchFullMessage,
  triageMessage,
};
