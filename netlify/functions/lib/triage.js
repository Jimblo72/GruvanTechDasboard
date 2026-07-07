// netlify/functions/lib/triage.js
// Delad triage-logik: klassificera ett inkorgsmeddelande (Gemini) och generera
// ett svarsutkast i Jimmys röst (Claude), samt skapa utkastet i Outlook-tråden
// via Microsoft Graph (createReply + PATCH). Skickar ALDRIG.
//
// Används av både mail-triage.js (på klick från dashboarden) och mail-poll.js
// (schemalagd poller). CommonJS, zero-dependency.
//
// Modellval:
//   * Klassificering → Gemini flash (billig, bunden kategorisering, strukturerad
//     JSON via responseSchema).
//   * Utkastgenerering → Claude Haiku (snabb; ett kort svarsmejl kräver inte Opus,
//     och Opus var så långsamt att hela kedjan sprängde Netlifys 10 s-timeout).
//     Modell konfigurerbar via MAIL_DRAFT_MODEL, default claude-haiku-4-5-20251001.

const { graphJson } = require('./graph');

const MAILBOX = () => process.env.MAILBOX_USER || 'jimmy@peakfast.se';

// Default-modell för utkastgenerering. Haiku 4.5 är snabb nog för korta
// svarsmejl och håller oss väl under funktionens timeout.
const DEFAULT_DRAFT_MODEL = 'claude-haiku-4-5-20251001';

// ── Retry/backoff för transienta LLM-överbelastningar (429/503) ─
// Kör fn(); vid HTTP 429/503 (identifierat via err.status eller texten i
// felmeddelandet) väntas kort och exponentiellt innan nytt försök. Övriga fel
// kastas direkt. Total extra fördröjning är bunden (~1,7 s) så vi håller oss
// under funktionens timeout.
const RETRY_DELAYS = [500, 1200]; // ms → upp till 2 omförsök

function isTransientError(e) {
  const s = e && e.status;
  if (s === 429 || s === 503) return true;
  const msg = String((e && e.message) || '');
  return /HTTP\s+(429|503)\b/.test(msg);
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_DELAYS.length && isTransientError(e)) {
        await new Promise(res => setTimeout(res, RETRY_DELAYS[attempt]));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const CATEGORIES = ['offert_andelsratt', 'offert_forsaljning', 'support', 'abonnemang', 'brus'];

// ── Signatur / röstprofil ─────────────────────────────────────
const SIGNATURE =
  'Med vänliga hälsningar,\n' +
  'Jimmy Blomgren\n' +
  'Registrerad Fastighetsmäklare, PeakFast\n' +
  '070-788 57 00\n' +
  'jimmy@peakfast.se';

// ── Gemini: klassificering ────────────────────────────────────
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

async function classify(message) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY saknas i Netlify environment variables');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

  const userText =
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `Innehåll:\n${(message.text || '').slice(0, 8000)}`;

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
          contents: [{ role: 'user', parts: [{ text: userText }] }],
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
  });
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Tomt svar från Gemini vid klassificering.');
  const parsed = JSON.parse(text);
  if (!CATEGORIES.includes(parsed.category)) parsed.category = 'support';
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  return parsed;
}

// ── Claude: utkastgenerering ──────────────────────────────────
function draftSystemFor(category) {
  let extra = '';
  if (category === 'offert_andelsratt') {
    extra =
      'Detta gäller andelsförsäljning. Nämn att PeakFast har ett fast arvode på 37 500 kr (alt. 40 000 kr) inkl. moms för andelsförsäljning, och erbjud dig att skicka en fullständig offert.';
  } else if (category === 'offert_forsaljning') {
    extra =
      'Detta gäller en vanlig försäljning/värdering. Tacka för förfrågan, erbjud en kostnadsfri värdering och föreslå att boka en tid.';
  } else if (category === 'support') {
    extra =
      'Detta är en supportfråga. Bekräfta att du tagit emot frågan och ge ett hjälpsamt, konkret svar så långt det går utan att gissa fakta du inte har.';
  } else if (category === 'abonnemang') {
    extra =
      'Detta gäller ett abonnemangstillägg (Mäklargruvan). Bekräfta att du tagit emot önskemålet och att det hanteras. Lova INTE att ändringen redan är gjord — Jimmy måste bekräfta den manuellt.';
  }
  return (
    'Du skriver ett svarsutkast åt fastighetsmäklaren Jimmy Blomgren (PeakFast). ' +
    'Skriv artigt, professionellt och i första person ("jag"). Svara på svenska. ' +
    'Håll det kort och konkret. ' +
    extra +
    '\n\nAvsluta ALLTID med exakt denna signatur (oförändrad):\n' +
    SIGNATURE +
    '\n\nSkriv ENDAST själva mejltexten (hälsning, brödtext, signatur) — ingen ämnesrad, inga meta-kommentarer.'
  );
}

async function generateDraft(message, category) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');

  const userPrompt =
    `Inkommande mejl att besvara:\n\n` +
    `Ämne: ${message.subject || '(inget ämne)'}\n` +
    `Från: ${message.fromName || ''} <${message.fromAddress || ''}>\n\n` +
    `${(message.text || '').slice(0, 6000)}`;

  const model = process.env.MAIL_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;

  // Nätverksanropet retry:as vid transient 429/503.
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
        max_tokens: 700,
        system: draftSystemFor(category),
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
  });
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
  const text = m.body?.contentType === 'html'
    ? raw.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    : raw;
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
  const message = opts.message || (await fetchFullMessage(messageId));
  const classification = await classify(message);
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
  const draftText = await generateDraft(message, category);
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
  classify,
  generateDraft,
  createOutlookDraft,
  fetchFullMessage,
  triageMessage,
};
