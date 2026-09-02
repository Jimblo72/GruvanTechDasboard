// netlify/functions/lib/seo.js
// SEO-motorn: hämtar ett läge för en sajt, jämför mot förra gången och lämnar
// ifrån sig underlag som Claude kan analysera.
//
// EN motor för flera sajter. Skillnaden mellan sajterna är inte tekniken utan
// vem som kan ändra dem: maklargruvan.se ligger i ett repo vi äger, peakfast.se
// driftas av Prowebb och Jimmy har ingen CMS-åtkomst. Därför bär varje sajt ett
// `utforare`-fält som säger vad ett godkänt förslag ska bli — en PR eller ett
// mejlunderlag. Registret ligger i kod, inte i data: att lägga till qvickr.com
// ska vara en rad i en granskad commit, inte ett formulär.
//
// Miljövariabler (alla frivilliga — motorn degraderar i stället för att falla):
//   PAGESPEED_API_KEY            höjer PageSpeed-kvoten (utan nyckel delas en
//                                anonym kvot med hela världen → 429 i perioder)
//   GSC_CLIENT_ID / _SECRET      OAuth för Search Console
//   GSC_REFRESH_TOKEN            samma konto som äger egendomarna

const UA = 'GruvanTechDashboard-SEO/1.0 (+https://gruvantechdashboard.netlify.app)';

// Tak per sajt. peakfast.se har ~15 sidor i sitemapen plus objektsidor; utan
// tak skulle en objektexplosion göra körningen oändlig.
const MAX_SIDOR = 25;
const HAMTA_TIMEOUT_MS = 12000;

// Adresser i en sitemap som inte är sidor. peakfast.se listar sin favicon där.
const ICKE_SIDA = /\.(ico|png|jpe?g|gif|webp|svg|css|js|pdf|zip|xml|txt|woff2?|ttf|mp4|webm)(\?|$)/i;

const SAJTER = {
  maklargruvan: {
    id: 'maklargruvan',
    namn: 'maklargruvan.se',
    bas: 'https://maklargruvan.se',
    gscEgendom: 'sc-domain:maklargruvan.se',   // domän-egendom, inte URL-prefix
    utforare: 'pr',
    repo: 'Jimblo72/maklargruvan-landing',
    kontext:
      'Marknadssajt för Mäklargruvan, ett verktyg som säljs till svenska fastighetsmäklare ' +
      'och mäklarkontor. En enda sida plus en integritetspolicy. Målgruppen är mäklare och ' +
      'kontorschefer, inte bostadsköpare. Positioneringen är verktyg först och AI nedtonat.',
  },
  peakfast: {
    id: 'peakfast',
    namn: 'peakfast.se',
    bas: 'https://www.peakfast.se',
    gscEgendom: 'sc-domain:peakfast.se',
    utforare: 'underlag',                       // Prowebb äger CMS:et
    repo: null,
    kontext:
      'Mäklarbyrå i Åre som förmedlar bostäder, tomter och andelsrätter i fjällen. ' +
      'Sajten är byggd och driftad av webbyrån Prowebb; vi kan inte ändra HTML själva. ' +
      'Nischen är andelsboende och fjälldestinationer, och det är där tillväxten finns.',
  },
};

// ── små hjälpare ────────────────────────────────────────────────────────────

async function hamta(url, extra = {}) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...(extra.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(extra.timeoutMs || HAMTA_TIMEOUT_MS),
    ...extra,
  });
}

// Regex mot HTML är inte vackert, men repot är beroendefritt med flit och en
// DOM-parser hade dragit in en hel trädstruktur för sex fält. Måsten: alltid
// tåla att taggen saknas, aldrig kasta.
function tagg(html, re) {
  const m = html.match(re);
  return m ? String(m[1]).trim() : null;
}

function avkoda(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// ── sidanalys ───────────────────────────────────────────────────────────────

function analyseraSida(url, html, status) {
  const titel = avkoda(tagg(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const beskrivning = avkoda(
    tagg(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    tagg(html, /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)
  );
  const h1ar = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map(m => avkoda(m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter(Boolean);

  // Brödtext utan skript, stil och taggar. Grov men jämförbar mellan körningar,
  // vilket är det enda vi använder den till.
  const brodtext = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const bilder = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  // alt="" är KORREKT på dekorativa bilder och ska inte räknas som fel. Den
  // lärdomen kostade en felrapport i etapp 1: en tom alt med aria-hidden är
  // rätt gjort, det är avsaknaden av attributet som är problemet.
  const bilderUtanAlt = bilder.filter(t => !/\balt\s*=/i.test(t)).length;

  return {
    url,
    status,
    titel,
    titelLangd: titel ? titel.length : 0,
    beskrivning,
    beskrivningLangd: beskrivning ? beskrivning.length : 0,
    h1: h1ar,
    antalH1: h1ar.length,
    antalH2: (html.match(/<h2\b/gi) || []).length,
    ord: brodtext ? brodtext.split(' ').length : 0,
    canonical: tagg(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i),
    ogTitel: tagg(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i),
    ogBild: tagg(html, /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']*)["']/i),
    harStrukturdata: /application\/ld\+json/i.test(html),
    antalBilder: bilder.length,
    bilderUtanAlt,
    sprak: tagg(html, /<html[^>]+lang=["']([^"']*)["']/i),
    noindex: /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html),
    byte: html.length,
  };
}

// ── sitemap och robots ──────────────────────────────────────────────────────

async function lasRobots(bas) {
  try {
    const r = await hamta(`${bas}/robots.txt`);
    if (!r.ok) return { finns: false, status: r.status, sitemaps: [] };
    const text = await r.text();
    const sitemaps = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]);
    return { finns: true, status: r.status, sitemaps, rader: text.split('\n').length };
  } catch (e) {
    return { finns: false, fel: e.message, sitemaps: [] };
  }
}

async function lasSitemap(url, djup = 0) {
  // Sitemapindex pekar på fler sitemaps. Ett djup räcker för våra sajter och
  // hindrar att en felkonfigurerad självrefererande index-fil loopar.
  try {
    const r = await hamta(url);
    if (!r.ok) return { url, finns: false, status: r.status, urler: [] };
    const xml = await r.text();
    const barn = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi)].map(m => m[1].trim());
    if (barn.length && djup < 1) {
      const alla = [];
      for (const b of barn.slice(0, 5)) {
        const under = await lasSitemap(b, djup + 1);
        alla.push(...under.urler);
      }
      return { url, finns: true, status: r.status, index: true, urler: alla };
    }
    const urler = [...xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/gi)].map(m => ({
      loc: m[1].trim(),
      lastmod: (m[2].match(/<lastmod>([^<]+)<\/lastmod>/i) || [])[1] || null,
    }));
    return { url, finns: true, status: r.status, urler };
  } catch (e) {
    return { url, finns: false, fel: e.message, urler: [] };
  }
}

// ── PageSpeed ───────────────────────────────────────────────────────────────

async function hamtaPageSpeed(url) {
  const nyckel = process.env.PAGESPEED_API_KEY;
  const q = new URLSearchParams({ url, strategy: 'mobile' });
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach(c => q.append('category', c));
  if (nyckel) q.set('key', nyckel);
  try {
    const r = await hamta(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { timeoutMs: 60000 });
    const d = await r.json();
    if (!d.lighthouseResult) {
      // 429 utan nyckel är vanligt och betyder inte att sajten är trasig.
      return { fel: d.error?.message?.slice(0, 160) || `HTTP ${r.status}`, harNyckel: !!nyckel };
    }
    const c = d.lighthouseResult.categories || {};
    const a = d.lighthouseResult.audits || {};
    const poang = k => (c[k] && c[k].score != null ? Math.round(c[k].score * 100) : null);
    return {
      prestanda: poang('performance'),
      seo: poang('seo'),
      tillganglighet: poang('accessibility'),
      praxis: poang('best-practices'),
      lcp: a['largest-contentful-paint']?.displayValue || null,
      cls: a['cumulative-layout-shift']?.displayValue || null,
      vikt: a['total-byte-weight']?.displayValue || null,
      harNyckel: !!nyckel,
    };
  } catch (e) {
    return { fel: e.message, harNyckel: !!nyckel };
  }
}

// ── Search Console ──────────────────────────────────────────────────────────

function gscKonfigurerad() {
  return !!(process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET && process.env.GSC_REFRESH_TOKEN);
}

async function gscToken() {
  const r = await hamta('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GSC_CLIENT_ID,
      client_secret: process.env.GSC_CLIENT_SECRET,
      refresh_token: process.env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token-fel: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

// Hela Search Console-delen är valfri. Saknas nycklarna svarar den null och
// resten av körningen fortsätter — samma princip som tomt PIXEL_ID på
// landningssidan: hellre en funktion som vilar än en som halvfungerar.
async function hamtaSearchConsole(sajt, dagar = 28) {
  if (!gscKonfigurerad()) return null;
  const slut = new Date(); slut.setDate(slut.getDate() - 2);   // GSC släpar ~2 dygn
  const start = new Date(slut); start.setDate(start.getDate() - dagar);
  const fmt = d => d.toISOString().slice(0, 10);
  const bas = 'https://searchconsole.googleapis.com/webmasters/v3/sites';
  const egendom = encodeURIComponent(sajt.gscEgendom);

  try {
    const token = await gscToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const fraga = async (dimensions, rowLimit) => {
      const r = await hamta(`${bas}/${egendom}/searchAnalytics/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ startDate: fmt(start), endDate: fmt(slut), dimensions, rowLimit }),
        timeoutMs: 20000,
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.rows || [];
    };
    const [sokord, sidor] = await Promise.all([fraga(['query'], 40), fraga(['page'], 25)]);
    const summa = sokord.reduce((a, r) => ({
      klick: a.klick + (r.clicks || 0),
      visningar: a.visningar + (r.impressions || 0),
    }), { klick: 0, visningar: 0 });
    return {
      period: { fran: fmt(start), till: fmt(slut), dagar },
      summa,
      sokord: sokord.map(r => ({
        ord: r.keys[0], klick: r.clicks, visningar: r.impressions,
        ctr: +(r.ctr * 100).toFixed(1), position: +r.position.toFixed(1),
      })),
      sidor: sidor.map(r => ({
        sida: r.keys[0], klick: r.clicks, visningar: r.impressions,
        ctr: +(r.ctr * 100).toFixed(1), position: +r.position.toFixed(1),
      })),
    };
  } catch (e) {
    return { fel: e.message };
  }
}

// ── ögonblicksbild ──────────────────────────────────────────────────────────

async function byggOgonblicksbild(sajtId, opts = {}) {
  const sajt = SAJTER[sajtId];
  if (!sajt) throw new Error(`Okänd sajt: ${sajtId}`);
  const start = Date.now();

  const robots = await lasRobots(sajt.bas);
  const sitemapUrl = robots.sitemaps[0] || `${sajt.bas}/sitemap.xml`;
  const sitemap = await lasSitemap(sitemapUrl);

  // Utan sitemap finns ändå startsidan att mäta. Att inte ha någon är i sig
  // ett fynd, inte ett skäl att ge upp körningen.
  //
  // Filtret finns för att peakfast.se listar `favicon.ico` i sin sitemap. Utan
  // det analyseras en ikon som om den vore en sida, och Claude får en rad med
  // "titel saknas, beskrivning saknas, 0 ord" att föreslå åtgärder för. Brus
  // som ser ut som fynd är värre än inget fynd alls.
  const alla = sitemap.urler.map(u => u.loc);
  const sidUrler = alla.filter(u => !ICKE_SIDA.test(u));
  const urler = (sidUrler.length ? sidUrler : [`${sajt.bas}/`]).slice(0, MAX_SIDOR);
  const bortfiltrerade = alla.length - sidUrler.length;

  const sidor = [];
  for (const url of urler) {
    try {
      const r = await hamta(url);
      const html = r.ok ? await r.text() : '';
      sidor.push(analyseraSida(url, html, r.status));
    } catch (e) {
      sidor.push({ url, status: 0, fel: e.message });
    }
  }

  const [pagespeed, gsc] = await Promise.all([
    opts.hoppaPageSpeed ? Promise.resolve(null) : hamtaPageSpeed(`${sajt.bas}/`),
    hamtaSearchConsole(sajt),
  ]);

  return {
    sajt: sajt.id,
    namn: sajt.namn,
    tid: new Date().toISOString(),
    varaktighetMs: Date.now() - start,
    robots,
    sitemap: {
      url: sitemap.url, finns: sitemap.finns, status: sitemap.status,
      antal: sitemap.urler.length,
      bortfiltrerade,
      // Stale lastmod är ett verkligt fynd (peakfast.se hade 6 mars på allt).
      senasteLastmod: sitemap.urler.map(u => u.lastmod).filter(Boolean).sort().pop() || null,
    },
    sidor,
    pagespeed,
    gsc,
  };
}

// ── jämförelse ──────────────────────────────────────────────────────────────

// Diffen är själva poängen med att spara historik: en lista på vad som ÄNDRATS
// sedan sist är mycket kortare och mer handlingsbar än hela läget en gång till.
function jamfor(ny, gammal) {
  if (!gammal) return { forsta: true, andringar: [] };
  const andringar = [];
  const kartaG = new Map((gammal.sidor || []).map(s => [s.url, s]));
  const kartaN = new Map((ny.sidor || []).map(s => [s.url, s]));

  for (const [url, s] of kartaN) {
    const g = kartaG.get(url);
    if (!g) { andringar.push({ typ: 'ny-sida', url }); continue; }
    if (s.titel !== g.titel) andringar.push({ typ: 'titel', url, fran: g.titel, till: s.titel });
    if (s.beskrivning !== g.beskrivning) andringar.push({ typ: 'beskrivning', url, fran: g.beskrivning, till: s.beskrivning });
    if (s.status !== g.status) andringar.push({ typ: 'status', url, fran: g.status, till: s.status });
    if (s.noindex !== g.noindex) andringar.push({ typ: 'noindex', url, fran: g.noindex, till: s.noindex });
    // Ordantal rör sig alltid några procent; först en tydlig förändring är nyhet.
    if (g.ord && Math.abs(s.ord - g.ord) / g.ord > 0.2) andringar.push({ typ: 'textmangd', url, fran: g.ord, till: s.ord });
  }
  for (const url of kartaG.keys()) if (!kartaN.has(url)) andringar.push({ typ: 'borttagen-sida', url });

  const p1 = ny.pagespeed, p0 = gammal.pagespeed;
  if (p1 && p0 && p1.prestanda != null && p0.prestanda != null && Math.abs(p1.prestanda - p0.prestanda) >= 5) {
    andringar.push({ typ: 'prestanda', fran: p0.prestanda, till: p1.prestanda });
  }
  if (ny.gsc && gammal.gsc && ny.gsc.summa && gammal.gsc.summa) {
    const dk = ny.gsc.summa.klick - gammal.gsc.summa.klick;
    if (Math.abs(dk) >= 5) andringar.push({ typ: 'klick', fran: gammal.gsc.summa.klick, till: ny.gsc.summa.klick });
  }
  return { forsta: false, sedan: gammal.tid, andringar };
}

module.exports = {
  SAJTER, MAX_SIDOR,
  byggOgonblicksbild, jamfor,
  hamtaPageSpeed, hamtaSearchConsole, gscKonfigurerad,
  analyseraSida, lasRobots, lasSitemap,
};
