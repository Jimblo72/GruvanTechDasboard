// netlify/functions/lib/seo-analys.js
// Låter Claude läsa en ögonblicksbild från lib/seo.js och föreslå åtgärder.
//
// TVÅ SAKER SOM STYR HELA DESIGNEN, båda dyrköpta:
//
// 1. FAKTAGRUNDNING. I AdsControl bad vi en modell om SEO-förslag utifrån bara
//    sökord och produktnamn. Den hittade på vad produkterna var ("balanscykel"
//    blev "Balance Beams") och föreslog titlar med falska påståenden. Här får
//    modellen därför sidans FAKTISKA titel, beskrivning, rubriker och ordantal,
//    och instrueras uttryckligen att hellre lämna ett fält orört än att gissa.
//
// 2. STRUKTURERAT SVAR VIA TOOL. AdsControl bad om "ren JSON utan backticks"
//    och fick ändå backticks, vilket krävde regex-räddning som ibland sprack.
//    Anthropics tool-schema gör formatet till API:ts ansvar i stället för
//    promptens. Samma mönster som lib/social.js.
//
// Miljövariabler: ANTHROPIC_API_KEY (+ SEO_ANALYS_MODELL för att byta modell).

const DEFAULT_MODELL = 'claude-sonnet-5';

const ATGARD_TOOL = {
  name: 'rapportera_seo_atgarder',
  description: 'Rapportera prioriterade SEO-åtgärder enligt schemat.',
  input_schema: {
    type: 'object',
    properties: {
      sammanfattning: {
        type: 'string',
        description: 'Två till fyra meningar om sajtens läge. Svenska. Konkret, inga floskler.',
      },
      atgarder: {
        type: 'array',
        maxItems: 8,
        description: 'Prioriterade åtgärder, viktigast först. Färre och säkra slår fler och osäkra.',
        items: {
          type: 'object',
          properties: {
            rubrik: { type: 'string', description: 'Kort rubrik, max 70 tecken.' },
            typ: {
              type: 'string',
              enum: ['titel', 'beskrivning', 'rubriker', 'innehall', 'teknik', 'prestanda', 'lankar'],
              description: 'Vad åtgärden rör.',
            },
            url: { type: 'string', description: 'Sidan åtgärden gäller. Tom sträng om den gäller hela sajten.' },
            // Kontraktet är avsiktligt snävt: "nuvarande" får BARA innehålla ett
            // värde som står ordagrant i underlaget. Då går fältet att kontrollera
            // maskinellt mot underlaget, vilket är hela skyddet mot påhittade
            // "före"-värden. Beskrivningar av ett läge hör hemma i motiveringen.
            nuvarande: {
              type: 'string',
              description: 'Nuvarande värde ORDAGRANT ur underlaget (t.ex. den exakta titeln). ' +
                'Är åtgärden inte ett byte av ett befintligt värde ska fältet vara TOMT — ' +
                'beskriv läget i motiveringen i stället. Skriv aldrig en egen sammanfattning här.',
            },
            foreslaget: { type: 'string', description: 'Föreslaget nytt värde. Tom sträng när åtgärden inte är ett textbyte.' },
            motivering: { type: 'string', description: 'Varför. En till två meningar, på svenska.' },
            vikt: { type: 'string', enum: ['hog', 'medel', 'lag'], description: 'Förväntad effekt.' },
          },
          required: ['rubrik', 'typ', 'url', 'nuvarande', 'foreslaget', 'motivering', 'vikt'],
        },
      },
    },
    required: ['sammanfattning', 'atgarder'],
  },
};

function system(sajt) {
  const utforare = sajt.utforare === 'pr'
    ? 'Ett godkänt förslag blir en kodändring i sajtens repo. Föreslå därför exakta färdiga värden.'
    : 'Sajten driftas av webbyrån Prowebb och vi kan INTE ändra HTML själva. Ett godkänt förslag blir ' +
      'ett mejlunderlag till dem. Skriv därför förslagen så att en utomstående kan utföra dem utan ' +
      'att känna till vår diskussion, och föreslå inget som kräver att man bygger om sajten.';

  return [
    'Du är SEO-specialist och granskar en svensk webbplats åt dess ägare.',
    '',
    `SAJTEN: ${sajt.namn}. ${sajt.kontext}`,
    '',
    `UTFÖRANDE: ${utforare}`,
    '',
    'ABSOLUTA REGLER:',
    '- Utgå ENBART från underlaget nedan. Hitta aldrig på vad en sida innehåller.',
    '- Fältet "nuvarande" måste vara ordagrant ur underlaget, eller tomt om värdet saknas.',
    '- Är du osäker på vad en sida handlar om: föreslå ingen textändring för den sidan.',
    '- Bättre noll åtgärder än en åtgärd som bygger på en gissning.',
    '- Föreslå aldrig sökordsstoppning. Texten ska läsas av människor.',
    '- Påstå inget om trafik eller placeringar om Search Console-data saknas i underlaget.',
    '',
    'PRIORITERA efter förväntad effekt: saker som blockerar indexering först, sedan',
    'titlar och beskrivningar på sidor som redan får visningar, sedan innehåll, sist kosmetika.',
  ].join('\n');
}

// Underlaget hålls kompakt med flit: hela HTML-dumpar hade sprängt kontexten
// utan att tillföra något modellen kan agera på.
function bygguUnderlag(bild, diff) {
  const rader = [];
  rader.push(`LÄGE HÄMTAT: ${bild.tid}`);
  rader.push(`robots.txt: ${bild.robots.finns ? 'finns' : 'SAKNAS'}${bild.robots.sitemaps?.length ? ` (pekar ut ${bild.robots.sitemaps.length} sitemap)` : ''}`);
  rader.push(`sitemap: ${bild.sitemap.finns ? `${bild.sitemap.antal} adresser, senaste lastmod ${bild.sitemap.senasteLastmod || 'okänd'}` : 'SAKNAS'}`);
  if (bild.sitemap.bortfiltrerade) {
    rader.push(`  (${bild.sitemap.bortfiltrerade} adress(er) i sitemapen är filer, inte sidor — t.ex. bilder eller ikoner. De hör normalt inte hemma i en sitemap.)`);
  }

  if (bild.pagespeed && !bild.pagespeed.fel) {
    const p = bild.pagespeed;
    rader.push(`PageSpeed mobil startsida: prestanda ${p.prestanda}, seo ${p.seo}, tillgänglighet ${p.tillganglighet}, LCP ${p.lcp}, CLS ${p.cls}, vikt ${p.vikt}`);
  } else if (bild.pagespeed?.fel) {
    rader.push(`PageSpeed: kunde inte mätas (${bild.pagespeed.fel})`);
  }

  if (bild.gsc && !bild.gsc.fel) {
    rader.push('', `SEARCH CONSOLE ${bild.gsc.period.fran}–${bild.gsc.period.till}: ${bild.gsc.summa.klick} klick, ${bild.gsc.summa.visningar} visningar`);
    rader.push('Toppsökord (ord | klick | visningar | ctr% | position):');
    bild.gsc.sokord.slice(0, 25).forEach(s => rader.push(`  ${s.ord} | ${s.klick} | ${s.visningar} | ${s.ctr} | ${s.position}`));
    rader.push('Toppsidor:');
    bild.gsc.sidor.slice(0, 15).forEach(s => rader.push(`  ${s.sida} | ${s.klick} | ${s.visningar} | ${s.ctr} | ${s.position}`));
  } else {
    rader.push('', 'SEARCH CONSOLE: inte kopplad — uttala dig INTE om trafik, placeringar eller vad folk söker på.');
  }

  rader.push('', `SIDOR (${bild.sidor.length} st):`);
  for (const s of bild.sidor) {
    if (s.fel) { rader.push(`- ${s.url} → kunde inte hämtas (${s.fel})`); continue; }
    rader.push(
      `- ${s.url} [HTTP ${s.status}${s.noindex ? ', NOINDEX' : ''}]`,
      `    titel (${s.titelLangd}): ${s.titel || '(SAKNAS)'}`,
      `    beskrivning (${s.beskrivningLangd}): ${s.beskrivning || '(SAKNAS)'}`,
      `    h1: ${s.h1.length ? s.h1.join(' / ') : '(SAKNAS)'} | h2: ${s.antalH2} | ord: ${s.ord}`,
      `    canonical: ${s.canonical || '(saknas)'} | og:title: ${s.ogTitel ? 'ja' : 'nej'} | strukturdata: ${s.harStrukturdata ? 'ja' : 'nej'}` +
      `${s.bilderUtanAlt ? ` | ${s.bilderUtanAlt} av ${s.antalBilder} bilder saknar alt-attribut` : ''}`
    );
  }

  if (diff && !diff.forsta && diff.andringar.length) {
    rader.push('', `ÄNDRAT SEDAN FÖRRA KÖRNINGEN (${diff.sedan}):`);
    diff.andringar.slice(0, 30).forEach(a => rader.push(`  ${a.typ}${a.url ? ' ' + a.url : ''}: ${a.fran ?? '-'} → ${a.till ?? '-'}`));
  } else if (diff && diff.forsta) {
    rader.push('', 'Detta är första körningen — ingen historik att jämföra mot.');
  }

  return rader.join('\n');
}

// Verktygsschemat säger att atgarder är en array, och lokalt var den alltid
// det. I den första skarpa körningen var den något annat, och koden dog på
// "map is not a function" — ett fel som inte säger någonting om vad som hänt.
//
// Lärdomen är generell: ett schema styr modellen, det garanterar inte formen.
// Allt som kommer ur ett modellsvar ska normaliseras innan det används, även
// när API:t lovat en typ.
function normaliseraAtgarder(v) {
  if (Array.isArray(v)) return v.filter(a => a && typeof a === 'object');
  if (v && typeof v === 'object') {
    // Ett ensamt objekt är en åtgärd; ett objekt med numeriska nycklar är en
    // array som tappat sin form på vägen.
    const varden = Object.values(v);
    if (varden.length && varden.every(x => x && typeof x === 'object')) return varden;
    return [v];
  }
  return [];
}

async function analysera(sajt, bild, diff) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY saknas i Netlify environment variables');
  const modell = process.env.SEO_ANALYS_MODELL || DEFAULT_MODELL;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modell,
      max_tokens: 4000,
      system: system(sajt),
      tools: [ATGARD_TOOL],
      tool_choice: { type: 'tool', name: 'rapportera_seo_atgarder' },
      messages: [{ role: 'user', content: bygguUnderlag(bild, diff) }],
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();

  // Ett avbrott på max_tokens ger ett HALVT verktygsanrop. Det måste bli ett
  // begripligt fel här, annars visar sig samma sak längre ned som något
  // kryptiskt om att en array inte är en array.
  if (d.stop_reason === 'max_tokens') {
    throw new Error('Svaret klipptes vid max_tokens — höj taket eller be om färre åtgärder.');
  }

  const block = (d.content || []).find(b => b.type === 'tool_use');
  if (!block) throw new Error('Modellen svarade utan strukturerat resultat');

  // Faktagrundningsvakt. "nuvarande" ska enligt schemat vara ordagrant ur
  // underlaget, så ett värde som inte går att hitta där är per definition
  // något modellen skrivit själv. Vi RADERAR inte åtgärden — den kan vara
  // riktig ändå — men vi tömmer det obekräftade fältet och flaggar posten, så
  // att ingen läser ett påhittat "före"-värde som om det vore avläst.
  const underlag = bygguUnderlag(bild, diff);
  const atgarder = normaliseraAtgarder(block.input.atgarder).map(a => {
    if (a.nuvarande && !underlag.includes(a.nuvarande)) {
      return { ...a, nuvarande: '', obekraftadNulage: true };
    }
    return a;
  });

  return {
    ...block.input,
    // Schemat kräver sammanfattning, men modellen utelämnade den i en av de
    // skarpa körningarna. Ett obligatoriskt fält i ett schema är en instruktion,
    // inte en garanti — behandla varje fält som frånvarande tills motsatsen
    // bevisats.
    sammanfattning: typeof block.input.sammanfattning === 'string' && block.input.sammanfattning.trim()
      ? block.input.sammanfattning
      : `${atgarder.length} förslag. (Modellen lämnade ingen sammanfattning.)`,
    atgarder,
    modell,
  };
}

module.exports = { analysera, bygguUnderlag, DEFAULT_MODELL };
