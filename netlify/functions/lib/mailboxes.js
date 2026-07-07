// netlify/functions/lib/mailboxes.js
// Konfigurationsupplösning för Mail-hubbens FLERA brevlådor (multi-mailbox).
// Alla brevlådor ligger i SAMMA Microsoft 365-tenant (samma Graph app-only-
// credentials i lib/graph.js) — här bestämmer vi bara VILKA adresser som är
// tillåtna och per-brevlåde-inställningar (etikett, signatur, roll-hint,
// stilprofil-fil).
//
// Precedens (första som gäller vinner):
//   1) data/mailboxes.json  — array med {address, label, signature, roleHint,
//      styleFile}. Läses via lib/store.js (samma GitHub-JSON-persistens som
//      resten av Mail-hubben). Finns den + är giltig → använd den.
//   2) env MAILBOX_USERS    — kommaseparerade adresser. Bygger listan med
//      label=address, signature=DEFAULT_SIGNATURE, roleHint='', styleFile=härledd.
//   3) Fallback: EN brevlåda = MAILBOX_USER (eller 'jimmy@peakfast.se') —
//      exakt dagens beteende.
//
// BAKÅTKOMPATIBILITET: utan data/mailboxes.json OCH utan MAILBOX_USERS blir
// listan exakt [{ jimmy@peakfast.se, signatur 'Med vänlig hälsning\nJimmy',
// styleFile 'data/mail-style.json' }] — dvs. dagens enda brevlåda, dagens
// signatur och dagens redan inlärda stilprofil.
//
// CommonJS, zero-dependency (samma mönster som övriga lib-filer).

const { readJsonFile } = require('./store');

// Dagens enda brevlåda + dess redan inlärda stilprofil. När jimmy@peakfast.se är
// (fallback-)brevlådan ska vi fortsätta använda 'data/mail-style.json' så den
// redan inlärda profilen gäller — inte en ny per-brevlåde-fil.
const LEGACY_DEFAULT_ADDRESS = 'jimmy@peakfast.se';
const LEGACY_STYLE_FILE = 'data/mail-style.json';

// Dagens sign-off (samma sträng som SIGN_OFF i lib/triage.js). Standardsignatur
// när en brevlåda inte anger en egen.
const DEFAULT_SIGNATURE = 'Med vänlig hälsning\nJimmy';

const MAILBOXES_FILE_PATH = 'data/mailboxes.json';

// Säkert filnamnsfragment ur en adress: gemener, allt utom [a-z0-9] → '_'.
function safeName(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Härleder stilprofil-filens sökväg för en adress. Legacy-brevlådan
// (jimmy@peakfast.se) → dagens 'data/mail-style.json' så den redan inlärda
// profilen fortsätter gälla. Övriga → 'data/mail-style-<safe>.json'.
function deriveStyleFile(address) {
  if (String(address || '').toLowerCase() === LEGACY_DEFAULT_ADDRESS) return LEGACY_STYLE_FILE;
  return `data/mail-style-${safeName(address)}.json`;
}

// Normaliserar EN rå brevlåde-post till fullt objekt. Returnerar null om
// adressen saknas (posten ignoreras då).
function normalizeEntry(e) {
  const address = String((e && e.address) || '').trim();
  if (!address) return null;
  const label = String((e && e.label) || '').trim() || address;
  const signature =
    e && typeof e.signature === 'string' && e.signature.trim() ? e.signature : DEFAULT_SIGNATURE;
  const roleHint = String((e && e.roleHint) || '').trim();
  const styleFile =
    e && typeof e.styleFile === 'string' && e.styleFile.trim() ? e.styleFile.trim() : deriveStyleFile(address);
  return { address, label, signature, roleHint, styleFile };
}

// Env-fallbackens enda brevlåda (MAILBOX_USER || legacy default). Detta är
// EXAKT dagens brevlåda och används både som fallback-lista och som
// säkerhets-default (defaultMailbox) när ingen brevlåda anges av anroparen.
function envMailbox() {
  const address = process.env.MAILBOX_USER || LEGACY_DEFAULT_ADDRESS;
  return normalizeEntry({ address });
}

// Synkron säkerhets-default. Returnerar dagens enda brevlåda (env/fallback).
// Används av libs/funktioner som `opts.mailbox || defaultMailbox().address` när
// ingen brevlåda skickats in — och som "hemvist" för gamla, otaggade köposter
// vid migrering (de tillhörde alltid den enda legacy-brevlådan).
function defaultMailbox() {
  return envMailbox();
}

// Modulnivå-cache för varm återanvändning (samma mönster som Graph-token-cachen).
// data/mailboxes.json läses högst en gång per varm instans; env/fallback är
// deterministiska. Ändringar i data/mailboxes.json syns efter nästa kallstart.
let _cache = null;

// Löser upp hela brevlådelistan enligt precedensen ovan. Async (kan läsa
// data/mailboxes.json). Degraderar tyst: kan JSON:en inte läsas (t.ex. GH_TOKEN
// saknas) faller vi igenom till MAILBOX_USERS och sedan fallback-brevlådan.
async function getMailboxes() {
  if (_cache) return _cache;

  // 1) data/mailboxes.json
  try {
    const { data } = await readJsonFile(MAILBOXES_FILE_PATH, null);
    if (Array.isArray(data) && data.length) {
      const list = data.map(normalizeEntry).filter(Boolean);
      if (list.length) {
        _cache = list;
        return _cache;
      }
    }
  } catch (_) {
    /* faller igenom till env/fallback */
  }

  // 2) env MAILBOX_USERS (kommaseparerat)
  const usersEnv = String(process.env.MAILBOX_USERS || '').trim();
  if (usersEnv) {
    const list = usersEnv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(a => normalizeEntry({ address: a }))
      .filter(Boolean);
    if (list.length) {
      _cache = list;
      return _cache;
    }
  }

  // 3) Fallback: dagens enda brevlåda.
  _cache = [envMailbox()];
  return _cache;
}

// Slår upp EN brevlådas fulla konfig (case-insensitivt). Returnerar objekt eller
// null. null = adressen är inte konfigurerad (och därmed inte tillåten).
async function getMailbox(address) {
  const addr = String(address || '').trim().toLowerCase();
  if (!addr) return null;
  const list = await getMailboxes();
  return list.find(m => m.address.toLowerCase() === addr) || null;
}

// Säkerhetsgrind: en förfrågan MÅSTE namnge en konfigurerad brevlåda. Skyddar
// mot godtycklig brevlåde-åtkomst via ?mailbox=/body.mailbox.
async function isAllowed(address) {
  return !!(await getMailbox(address));
}

// Endast för tester: nollställ modulnivå-cachen mellan env-varianter.
function __clearCache() {
  _cache = null;
}

module.exports = {
  DEFAULT_SIGNATURE,
  LEGACY_DEFAULT_ADDRESS,
  LEGACY_STYLE_FILE,
  MAILBOXES_FILE_PATH,
  safeName,
  deriveStyleFile,
  normalizeEntry,
  getMailboxes,
  getMailbox,
  isAllowed,
  defaultMailbox,
  __clearCache,
};
