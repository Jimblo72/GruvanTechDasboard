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

const CATEGORIES = ['offert_andelsratt', 'offert_forsaljning', 'support', 'abonnemang', 'brus'];

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

// Läser den inlärda stilprofilen (data/mail-style.json). Faller tillbaka på
// baslinjeprofilen om filen saknas eller är ogiltig. EN liten GitHub-läsning —
// ingen hämtning av skickade mejl sker här (det gör bara mail-learn-style).
async function loadStyleProfile() {
  try {
    const { data } = await readJsonFile(STYLE_FILE_PATH, null);
    if (data && data.style_guide) return data;
  } catch (_) { /* ignorera — faller tillbaka på baslinjen */ }
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

- offert_andelsratt: kunden vill sälja en andel/andelsrätt (fast pris 37 500 / 40 000 kr-fallet).
- offert_forsaljning: vanlig fastighetsförsäljning — värdering eller offertförfrågan för en bostad/fastighet.
- support: fråga om ett pågående ärende eller allmän support.
- abonnemang: en Mäklargruvan-kund vill lägga till eller säga upp ett abonnemangstillägg. FLAGGA endast — vidta ingen åtgärd.
- brus: nyhetsbrev, spam, notifieringar eller annat som inte kräver svar.

Regler:
- Svara på svenska.
- confidence är 0–1 (hur säker du är).
- reason: kort motivering (1–2 meningar).
- suggested_action: kort förslag på nästa steg för Jimmy.
- Hitta inte på — om osäkert, välj den rimligaste kategorin och sänk confidence.`;

function classifyUserText(message) {
  return (
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `Innehåll:\n${(message.text || '').slice(0, 8000)}`
  );
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
        system: CLASSIFY_SYSTEM,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'report_classification' },
        messages: [{ role: 'user', content: classifyUserText(message) }],
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
          systemInstruction: { parts: [{ text: CLASSIFY_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: classifyUserText(message) }] }],
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
    return 'Detta gäller andelsförsäljning (avsändaren vill sälja — det är en förfrågan). Nämn kort att PeakFast har ett fast arvode på 37 500 kr (alt. 40 000 kr) inkl. moms för andelsförsäljning, och erbjud dig att skicka en fullständig offert.';
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
  return '';
}

// Bygger systemprompten för utkastet. Injicerar Jimmys inlärda (eller baslinje-)
// röstprofil så att texten låter som HAN: kort, varm, "Hej [Förnamn]" utan komma,
// rakt på sak, avsluta med fråga/nästa steg, inga dekorativa punktlistor, och
// UTAN att upprepa hela signaturen (Outlook lägger till den).
function draftSystemFor(category, styleProfile) {
  const hint = draftCategoryHint(category);
  const guide = (styleProfile && styleProfile.style_guide) || DEFAULT_STYLE_PROFILE.style_guide;
  const examples = ((styleProfile && styleProfile.examples) || DEFAULT_STYLE_PROFILE.examples)
    .slice(0, 3)
    .map((e, i) => `${i + 1}. ${e}`)
    .join('\n');

  return (
    'Du skriver ett svarsutkast åt fastighetsmäklaren Jimmy Blomgren (PeakFast), i första person ("jag"), på svenska.\n\n' +
    'SKRIV I JIMMYS RÖST enligt denna stilguide:\n' + guide + '\n\n' +
    (examples ? 'Exempel på hur Jimmy faktiskt skriver (härma tonen, kopiera inte ordagrant):\n' + examples + '\n\n' : '') +
    'INNEHÅLL — VAR ÅTERHÅLLSAM (allra viktigast):\n' +
    '- Standardsvaret är en KORT, artig bekräftelse: att du mottagit mejlet och att de är välkomna att höra av sig vid frågor. Oftast räcker 1–3 meningar.\n' +
    '- Avgör först: ställer avsändaren en KONKRET fråga eller ber uttryckligen om något? Om NEJ (de skickar in ett dokument, bekräftar, tackar, återkopplar) → skriv BARA bekräftelsen ovan. Lägg INTE till instruktioner, nästa steg, checklistor eller sammanfattningar som de inte bett om.\n' +
    '- Om JA → svara kort och konkret på just det de frågar om, inget mer.\n' +
    '- Upprepa ALDRIG instruktioner eller nästa steg som redan står i mejltråden (det som citeras längre ner är oftast sådant Jimmy själv redan skrivit — ta inte om det).\n' +
    '- Skriv INTE återberättande meningar om vad avsändaren gjort (t.ex. "Jag ser att du skickade..." eller "Jag ser att du mailade vidare från..."). Det är onödigt och får mejlet att kännas som en mall.\n' +
    '- Hitta inte på fakta, åtgärder eller detaljer du inte har stöd för i mejlet.\n\n' +
    'STIL/FORM:\n' +
    '- Var kort och personlig. Hellre få korta meningar än en lång utläggning.\n' +
    '- Hälsning "Hej [Förnamn]" utan kommatecken, sedan blankrad och rakt på sak. Använd mottagarens förnamn om det framgår.\n' +
    '- Avsluta med en öppen inbjudan att höra av sig, eller (om något faktiskt efterfrågats) ett tydligt nästa steg.\n' +
    '- INGA fetstilta rubriker och INGA numrerade/punktade listor som dekoration — rena stycken. (Använd bara en lista om avsändaren uttryckligen bett om konkreta steg.)\n' +
    '- Undvik stela företagsöppningar som "Tack för att jag får möjligheten…".\n' +
    (hint ? '\nOm ärendetypen: ' + hint + '\n' : '') +
    '\nAvsluta med denna sign-off (och INGET mer — upprepa INTE titel, telefon eller adress, Outlook lägger till full signatur automatiskt):\n' +
    SIGN_OFF +
    '\n\nSkriv ENDAST själva mejltexten (hälsning, brödtext, sign-off) — ingen ämnesrad, inga meta-kommentarer.'
  );
}

async function generateDraft(message, category, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');

  // Läs den precomputerade stilprofilen (en liten GitHub-läsning). Ingen
  // hämtning av skickade mejl sker här — det håller triage under 10 s-gränsen.
  const styleProfile = opts.styleProfile || (await loadStyleProfile());

  const userPrompt =
    `Inkommande mejl att besvara:\n\n` +
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `${(message.text || '').slice(0, 6000)}`;

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
        system: draftSystemFor(category, styleProfile),
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
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
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
async function createOutlookDraft(messageId, draftText) {
  const mailbox = MAILBOX();
  // 1) createReply → returnerar ett utkast (draft) inkl. citerat original i body.
  const draft = await graphJson(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/createReply`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
  );
  if (!draft || !draft.id) throw new Error('createReply gav inget utkast-ID.');

  const bodyHtml = escapeHtml(draftText).replace(/\n/g, '<br>');
  const original = draft.body?.content || '';
  const combined = `<div>${bodyHtml}</div><br><hr>${original}`;

  // 2) PATCH utkastets body med vår text (behåller citerat original under).
  await graphJson(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(draft.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { contentType: 'HTML', content: combined } }),
    }
  );

  return { draftId: draft.id, draftWebLink: draft.webLink || '' };
}

// Hämtar fullt meddelande (för LLM-kontext) och normaliserar body → text.
async function fetchFullMessage(messageId) {
  const mailbox = MAILBOX();
  const select = 'subject,body,bodyPreview,from,toRecipients,receivedDateTime,conversationId';
  const m = await graphJson(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=${select}`
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
  const message = opts.message || (await fetchFullMessage(messageId));
  const classification = await classify(message, { retryDelays });
  const category = classification.category;
  const needsReply = category !== 'brus';
  const needsManualConfirm = category === 'abonnemang';

  const result = {
    messageId,
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
    timestamp: new Date().toISOString(),
  };

  if (!needsReply) return result; // brus → inget utkast

  // Generera alltid utkasttexten (billigt nog och nyttigt i kön), men skapa
  // bara i Outlook om autodraft är på.
  const draftText = await generateDraft(message, category, { retryDelays });
  result.draftText = draftText;

  if (opts.autodraft) {
    const created = await createOutlookDraft(messageId, draftText);
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
