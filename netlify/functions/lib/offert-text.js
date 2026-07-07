// netlify/functions/lib/offert-text.js
// Deterministisk offerttext för andelsförsäljning (Mail-hubbens kategori
// offert_andelsratt). Innehållet kommer från data/offert-mall-andel.json —
// Jimmys ENDA redigeringsställe för priser/tjänster i auto-offerten — med en
// hårdkodad kopia av samma defaults som fallback om filen inte kan läsas.
//
// KRITISKT: alla belopp kommer ordagrant från mallen (JSON eller fallback).
// LLM:en får ALDRIG generera eller ändra priser — den lämnar bara en
// [OFFERT]-token där blocket ska in, och insertOffertBlock() gör bytet.
//
// CommonJS, zero-dependency (samma mönster som övriga lib-filer).

const { readJsonFile } = require('./store');

const ANDEL_MALL_PATH = 'data/offert-mall-andel.json';
const OFFERT_TOKEN = '[OFFERT]';

// Hårdkodad kopia av data/offert-mall-andel.json (håll i synk vid ändringar).
// Beloppen speglar offert.html:s Andelsrätt-läge: fast 37 500 kr (alt 40 000 kr),
// alltid inkl. moms; foto/drönare ingår inte vid andelsförsäljning.
const DEFAULT_ANDEL_MALL = {
  rubrik: 'Försäljning av andelsrätt — vad som ingår',
  arvode: {
    belopp: 37500,
    alt_belopp: 40000,
    moms: 'inkl. moms',
    beskrivning: 'oavsett slutlig köpeskilling',
  },
  ingar: [
    { namn: 'Hemnet', beskrivning: 'Annonsering på Hemnet – exponering mot tusentals köpare' },
    { namn: 'Booli', beskrivning: 'Annonsering på Booli' },
    { namn: 'Boneo', beskrivning: 'Annonsering på Boneo – prisjämförelse och bostadsguide' },
    { namn: 'Facebook', beskrivning: 'Riktad annonsering på Facebook mot relevanta köpargrupper' },
    { namn: 'Visningar och kontraktsskrivning', beskrivning: 'Visningar, kontraktsskrivning och hela försäljningsprocessen från annons till tillträde' },
  ],
  notering: 'Vid andelsförsäljning ingår inte fotografering, drönarbilder eller drönarvideo — befintliga bilder används.',
};

// Formaterar belopp med svenskt tusentalsmellanrum (37500 → "37 500").
// Medvetet manuell (inte toLocaleString) så resultatet är deterministiskt och
// använder vanligt mellanslag oavsett Node/ICU-version.
function formatSek(n) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num)) return String(n);
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Läser offertmallen från repot (samma readJsonFile-mönster som
// data/mail-style.json). Faller tillbaka på DEFAULT_ANDEL_MALL om filen
// saknas, är ogiltig eller GitHub-läsningen fallerar — utkast ska alltid funka.
async function loadAndelMall() {
  try {
    const { data } = await readJsonFile(ANDEL_MALL_PATH, null);
    if (data && data.arvode && Number.isFinite(Number(data.arvode.belopp))) {
      return data;
    }
  } catch (_) { /* ignorera — faller tillbaka på defaults */ }
  return DEFAULT_ANDEL_MALL;
}

// Bygger offertblocket som ren text från mallen. Ingen LLM inblandad —
// samma mall ger alltid exakt samma text.
function buildAndelOffertText(mall) {
  const m = mall && typeof mall === 'object' ? mall : DEFAULT_ANDEL_MALL;
  const arv = m.arvode && typeof m.arvode === 'object' ? m.arvode : DEFAULT_ANDEL_MALL.arvode;

  const belopp = Number.isFinite(Number(arv.belopp)) ? Number(arv.belopp) : DEFAULT_ANDEL_MALL.arvode.belopp;
  const alt = Number(arv.alt_belopp) || 0;
  const moms = String(arv.moms || 'inkl. moms').trim();
  const besk = String(arv.beskrivning || '').trim();

  let arvodeLine = `Fast arvode: ${formatSek(belopp)} kr ${moms}`;
  if (alt) arvodeLine += ` (alternativt ${formatSek(alt)} kr beroende på upplägg)`;
  arvodeLine += besk ? ` — ${besk.replace(/\.+$/, '')}.` : '.';

  const items = Array.isArray(m.ingar) ? m.ingar : DEFAULT_ANDEL_MALL.ingar;
  const rows = items
    .map(i => String((i && (i.beskrivning || i.namn)) || '').trim())
    .filter(Boolean)
    .map(t => `- ${t}`);

  const parts = ['Så här ser vårt upplägg ut för andelsförsäljning:', arvodeLine];
  if (rows.length) parts.push('I arvodet ingår bl.a.:\n' + rows.join('\n'));
  const notering = String(m.notering || '').trim();
  if (notering) parts.push(notering);

  return parts.join('\n\n');
}

// Sätter in offertblocket i LLM-utkastet:
//   1) Finns [OFFERT]-tokenen → ersätt FÖRSTA förekomsten med blocket och
//      strippa eventuella extra tokens (aldrig duplicera offerten).
//   2) Saknas tokenen → lägg blocket före sign-offen ("Med vänlig hälsning").
//   3) Saknas även sign-offen → lägg blocket sist.
// Blocket tappas aldrig och dupliceras aldrig.
function insertOffertBlock(draftText, offertBlock) {
  const text = String(draftText || '');
  const block = String(offertBlock || '').trim();
  if (!block) return text;
  if (text.includes(block)) return text; // redan på plats — duplicera inte

  const idx = text.indexOf(OFFERT_TOKEN);
  if (idx >= 0) {
    const before = text.slice(0, idx).replace(/[ \t]*$/, '');
    // Strippa ev. ytterligare tokens efter den första.
    const after = text.slice(idx + OFFERT_TOKEN.length).split(OFFERT_TOKEN).join('');
    return `${before.replace(/\n*$/, '')}\n\n${block}\n\n${after.replace(/^\n*/, '')}`.trim();
  }

  // Fallback: före sign-offen, aldrig efter den.
  const signOffIdx = text.lastIndexOf('Med vänlig hälsning');
  if (signOffIdx >= 0) {
    const before = text.slice(0, signOffIdx).replace(/\n*$/, '');
    return `${before}\n\n${block}\n\n${text.slice(signOffIdx)}`.trim();
  }

  return `${text.replace(/\n*$/, '')}\n\n${block}`.trim();
}

module.exports = {
  ANDEL_MALL_PATH,
  OFFERT_TOKEN,
  DEFAULT_ANDEL_MALL,
  formatSek,
  loadAndelMall,
  buildAndelOffertText,
  insertOffertBlock,
};
