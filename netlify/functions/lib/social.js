// netlify/functions/lib/social.js
// Delad kärna för sociala förslag: watcher-källor, parsning, Claude-utkast och
// kötillstånd. Används av social-watch.js (schemalagd, 1×/dygn) och
// social-queue.js (dashboardens kö-API, inkl. manuell "Hämta nu").
//
// Designprincip (beslutad 2026-08-05, analyserad 2026-08-17): FÖRSLAGSMOTOR med
// godkännandekö — ingenting publiceras av den här koden. Watchern hämtar
// kandidater, Claude filtrerar och skriver 2–3 utkastvarianter i jag-form
// signerade "— Jimmy", och allt landar i data/social-queue.json där Jimmy
// godkänner/redigerar/kastar i dashboarden. Publicering byggs separat och
// konsumerar enbart status 'godkänd'.
//
// Tillstånd (data/social-queue.json via lib/store.js — GitHub-JSON, versionerat):
//   { seen: { <källa>:<id>: iso }, items: [...], historik: [...], lastRun: iso }
// items är append-only i meningen att åtgärder bara ändrar status — poster
// raderas aldrig av godkänn/kasta (lärdom från säljarrapportens historik-bugg).
//
// Miljövariabler: ANTHROPIC_API_KEY (utkast), GH_TOKEN (store).
// Valfria: SOCIAL_DRAFT_MODEL (default Claude Haiku 4.5).

const { readJsonFile, writeJsonFile } = require('./store');

const FILE_PATH = 'data/social-queue.json';
const MAX_NEW_PER_RUN = 2;    // källorna är månatliga; 2/körning dränerar ev. kö
const TIME_BUDGET_MS = 6000;  // starta inget nytt objekt efter detta (10 s-taket)
const MAX_ITEMS = 100;
const MAX_HISTORIK = 200;
const FETCH_TIMEOUT_MS = 5000;
const UA = 'GruvanTech-Dashboard/1.0 (social-watch; +https://gruvantech.se)';

const DEFAULT_DRAFT_MODEL = 'claude-haiku-4-5-20251001';

// ── Källor (flöde 1: marknadsdata) ────────────────────────────
// Varje källa: { id, label, listUrl, parse(html) → [{id,title,url,dateText}] }.
// Nya källor (Valueguard HOX, SCB — och senare flöde 2: Riksdagen/FMI/FRN)
// läggs till här utan att röra watcher- eller kölogiken.
//
// Svensk Mäklarstatistik: /feed/ (RSS) finns men är TOMT (verifierat
// 2026-08-17) → vi parsar pressrummet, som listar alla pressmeddelanden som
// länkar till /pressmeddelanden/<slug>/ med datum intill (t.ex. "07 aug 2026").
const SOURCES = [
  {
    id: 'maklarstatistik',
    label: 'Svensk Mäklarstatistik',
    listUrl: 'https://www.maklarstatistik.se/pressrum/',
    parse: parseMaklarstatistik,
  },
];

// Minimal HTML→text (samma anda som triage.js htmlToText, lokal kopia för att
// inte dra in hela mail-stacken som beroende).
function htmlToText(raw) {
  return String(raw || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8221;|&#8220;|&rdquo;|&ldquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Pressrums-parser. Tål både absoluta och relativa hrefs, plockar datumet ur
// texten strax före länken när det finns ("07 aug 2026"). Dedupar på slug och
// behåller den längsta länktexten (bildlänkar till samma slug har tom text).
function parseMaklarstatistik(html) {
  const s = String(html || '');
  const linkRe = /<a\b[^>]*href="(?:https?:\/\/(?:www\.)?maklarstatistik\.se)?\/pressmeddelanden\/([^"/#?]+)\/?(?:[?#][^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;
  const dateRe = /(\d{1,2})\s*(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)[a-z]*\.?\s*(\d{4})/gi;

  const bySlug = new Map(); // slug → {id,title,url,dateText,order}
  let m;
  let order = 0;
  while ((m = linkRe.exec(s)) !== null) {
    const slug = m[1];
    const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    // Datum: sista datumsträngen i de 200 tecknen före länken.
    const before = s.slice(Math.max(0, m.index - 200), m.index);
    let dateText = '';
    let dm;
    dateRe.lastIndex = 0;
    while ((dm = dateRe.exec(before)) !== null) dateText = `${dm[1]} ${dm[2]} ${dm[3]}`;

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, { id: slug, title, url: `https://www.maklarstatistik.se/pressmeddelanden/${slug}/`, dateText, order: order++ });
    } else {
      if (title.length > existing.title.length) existing.title = title;
      if (!existing.dateText && dateText) existing.dateText = dateText;
    }
  }
  // Sidan listar nyast först — behåll den ordningen, släng titellösa rester.
  return [...bySlug.values()]
    .filter(it => it.title.length >= 8)
    .sort((a, b) => a.order - b.order);
}

// ── Hämtning ──────────────────────────────────────────────────
async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} vid hämtning av ${url}`);
  return r.text();
}

// Hämtar pressmeddelandets brödtext (för att utkasten ska bygga på RIKTIGA
// siffror, inte bara rubriken). Titeln förekommer två gånger i den strippade
// sidan: först i <title> (position ~0), sedan som H1 där brödtexten börjar —
// mellan dem ligger sajtens läns-/kommunnav (~tusentals tecken brus). Därför
// söker vi titelns förekomst EFTER de första 100 tecknen och klipper därifrån.
async function fetchArticleText(url, title) {
  const text = htmlToText(await fetchText(url));
  let start = 0;
  const t = String(title || '').slice(0, 30);
  if (t) {
    const i = text.indexOf(t, 100);
    if (i > 0) start = i;
  }
  return text.slice(start, start + 4500);
}

// ── Claude: relevansfilter + utkastvarianter (ett anrop) ──────
// Tool-use med forcerat verktygsval → garanterat giltig strukturerad JSON
// (samma mönster som lib/triage.js klassificering).
const SUGGEST_TOOL = {
  name: 'report_social_suggestion',
  description: 'Rapportera relevansbedömning och utkastvarianter enligt schemat.',
  input_schema: {
    type: 'object',
    properties: {
      relevant: {
        type: 'boolean',
        description: 'false om innehållet inte tillför något för svenska fastighetsmäklare (t.ex. interna organisationsnyheter från källan).',
      },
      reason: { type: 'string', description: 'Kort motivering av relevansbedömningen (1–2 meningar, svenska).' },
      variants: {
        type: 'array',
        minItems: 2,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Kort etikett: "Kort", "Utförlig" eller "Snärtig".' },
            text: { type: 'string', description: 'Hela inläggstexten, avslutad med "— Jimmy".' },
          },
          required: ['label', 'text'],
        },
      },
      image_hint: { type: 'string', description: 'Kort förslag på textkort för Instagram (IG kräver bild).' },
    },
    required: ['relevant', 'reason', 'variants', 'image_hint'],
  },
};

const SUGGEST_SYSTEM = `Du skriver UTKAST till inlägg för Mäklargruvans egna Facebook- och Instagram-konton. Utkasten hamnar i en godkännandekö — ingenting publiceras utan mänsklig granskning.

OM AVSÄNDAREN: Mäklargruvan är ett svenskt verktyg för fastighetsmäklare, byggt av Jimmy Blomgren. Inläggen publiceras på företagets sidor men skrivs i JAG-FORM med Jimmy som röst, och varje variant avslutas med signaturen "— Jimmy".

MÅLGRUPP: svenska fastighetsmäklare och byråägare — INTE bostadsköpare eller säljare. Vinkla alltid mot vad innehållet betyder i mäklarens vardag: kundsamtal, prisdiskussioner, intag, den lokala marknaden.

ABSOLUTA REGLER (viktigast av allt):
- Använd ENDAST fakta och siffror som står i underlaget. Hitta ALDRIG på siffror, trender eller orsaker. Saknas en siffra — utelämna den hellre.
- Påstå ALDRIG något om lagar, regler eller myndighetsbeslut utöver vad underlaget uttryckligen säger.
- Räcker underlaget inte för ett hederligt inlägg: sätt relevant=false och förklara varför.

TON:
- Kunnig kollega, inte marknadsavdelning. Vardaglig svenska, korta meningar.
- Utfallsspråk — vad siffrorna betyder och vad läsaren kan göra — inte hype. Nämn INTE Mäklargruvan-produkten i inläggen; de här inläggen bygger förtroende, de säljer inte.
- Gärna en personlig observation från Jimmy ("Jag noterar att …", "Det här känns igen från samtalen med kollegor …") och gärna en avslutande fråga till kollegorna i branschen.
- Emojis: högst 1–2, bara om det känns naturligt. Hashtags: högst 2 diskreta, eller inga. Inga utropsteckenkaskader.
- Nämn källan naturligt i texten (t.ex. "Svensk Mäklarstatistiks julisiffror").

VARIANTER (2–3 stycken, alla fristående):
1. "Kort" — ca 300–500 tecken, funkar rakt av som FB/IG-caption.
2. "Utförlig" — ca 600–900 tecken, en–två konkreta siffror till och en tanke om vad det betyder för mäklare.
3. (valfri) "Snärtig" — 1–2 meningar, mer krok än analys.
Varje variant avslutas med "— Jimmy". Skriv på svenska. Inga rubriker, inga citattecken runt texten.

BILD: image_hint = kort förslag på textkort för Instagram, t.ex. 'Textkort: "Villor +1,8 % i juli" — stor siffra, mörkblå bakgrund, källrad Svensk Mäklarstatistik.'`;

// Transienta LLM-fel (429/503/529) retry:as kort — samma mönster som triage.js,
// men med snäv budget eftersom watchern lever under funktionens 10 s-tak.
const RETRY_DELAYS = [500, 1200];

function isTransientError(e) {
  const s = e && e.status;
  if (s === 429 || s === 503 || s === 529) return true;
  return /HTTP\s+(429|503|529)\b/.test(String((e && e.message) || ''));
}

async function withRetry(fn, delays = RETRY_DELAYS) {
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

async function suggestPost(candidate, articleText, sourceLabel) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');
  const model = process.env.SOCIAL_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;

  const user =
    `KÄLLA: ${sourceLabel}\n` +
    `TITEL: ${candidate.title}\n` +
    (candidate.dateText ? `DATUM: ${candidate.dateText}\n` : '') +
    `URL: ${candidate.url}\n\n` +
    `UNDERLAG (utdrag ur pressmeddelandet):\n${articleText || '(kunde inte hämtas — bedöm utifrån titeln, och sätt relevant=false om den inte räcker)'}`;

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
        max_tokens: 1400,
        system: SUGGEST_SYSTEM,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: 'tool', name: 'report_social_suggestion' },
        messages: [{ role: 'user', content: user }],
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

  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'report_social_suggestion');
  if (!toolUse || !toolUse.input) throw new Error('Anthropic gav inget tool_use-svar för förslaget.');
  const out = toolUse.input;
  return {
    relevant: !!out.relevant,
    reason: String(out.reason || ''),
    variants: (Array.isArray(out.variants) ? out.variants : [])
      .map(v => ({ label: String((v && v.label) || 'Variant'), text: String((v && v.text) || '').trim() }))
      .filter(v => v.text),
    imageHint: String(out.image_hint || ''),
  };
}

// ── Tillstånd ─────────────────────────────────────────────────
function normalizeState(data) {
  const s = data && typeof data === 'object' ? data : {};
  return {
    seen: s.seen && typeof s.seen === 'object' ? { ...s.seen } : {},
    items: Array.isArray(s.items) ? s.items : [],
    historik: Array.isArray(s.historik) ? s.historik : [],
    lastRun: s.lastRun || null,
  };
}

function pushHistorik(state, entry) {
  state.historik.unshift({ ts: new Date().toISOString(), ...entry });
  state.historik = state.historik.slice(0, MAX_HISTORIK);
}

async function readState() {
  const { data } = await readJsonFile(FILE_PATH, null);
  return normalizeState(data);
}

async function writeState(state, message) {
  await writeJsonFile(FILE_PATH, state, message);
}

// ── Watcher ───────────────────────────────────────────────────
// Kör alla källor: hämta lista → nya kandidater → hämta artikel → Claude →
// köa. Första körningen SÅR: alla befintliga poster markeras sedda och bara
// den senaste bearbetas (annars hade 97 gamla pressmeddelanden blivit förslag).
// Tidsbudget: startar inget nytt objekt efter TIME_BUDGET_MS; obearbetade
// kandidater markeras INTE sedda och plockas upp nästa körning.
async function runWatch() {
  const started = Date.now();
  const log = { ran: new Date().toISOString(), sources: 0, candidates: 0, nya: 0, tillagda: 0, irrelevanta: 0, seedade: 0, errors: [] };

  const state = await readState();
  let changed = false;

  for (const source of SOURCES) {
    log.sources++;
    let candidates;
    try {
      candidates = source.parse(await fetchText(source.listUrl));
    } catch (e) {
      log.errors.push(`${source.id}: ${e.message}`);
      continue; // en källas fel ska inte stoppa övriga
    }
    log.candidates += candidates.length;

    const keyOf = c => `${source.id}:${c.id}`;
    const isSeeding = !Object.keys(state.seen).some(k => k.startsWith(source.id + ':'));

    let fresh = candidates.filter(c => !state.seen[keyOf(c)]);
    if (isSeeding) {
      // Så: markera allt sett, bearbeta bara det senaste (första i listan) som
      // ett första exempel-förslag så kedjan syns direkt i kön.
      for (const c of candidates) state.seen[keyOf(c)] = new Date().toISOString();
      fresh = candidates.slice(0, 1);
      log.seedade += Math.max(0, candidates.length - fresh.length);
      changed = true;
    }
    log.nya += fresh.length;

    let processed = 0;
    for (const c of fresh) {
      if (processed >= MAX_NEW_PER_RUN) break;
      if (Date.now() - started > TIME_BUDGET_MS) {
        log.errors.push(`${source.id}: tidsbudgeten nådd — ${fresh.length - processed} kandidat(er) väntar till nästa körning`);
        break;
      }
      processed++;
      try {
        let articleText = '';
        try {
          articleText = await fetchArticleText(c.url, c.title);
        } catch (e) {
          log.errors.push(`${source.id}/${c.id}: artikelhämtning: ${e.message}`);
        }
        const suggestion = await suggestPost(c, articleText, source.label);
        state.items.unshift({
          id: `${source.id}:${c.id}`,
          source: source.id,
          sourceLabel: source.label,
          title: c.title,
          url: c.url,
          dateText: c.dateText || '',
          status: suggestion.relevant ? 'väntar' : 'irrelevant',
          reason: suggestion.reason,
          variants: suggestion.variants,
          imageHint: suggestion.imageHint,
          created: new Date().toISOString(),
        });
        state.items = state.items.slice(0, MAX_ITEMS);
        state.seen[keyOf(c)] = new Date().toISOString();
        if (suggestion.relevant) log.tillagda++; else log.irrelevanta++;
        changed = true;
      } catch (e) {
        // Objektet markeras INTE sett vid fel → nytt försök nästa körning.
        log.errors.push(`${source.id}/${c.id}: ${e.message}`);
      }
    }
  }

  if (changed) {
    state.lastRun = log.ran;
    pushHistorik(state, {
      action: 'watch',
      note: `${log.tillagda} förslag, ${log.irrelevanta} irrelevanta, ${log.seedade} sådda${log.errors.length ? `, ${log.errors.length} fel` : ''}`,
    });
    await writeState(state, `Sociala förslag: watcher +${log.tillagda} förslag (${log.irrelevanta} irrelevanta, ${log.seedade} sådda)`);
  }
  // Ingen förändring → ingen skrivning (undviker en tom commit per dygn).

  return log;
}

module.exports = {
  FILE_PATH,
  SOURCES,
  MAX_ITEMS,
  htmlToText,
  parseMaklarstatistik,
  fetchArticleText,
  suggestPost,
  normalizeState,
  pushHistorik,
  readState,
  writeState,
  runWatch,
};
