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

// ── Stadier: vad källan FAKTISKT säger ────────────────────────
// 🔑 Kärnprincipen i flöde 2: stadiet bestäms av METADATA (vilken källa och
// vilken dokumenttyp kandidaten kom från), ALDRIG av språkmodellen. En
// proposition är ett förslag även om den låter tvärsäker, och att posta "nya
// regler för mäklare från 1 januari" baserat på ett förslag är det dyraste
// felet vi kan göra — dubbelt dyrt när vi säljer juridiskt beslutsstöd.
// Samma princip som isCalendarMessage i lib/triage.js: det som får styra
// säkerheten avgörs deterministiskt, inte av en modell som kan missförstå.
const STADIER = {
  marknadsdata: {
    etikett: 'Marknadsdata',
    regel: 'Detta är marknadsstatistik. Använd bara siffror som står i underlaget.',
  },
  beslutad: {
    etikett: 'Beslutad författning (SFS)',
    regel:
      'Detta är en BESLUTAD OCH UTFÄRDAD författning (SFS). Du får skriva att reglerna gäller eller träder i kraft — men BARA med det ikraftträdandedatum som uttryckligen står i underlaget. Står inget datum: nämn inget datum alls.',
  },
  forslag: {
    etikett: 'Förslag — inte beslutat',
    regel:
      'Detta är ett FÖRSLAG (proposition/betänkande) som riksdagen ÄNNU INTE har beslutat om. Du får ALDRIG skriva att något "gäller", "införs", "träder i kraft" eller ange ett datum då det börjar gälla. Skriv alltid tydligt att det är ett förslag och att beslut inte är fattat. Rätt formuleringar: "regeringen föreslår", "förslaget skulle innebära", "riksdagen har ännu inte tagit ställning". Om du inte kan skriva inlägget utan att antyda att reglerna redan gäller: sätt relevant=false.',
  },
  myndighet: {
    etikett: 'Myndighetsinformation (FMI)',
    regel:
      'Detta är information från Fastighetsmäklarinspektionen, tillsynsmyndigheten. Referera till att FMI informerar, påminner, granskar eller förtydligar. Du får ALDRIG presentera FMI:s information som ny lagstiftning eller som en regeländring — om FMI förtydligar vad som redan gäller, skriv just det. ' +
      'VIKTIGT: myndighetsinformation handlar ofta i sin tur om FÖRSLAG (t.ex. EU-regler som ännu bara är föreslagna). Står det "föreslås" i underlaget MÅSTE förbehållet följa med i din text — skriv "föreslås börja tillämpas", aldrig "börjar tillämpas". Datum får bara anges med samma säkerhet som underlaget använder.',
  },
};

// ── Källor ────────────────────────────────────────────────────
// Varje källa: { id, label, stadium, hamta() → [{id,title,url,dateText}] }.
// Stadiet är fast per källa eftersom det följer av dokumenttypen.
//
// Flöde 1 — marknadsdata. Svensk Mäklarstatistiks /feed/ (RSS) finns men är
// TOMT (verifierat 2026-08-17) → vi parsar pressrummet, som listar alla
// pressmeddelanden som /pressmeddelanden/<slug>/ med datum intill.
//
// Flöde 2 — regel- och lagändringar (2026-08-18). Riksdagens öppna data
// skiljer dokumenttyperna åt, vilket är precis vad stadie-logiken behöver:
// doktyp=sfs är beslutad författning, doktyp=prop är ett förslag. FMI:s
// nyheter är myndighetsinformation och ligger per år under /nyheter/<år>/.
const SOURCES = [
  {
    id: 'maklarstatistik',
    label: 'Svensk Mäklarstatistik',
    stadium: 'marknadsdata',
    listUrl: 'https://www.maklarstatistik.se/pressrum/',
    parse: parseMaklarstatistik,
    hamta: async function () { return this.parse(await fetchText(this.listUrl)); },
  },
  {
    id: 'riksdag-sfs',
    label: 'Svensk författningssamling (riksdagen)',
    stadium: 'beslutad',
    hamta: () => riksdagSok('sfs'),
  },
  {
    id: 'riksdag-prop',
    label: 'Proposition (riksdagen)',
    stadium: 'forslag',
    hamta: () => riksdagSok('prop'),
  },
  {
    id: 'fmi',
    label: 'Fastighetsmäklarinspektionen',
    stadium: 'myndighet',
    hamta: () => fmiNyheter(),
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
    // Numeriska entiteter — FMI:s sidor kodar åäö som &#xE4; m.fl., och utan
    // detta hamnar "Öppen" som "&#xD6;ppen" rakt in i utkasten.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ' '; } })
    // Andra taggpasset: riksdagens .text-filer är HTML-ESCAPADE, så deras
    // taggar dyker upp först när entiteterna avkodats ovan. Utan det här
    // hamnar `<P class="p7 ft4">` som synlig text i underlaget.
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
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

// ── Riksdagens öppna data ─────────────────────────────────────
// Söker per dokumenttyp och sökord, slår ihop och dedupar på dok_id. Smala
// sökord med flit: en bred sökning (t.ex. "penningtvätt") drar in hundratals
// dokument som bara nämner ordet i förbifarten. Claude-filtret sållar sedan
// vidare på faktisk relevans för mäklare.
const RIKSDAG_SOKORD = ['fastighetsmäklare', 'fastighetsmäklarlagen'];
// Riksdagens sökmotor svarar på ~0,2 s lokalt men är märkbart trögare från
// Netlifys datacenter — egen, generösare timeout än övriga källor.
const RIKSDAG_TIMEOUT_MS = 12000;
// Sökningen returnerar HELA historiken — Fastighetsmäklarförordningen (2021)
// och penningtvättslagen (2017) kom med i första körningen. Ett generöst
// relevansfilter får aldrig göra en tio år gammal författning till en "nyhet",
// så åldern gallras deterministiskt före modellen ens ser kandidaten.
const RIKSDAG_MAX_ALDER_MAN = 18;

function forFerskt(datum, maxManader) {
  const d = Date.parse(String(datum || ''));
  if (!Number.isFinite(d)) return false; // utan datum: hellre utelämna än gissa
  const manader = (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.44);
  return manader <= maxManader;
}

async function riksdagSok(doktyp) {
  const perSok = await Promise.all(
    RIKSDAG_SOKORD.map(async (ord) => {
      const url =
        'https://data.riksdagen.se/dokumentlista/?utformat=json&sz=15&sort=datum&sortorder=desc' +
        `&doktyp=${encodeURIComponent(doktyp)}&sok=${encodeURIComponent(ord)}`;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(RIKSDAG_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return (d && d.dokumentlista && d.dokumentlista.dokument) || [];
      } catch (e) {
        // Behåll det faktiska felet — ett generiskt "svarade inte" gör det
        // omöjligt att skilja timeout från blockering eller parsefel.
        return { fel: e.name === 'TimeoutError' ? `timeout efter ${RIKSDAG_TIMEOUT_MS} ms` : (e.message || String(e)) };
      }
    })
  );
  // ...men om ALLA sökord fallerade är API:et nere, och det ska synas i loggen
  // i stället för att se ut som "inga nya dokument".
  if (perSok.every(r => r && r.fel)) {
    throw new Error(`Riksdagen doktyp=${doktyp}: ${perSok.map(r => r.fel).join(' | ')}`);
  }

  const seen = new Set();
  const ut = [];
  for (const dok of perSok.filter(r => Array.isArray(r)).flat()) {
    const id = String(dok.dok_id || dok.id || '').trim();
    const titel = String(dok.titel || '').trim();
    if (!id || !titel || seen.has(id)) continue;
    seen.add(id);
    ut.push({
      id,
      title: dok.undertitel && !titel.includes(dok.undertitel) ? `${titel} — ${dok.undertitel}` : titel,
      url: dok.dokument_url_html
        ? `https:${dok.dokument_url_html}`
        : `https://www.riksdagen.se/sv/dokument-och-lagar/dokument/_${id}/`,
      dateText: String(dok.datum || dok.publicerad || '').slice(0, 10),
      // Textversionen är renare än HTML-sidan för LLM-kontext.
      textUrl: dok.dokument_url_text ? `https:${dok.dokument_url_text}` : null,
    });
  }
  // Nyast först — API:et sorteras per sökning, inte över den sammanslagna
  // listan — och bara det som faktiskt är färskt nog att vara en nyhet.
  return ut
    .filter(x => forFerskt(x.dateText, RIKSDAG_MAX_ALDER_MAN))
    .sort((a, b) => String(b.dateText).localeCompare(String(a.dateText)));
}

// ── FMI:s nyheter ─────────────────────────────────────────────
// Nyheterna ligger per år: /nyheter-press/nyheter/<år>/, som blocklänkar med
// datumet (YYYY-MM-DD) i texten strax före länken.
async function fmiNyheter(ar) {
  const year = ar || new Date().getFullYear();
  const lista = parseFmiNyheter(await fetchText(`https://fmi.se/nyheter-press/nyheter/${year}/`), year);
  // Tidigt på året är innevarande års lista nästan tom — ta då med fjolåret
  // så bevakningen inte tystnar varje januari.
  if (lista.length >= 5 || ar) return lista;
  try {
    const ifjol = parseFmiNyheter(await fetchText(`https://fmi.se/nyheter-press/nyheter/${year - 1}/`), year - 1);
    return [...lista, ...ifjol];
  } catch (e) {
    return lista; // fjolåret är en bonus, inte ett krav
  }
}

function parseFmiNyheter(html, year) {
  const s = String(html || '');
  const re = new RegExp(`<a\\b[^>]*href="(/nyheter-press/nyheter/${year}/([^"/]+)/?)"[^>]*>([\\s\\S]*?)</a>`, 'gi');
  const bySlug = new Map();
  let m;
  let order = 0;
  while ((m = re.exec(s)) !== null) {
    const slug = m[2];
    const raw = htmlToText(m[3]).replace(/\s+/g, ' ').trim();
    // Blocklänken innehåller både rubrik och datum — plocka ut datumet och
    // låt det aldrig bli en del av titeln.
    const iDatum = raw.match(/(\d{4}-\d{2}-\d{2})/);
    const title = raw.replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '').trim();
    // Annars står datumet strax före länken i listan.
    const fore = s.slice(Math.max(0, m.index - 300), m.index);
    const datum = (iDatum && iDatum[1]) || (fore.match(/(\d{4}-\d{2}-\d{2})(?![\s\S]*\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const fanns = bySlug.get(slug);
    if (!fanns) {
      bySlug.set(slug, { id: slug, title, url: `https://fmi.se${m[1].replace(/\/?$/, '/')}`, dateText: datum, order: order++ });
    } else if (title.length > fanns.title.length) {
      fanns.title = title;
      if (!fanns.dateText && datum) fanns.dateText = datum;
    }
  }
  return [...bySlug.values()].filter(it => it.title.length >= 8).sort((a, b) => a.order - b.order);
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

// Underlag för en kandidat. Riksdagsdokument har en ren textversion som är
// bättre än HTML-sidan; övriga källor läses som artikel. Riksdagsdokument kan
// vara hundratals sidor — vi tar början, där syfte och ikraftträdande står.
async function fetchUnderlag(kandidat) {
  if (kandidat.textUrl) {
    const text = htmlToText(await fetchText(kandidat.textUrl));
    // Riksdagens textversion inleds med ett metadatablock (dok-id, riksmöte,
    // dokumenttyp upprepat). Propositioner har rubriken "Propositionens
    // huvudsakliga innehåll" — exakt den sammanfattning vi vill åt — så klipp
    // dit när den finns; annars hoppa förbi metadatan.
    const i = text.search(/huvudsakliga innehåll/i);
    const start = i > 0 ? Math.max(0, i - 120) : Math.min(400, Math.floor(text.length / 10));
    return text.slice(start, start + 5000);
  }
  return fetchArticleText(kandidat.url, kandidat.title);
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
- MÄSTRA ALDRIG läsaren (viktig regel från Jimmy): skriv inga meningar som förklarar för mäklare varför något är viktigt i deras eget yrke — "Det här är viktigt för värderingssamtal", "Det här behöver ni ha koll på", "Tänk på att …" är förbjudna mönster. Läsarna är proffs som redan vet. Konstatera siffrorna och dela en observation, punkt.
- Utfallsspråk, inte hype. Ingen produktpitch — nämn aldrig funktioner, priser eller uppmaningar att testa Mäklargruvan. Men avsluta gärna med en SUBTIL brygga till nyttan av rätt verktyg, helst som en kort fråga i stil med "Har du rätt verktyg för att möta marknaden?".
- Gärna en personlig observation från Jimmy ("Jag noterar att …", "Det här känns igen från samtalen med kollegor …"). Den avslutande frågan kan vara verktygsbryggan ovan eller en fråga till kollegorna — men bara EN avslutande fråga per variant.
- Emojis: högst 1–2, bara om det känns naturligt. Hashtags: högst 2 diskreta, eller inga. Inga utropsteckenkaskader.
- Nämn källan naturligt i texten (t.ex. "Svensk Mäklarstatistiks julisiffror").

VARIANTER (2–3 stycken, alla fristående):
1. "Kort" — ca 300–500 tecken, funkar rakt av som FB/IG-caption.
2. "Utförlig" — ca 600–900 tecken, en–två konkreta siffror till och en tanke om vad det betyder för mäklare.
3. (valfri) "Snärtig" — 1–2 meningar, mer krok än analys.
Varje variant avslutas med "— Jimmy". Skriv på svenska. Inga rubriker, inga citattecken runt texten.

BILD: image_hint = kort förslag på textkort för Instagram, t.ex. 'Textkort: "Villor +1,8 % i juli" — stor siffra, mörkblå bakgrund, källrad Svensk Mäklarstatistik.'`;

// Relevanströskeln för juridiska källor är medvetet GENERÖSARE än för
// marknadsdata. Bakgrund: första skarpa körningen sållade bort propositionen
// "Stärkt trygghet i bostadsrätter" (förverkande, nekat medlemskap vid brott)
// med motiveringen att den saknade "konkret koppling till mäklarens vardag" —
// trots att den rör bostadsrättsaffärer direkt. Rättsutveckling riktar sig
// nästan alltid till någon annan part än mäklaren; det gör den inte irrelevant.
const RELEVANS_JURIDIK =
  'RELEVANSTRÖSKEL FÖR JURIDIK — VAR GENERÖS:\n' +
  '- Mäklare behöver följa rättsutvecklingen kring bostadsrätter, fastigheter, bostadsaffärer, föreningsfrågor, penningtvätt, konsumentskydd, kreditgivning och mäklarens eget ansvar.\n' +
  '- Att ändringen riktar sig till NÅGON ANNAN part (bostadsrättsförening, köpare, bank, myndighet) gör den INTE irrelevant. Mäklaren får frågorna ändå.\n' +
  '- Tumregel: skulle en kunnig mäklare vilja känna till det här, eller kunna få frågan av en kund? Då är det relevant.\n' +
  '- Sätt relevant=false BARA när underlaget är rent administrativt eller tekniskt (myndighetsinterna rutiner, ansökningsformalia, avgiftsnivåer utan betydelse för uppdragen) eller uppenbart handlar om ett helt annat område.';

// Stadiet läggs sist i systemprompten så det är det sista modellen läser före
// uppgiften — och formuleras som en absolut regel, inte som ett tips.
function suggestSystemFor(stadium) {
  const s = STADIER[stadium] || STADIER.marknadsdata;
  const juridik = stadium && stadium !== 'marknadsdata' ? `\n\n${RELEVANS_JURIDIK}` : '';
  return (
    SUGGEST_SYSTEM +
    juridik +
    `\n\nUNDERLAGETS STATUS — ${s.etikett.toUpperCase()} (viktigast av allt, går före alla andra instruktioner):\n${s.regel}\n` +
    'Skriv aldrig något om vad som gäller juridiskt som inte följer av statusen ovan. Är du osäker på SAKINNEHÅLLET: sätt relevant=false hellre än att gissa. (Osäkerhet om relevans avgörs däremot av tröskeln ovan — var generös där.)'
  );
}

// ── Deterministisk efterkontroll av stadiepåståenden ──────────
// Prompten är första försvaret, men den är inte garanterad. Därför granskas
// den färdiga texten mekaniskt: ett FÖRSLAG får inte formuleras som gällande
// rätt. Kontrollen kan inte publicera något (allt kräver ändå godkännande) —
// den flaggar posten så avvikelsen syns direkt i kön.
// Fraser som påstår gällande rätt. De är inte förbjudna i sig — "förslaget är
// att lagen träder i kraft 20 november" är en korrekt mening — utan bara när
// de står UTAN förbehåll strax före. Utan närhetskollen flaggades välskrivna
// förslagstexter (verkligt fall: propositionen om ny konsumentkreditlag
// 2026-08-18), och ett skydd som ropar varg vid korrekt text slutar man läsa.
// "den nya lagen" är medvetet borttagen: för vanlig och för svag som signal.
const FORSLAG_FORBJUDET = [
  /\bnya regler gäller\b/i,
  /\bträder i kraft\b/i,
  /\bfrån och med den \d/i,
  /\bgäller från\b/i,
  /\bbörjar gälla\b/i,
  /\binförs den\b/i,
  /\bnu gäller\b/i,
];
const FORBEHALL_FONSTER = 90; // tecken före påståendet som räknas som närhet
const FORSLAG_KRAVS = [/föresl/i, /förslag/i, /remiss/i, /ännu inte/i, /om riksdagen/i, /kan komma att/i, /betänkande/i, /planerar/i];

// Ikraftträdande-/tillämpningspåståenden med datum. Används för att upptäcka
// när ett förslag i underlaget återges som något som faktiskt ska börja gälla.
const TILLAMPNING_MED_DATUM = /(träder i kraft|börjar (?:gälla|tillämpas)|gäller från|tillämpas från)[^.]{0,40}\d{4}/i;

// Står ett förbehåll ("föreslår", "ännu inte", "förslaget är att" …) tillräckligt
// nära före påståendet för att bära det?
function harForbehallNara(text, index) {
  const fore = String(text).slice(Math.max(0, index - FORBEHALL_FONSTER), index);
  return FORSLAG_KRAVS.some(re => re.test(fore));
}

function granskaStadiepastaende(stadium, varianter, underlag) {
  const problem = [];

  if (stadium === 'forslag') {
    for (const v of varianter) {
      const t = String(v.text || '');
      if (!FORSLAG_KRAVS.some(re => re.test(t))) {
        problem.push(`"${v.label}" saknar förbehåll om att förslaget inte är beslutat`);
        continue;
      }
      // Texten HAR förbehåll någonstans — kontrollera att varje påstående om
      // ikraftträdande också bärs av ett förbehåll i sin närhet.
      const oforbehallet = FORSLAG_FORBJUDET.find(re => {
        const m = re.exec(t);
        return m && !harForbehallNara(t, m.index);
      });
      if (oforbehallet) problem.push(`"${v.label}" påstår oförbehållet att reglerna gäller (${oforbehallet.source})`);
    }
    if (problem.length) {
      return `⚠ Källan är ett FÖRSLAG som inte är beslutat, men texten läser som gällande regler: ${problem.join('; ')}. Läs extra noga innan du godkänner.`;
    }
    return null;
  }

  // 🔑 Myndighetsinformation kan i sin tur handla om ett FÖRSLAG — t.ex. när
  // FMI berättar om EU-regler som "föreslås börja tillämpas 2028". Stadiet
  // säger bara varifrån uppgiften kommer, inte hur säker den är. Därför
  // jämförs texten mot underlaget: nämner underlaget ett förslag medan
  // utkastet skriver ut ett tillämpningsdatum utan förbehåll, flaggas det.
  // (Verkligt fall 2026-08-18: FMI skrev "föreslås börja tillämpas från den
  // 31 december 2028" → utkastet blev "innan det börjar tillämpas 2028".)
  if (stadium === 'myndighet' && /föresl/i.test(String(underlag || ''))) {
    for (const v of varianter) {
      const t = String(v.text || '');
      if (TILLAMPNING_MED_DATUM.test(t) && !FORSLAG_KRAVS.some(re => re.test(t))) {
        problem.push(`"${v.label}" anger ett datum för när reglerna börjar gälla, men underlaget säger att de bara föreslås`);
      }
    }
    if (problem.length) {
      return `⚠ Underlaget beskriver ett FÖRSLAG, men texten anger det som bestämt: ${problem.join('; ')}. Kontrollera mot källan innan du godkänner.`;
    }
  }
  return null;
}

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

async function suggestPost(candidate, articleText, sourceLabel, stadium) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');
  const model = process.env.SOCIAL_DRAFT_MODEL || DEFAULT_DRAFT_MODEL;
  const st = STADIER[stadium] ? stadium : 'marknadsdata';

  const user =
    `KÄLLA: ${sourceLabel}\n` +
    `STATUS: ${STADIER[st].etikett}\n` +
    `TITEL: ${candidate.title}\n` +
    (candidate.dateText ? `DATUM: ${candidate.dateText}\n` : '') +
    `URL: ${candidate.url}\n\n` +
    `UNDERLAG (utdrag ur källan):\n${articleText || '(kunde inte hämtas — bedöm utifrån titeln, och sätt relevant=false om den inte räcker)'}`;

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
        system: suggestSystemFor(st),
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
  const variants = (Array.isArray(out.variants) ? out.variants : [])
    .map(v => ({ label: String((v && v.label) || 'Variant'), text: String((v && v.text) || '').trim() }))
    .filter(v => v.text);
  return {
    relevant: !!out.relevant,
    reason: String(out.reason || ''),
    variants,
    imageHint: String(out.image_hint || ''),
    stadium: st,
    varning: granskaStadiepastaende(st, variants, articleText),
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
// `opts.budgetMs` styr hur länge nya objekt får startas. Den SCHEMALAGDA
// körningen (social-watch) har lång funktionstimeout och kan ta det lugnt;
// den manuella "Hämta nu" går genom ett synkront API-anrop och måste hålla
// sig innanför funktionstaket. Med fyra källor — varav riksdagens är trög
// från Netlify — räckte inte den gamla gemensamma budgeten på 6 s.
async function runWatch(opts = {}) {
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : TIME_BUDGET_MS;
  const started = Date.now();
  const log = { ran: new Date().toISOString(), sources: 0, candidates: 0, nya: 0, tillagda: 0, irrelevanta: 0, seedade: 0, varningar: 0, errors: [] };

  const state = await readState();
  let changed = false;

  for (const source of SOURCES) {
    log.sources++;
    let candidates;
    try {
      candidates = await source.hamta();
    } catch (e) {
      log.errors.push(`${source.id}: ${e.message}`);
      continue; // en källas fel ska inte stoppa övriga
    }
    log.candidates += candidates.length;

    const keyOf = c => `${source.id}:${c.id}`;
    const isSeeding = !Object.keys(state.seen).some(k => k.startsWith(source.id + ':'));

    // Dubblettskydd oberoende av seen-listan: en kandidat som redan ligger i
    // kön ska aldrig bli ett andra förslag, inte ens om källan sås om.
    const iKon = new Set(state.items.map(it => it && it.id));
    let fresh = candidates.filter(c => !state.seen[keyOf(c)] && !iKon.has(keyOf(c)));
    // Sådd bara när källan FAKTISKT gav kandidater. Utan längdkontrollen
    // markerades en tom körning som en förändring, och en källa som ligger
    // nere hade gett en onödig commit varje dygn.
    if (isSeeding && candidates.length) {
      // Så: markera historiken sedd, bearbeta bara det senaste (första i
      // listan) som ett första exempel-förslag så kedjan syns direkt i kön.
      //
      // Exempelposten markeras INTE sedd här — det sker först när den faktiskt
      // bearbetats. Annars tappas den tyst om tidsbudgeten eller ett fel slår
      // till emellan, och då kommer den aldrig tillbaka (hände skarpt med
      // propositionen 2026-08-18).
      // Exempelposten måste också respektera dubblettskyddet — annars ger en
      // omsådd (glomKalla) ett andra förslag för samma dokument.
      fresh = candidates.filter(c => !iKon.has(keyOf(c))).slice(0, 1);
      const sparas = new Set(fresh.map(keyOf));
      for (const c of candidates) {
        if (!sparas.has(keyOf(c))) state.seen[keyOf(c)] = new Date().toISOString();
      }
      log.seedade += Math.max(0, candidates.length - fresh.length);
      changed = true;
    }
    log.nya += fresh.length;

    let processed = 0;
    for (const c of fresh) {
      if (processed >= MAX_NEW_PER_RUN) break;
      if (Date.now() - started > budget) {
        log.errors.push(`${source.id}: tidsbudgeten nådd — ${fresh.length - processed} kandidat(er) väntar till nästa körning`);
        break;
      }
      processed++;
      try {
        let articleText = '';
        try {
          articleText = await fetchUnderlag(c);
        } catch (e) {
          log.errors.push(`${source.id}/${c.id}: underlagshämtning: ${e.message}`);
        }
        const suggestion = await suggestPost(c, articleText, source.label, source.stadium);
        if (suggestion.varning) log.varningar++;
        state.items.unshift({
          id: `${source.id}:${c.id}`,
          source: source.id,
          sourceLabel: source.label,
          stadium: suggestion.stadium,
          stadiumEtikett: (STADIER[suggestion.stadium] || {}).etikett || '',
          varning: suggestion.varning || null,
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

// Driftverktyg: nollställ sådd-markeringen för EN källa så nästa körning sår
// om den och tar fram ett nytt exempel-förslag. Poster i kön rörs inte (de
// skyddas dessutom av dubblettkontrollen ovan). Används när en källa behöver
// köras om — t.ex. efter att en kandidat tappats.
async function glomKalla(sourceId) {
  const state = await readState();
  const prefix = `${sourceId}:`;
  const fore = Object.keys(state.seen).length;
  for (const k of Object.keys(state.seen)) {
    if (k.startsWith(prefix)) delete state.seen[k];
  }
  const bortglomda = fore - Object.keys(state.seen).length;
  if (bortglomda) {
    pushHistorik(state, { action: 'glömd-källa', id: sourceId, note: `${bortglomda} markeringar nollställda` });
    await writeState(state, `Sociala förslag: sår om ${sourceId}`);
  }
  return { sourceId, bortglomda };
}

module.exports = {
  FILE_PATH,
  SOURCES,
  STADIER,
  glomKalla,
  MAX_ITEMS,
  htmlToText,
  parseMaklarstatistik,
  parseFmiNyheter,
  riksdagSok,
  granskaStadiepastaende,
  fetchArticleText,
  fetchUnderlag,
  suggestPost,
  normalizeState,
  pushHistorik,
  readState,
  writeState,
  runWatch,
};
