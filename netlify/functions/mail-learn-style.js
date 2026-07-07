// netlify/functions/mail-learn-style.js
// Lär in Jimmys mejlstil från hans SKICKADE mejl (Sent Items) och destillerar
// en kort svensk stilguide med Claude Haiku. Resultatet sparas i
// data/mail-style.json (via lib/store.js) och injiceras sedan i utkast-
// genereringen (lib/triage.js) så att svarsutkasten låter som Jimmy.
//
// On-demand: körs bara när Jimmy klickar "Lär in min mejlstil" i dashboarden —
// ALDRIG per triage (skulle spränga 10 s-gränsen). Triage läser bara den
// färdiga data/mail-style.json.
//
// POST → { style_guide, examples[], sample_count, generated_at, fetched, used }
//
// Miljövariabler: MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET, MAILBOX_USER,
//                 ANTHROPIC_API_KEY, MAIL_DRAFT_MODEL (återanvänds), GH_TOKEN.

const { graphJson } = require('./lib/graph');
const { writeJsonFile } = require('./lib/store');
const { htmlToText, STYLE_FILE_PATH } = require('./lib/triage');

const MAILBOX = () => process.env.MAILBOX_USER || 'jimmy@peakfast.se';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Antal skickade mejl att hämta, och hur många rensade brödtexter vi matar in
// i modellen (håll nere token-mängden men ge tillräckligt underlag).
const FETCH_TOP = 40;
const MAX_SAMPLES = 25;
const MIN_WORDS = 15; // filtrera bort enradare/kvitton

// Markörer där ett citerat originalmeddelande börjar — vi klipper Jimmys egen
// text vid första träffen så modellen bara ser vad HAN skrivit.
const QUOTE_MARKERS = [
  /^\s*Från:/im,
  /^\s*From:/im,
  /^\s*Skickat:/im,
  /^\s*Sent:/im,
  /-{3,}\s*Ursprungligt meddelande/i,
  /-{3,}\s*Original Message/i,
  /^\s*Den .* skrev .*:/im,          // "Den 3 juli 2026 kl. 10:00 skrev X:"
  /^\s*On .* wrote:/im,               // "On ... wrote:"
  /^\s*_{5,}\s*$/m,                    // Outlooks understreck-linje
];

// Ämnen/inledningar som tyder på auto-svar eller vidarebefordran → hoppa över.
const SKIP_SUBJECT = /^(automatiskt svar|autosvar|auto[- ]?reply|frånvaro|out of office|vb:|vidarebefordrat|fwd:|läskvitto|read receipt|leveranskvitto)/i;

// Klipp bort citerad tråd + trimma.
function keepOwnText(text) {
  let cut = text;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(cut);
    if (m && m.index >= 0) cut = cut.slice(0, m.index);
  }
  return cut.replace(/\n{3,}/g, '\n\n').trim();
}

function wordCount(s) {
  return (s.match(/\S+/g) || []).length;
}

// Hämtar och rensar skickade mejl → lista med { subject, body }.
async function fetchSentSamples() {
  const mailbox = MAILBOX();
  const select = 'subject,body,bodyPreview,toRecipients,receivedDateTime,sentDateTime';
  const path =
    `/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages` +
    `?$top=${FETCH_TOP}&$select=${select}&$orderby=sentDateTime desc`;

  const data = await graphJson(path);
  const raw = (data && data.value) || [];
  const fetched = raw.length;

  const samples = [];
  for (const m of raw) {
    const subject = m.subject || '';
    if (SKIP_SUBJECT.test(subject)) continue;

    const bodyRaw = m.body?.content || m.bodyPreview || '';
    const plain = keepOwnText(htmlToText(bodyRaw, m.body?.contentType));
    if (wordCount(plain) < MIN_WORDS) continue;

    samples.push({ subject, body: plain.slice(0, 1800) });
    if (samples.length >= MAX_SAMPLES) break;
  }
  return { fetched, samples };
}

// Verktyg som tvingar Haiku att returnera giltig strukturerad JSON.
const STYLE_TOOL = {
  name: 'report_style_guide',
  description: 'Rapportera den destillerade stilguiden enligt schemat.',
  input_schema: {
    type: 'object',
    properties: {
      style_guide: {
        type: 'string',
        description:
          'En koncis svensk stilguide (3–6 meningar) som fångar Jimmys typiska hälsning, meningslängd/rytm, värme/formalitetsnivå, vanliga fraser/bindeord, hur han öppnar och avslutar, samt typisk längd.',
      },
      examples: {
        type: 'array',
        items: { type: 'string' },
        description: '3–5 korta ordagranna exempelmeningar som är representativa för hans ton.',
      },
    },
    required: ['style_guide', 'examples'],
  },
};

const STYLE_SYSTEM =
  'Du analyserar ett antal mejl som fastighetsmäklaren Jimmy Blomgren (PeakFast) själv har SKRIVIT och SKICKAT. ' +
  'Din uppgift är att destillera hans personliga skrivstil till en kort, användbar stilguide på svenska som en annan AI kan följa för att skriva svarsutkast i hans röst. ' +
  'Fokusera på HUR han skriver, inte vad de enskilda mejlen handlar om. ' +
  'Fånga: typisk hälsning, meningslängd och rytm, värme/formalitetsnivå, vanliga fraser och bindeord (t.ex. "så", "dvs", "bl.a."), hur han öppnar och avslutar, och typisk längd. ' +
  'Välj 3–5 korta ordagranna exempelmeningar ur materialet som är representativa. ' +
  'Rapportera via verktyget report_style_guide.';

function buildStyleUserText(samples) {
  const blocks = samples.map((s, i) => `--- Mejl ${i + 1} (ämne: ${s.subject || '(inget)'}) ---\n${s.body}`);
  return (
    `Här är ${samples.length} mejl som Jimmy själv skrivit. Destillera hans skrivstil:\n\n` +
    blocks.join('\n\n')
  );
}

async function distillStyle(samples) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');
  const model = process.env.MAIL_DRAFT_MODEL || DEFAULT_MODEL;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      system: STYLE_SYSTEM,
      tools: [STYLE_TOOL],
      tool_choice: { type: 'tool', name: 'report_style_guide' },
      messages: [{ role: 'user', content: buildStyleUserText(samples) }],
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Anthropic HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  const toolUse = (data.content || []).find(
    b => b.type === 'tool_use' && b.name === 'report_style_guide'
  );
  if (!toolUse || !toolUse.input) throw new Error('Anthropic gav inget tool_use-svar vid stilinlärning.');

  const guide = String(toolUse.input.style_guide || '').trim();
  const examples = Array.isArray(toolUse.input.examples)
    ? toolUse.input.examples.map(e => String(e || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  return { style_guide: guide, examples };
}

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

  try {
    const { fetched, samples } = await fetchSentSamples();
    if (!samples.length) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: `Hittade inga användbara skickade mejl att lära av (hämtade ${fetched}). Prova igen när det finns fler skickade svar.`,
          fetched,
        }),
      };
    }

    const distilled = await distillStyle(samples);
    const profile = {
      style_guide: distilled.style_guide,
      examples: distilled.examples,
      generated_at: new Date().toISOString(),
      sample_count: samples.length,
      is_default: false,
    };

    await writeJsonFile(
      STYLE_FILE_PATH,
      profile,
      `Uppdatera inlärd mejlstil (${samples.length} skickade mejl)`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...profile, fetched, used: samples.length }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: `Stilinlärning misslyckades: ${e.message}` }),
    };
  }
};
