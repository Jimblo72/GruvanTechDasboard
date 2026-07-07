// netlify/functions/lib/thread.js
// Hela-tråd- och tvärtråds-kontext för Mail-hubben. Två uppgifter:
//
//   1) fetchThread(conversationId) — hämtar hela mejltråden (alla meddelanden med
//      samma conversationId) och bygger en kronologisk ren-text-transkription som
//      matas in i BÅDE klassificeringen och utkastgenereringen. Utan detta läser
//      LLM:en bara det senaste meddelandet och missar sammanhanget (t.ex. att en
//      tråd är privat, eller att konkret info ligger tidigare i tråden).
//
//   2) fetchOtherThreadsFromSender(senderAddress, excludeConversationId) — listar
//      ANDRA trådar från samma avsändare så modellen får bredare kontext (t.ex.
//      "mer konkret info finns i en annan tråd").
//
// Allt degraderar tyst: saknas conversationId, eller fallerar Graph-anropet,
// returneras tomt och kedjan beter sig som förr (bara senaste meddelandet).
//
// CommonJS, zero-dependency (Node 20 global fetch). Samma mönster som övriga
// lib-filer. htmlToText återanvänds från triage.js via LAT require (inuti
// funktionen) för att undvika cirkulärt beroende: triage.js require:ar denna fil,
// så vi får INTE göra en top-level require('./triage') här (triage.js sätter sin
// module.exports längst ner → skulle ge en tom/stale referens under laddning).

const { graphJson } = require('./graph');

const MAILBOX = () => process.env.MAILBOX_USER || 'jimmy@peakfast.se';

// Latensskydd: håll transkriptionen liten. Vi tar de senaste meddelandena och
// kapar både antal och total längd så LLM-anropen inte blir tunga.
const MAX_TRANSCRIPT_MESSAGES = 12;   // max antal meddelanden i transkriptionen
const MAX_TRANSCRIPT_CHARS = 6000;    // total teckenbudget (behåll de senaste)
const PER_BODY_CHARS = 800;           // kap varje meddelandes brödtext
const MAX_OTHER_THREADS = 5;          // andra trådar från samma avsändare
const OTHER_PREVIEW_CHARS = 160;      // förhandsvisning per annan tråd
const OTHER_SUMMARY_CHARS = 1500;     // total längd på tvärtråds-sammanfattningen

// Strippar HTML → text genom att LAT återanvända triage.js htmlToText. Lat require
// (i anropsögonblicket, inte vid modulladdning) bryter den cirkulära cykeln:
// require-cachen är fullt laddad när detta faktiskt körs. Faller tillbaka på en
// minimal strippning om något oväntat skulle gå fel.
function stripToText(raw, contentType) {
  try {
    const { htmlToText } = require('./triage');
    if (typeof htmlToText === 'function') return htmlToText(raw, contentType);
  } catch (_) { /* faller igenom till minimal strippning */ }
  return String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Formaterar ISO-tid → "2026-07-07 19:39" (UTC, deterministiskt utan ICU).
function fmtDate(iso) {
  const s = String(iso || '');
  if (s.length >= 16 && s[10] === 'T') return s.slice(0, 16).replace('T', ' ');
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function addrOf(m) {
  return String((m && m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
}

// Talarens etikett i transkriptionen: Jimmy (om avsändaren = mejllådan) annars
// avsändarens namn/adress.
function speakerLabel(m, mailboxLower) {
  const a = addrOf(m);
  if (a && a === mailboxLower) return 'Jimmy';
  const ea = (m && m.from && m.from.emailAddress) || {};
  return ea.name || ea.address || 'Okänd avsändare';
}

// Percent-kodar ett OData-$filter-uttryck för URL-transport men behåller '/'
// literalt så navigations-egenskapssökvägar (from/emailAddress/address) och
// base64-conversationId:n inte trasas sönder. '+' → %2B och blanksteg → %20
// bevaras kodade (viktigt: '+' tolkas annars som blanksteg av servern).
function encodeFilter(expr) {
  return encodeURIComponent(String(expr)).replace(/%2F/gi, '/');
}

// OData-stränglitteral: dubblera enkelfnuttar (') → ('').
function odataQuote(v) {
  return String(v == null ? '' : v).replace(/'/g, "''");
}

// ── 1) Hela tråden ────────────────────────────────────────────
// GET /users/{mailbox}/messages?$filter=conversationId eq '{cid}'
//        &$select=subject,from,receivedDateTime,sentDateTime,body,bodyPreview,isDraft
//        &$top=25
//
// VIKTIGT: INGEN $orderby. Graph avvisar $filter=conversationId KOMBINERAT med
// $orderby=receivedDateTime som "The restriction or sort order is too complex for
// this operation" (400) — en dokumenterad begränsning. Vi sorterar därför klient-
// sidan i stället. Fallback om själva filter-frågan ändå fallerar: hämta de
// senaste meddelandena utan filter och filtrera på conversationId i JS (fångar
// även utkast, som ligger i Utkast-mappen men delar conversationId).
//
// conversationId enkelfnuttas i filtret och hela filteruttrycket URL-kodas.
// opts: { maxMessages, maxChars } kapar transkriptionen (on-click hålls lättare).
// Returnerar { transcript, messages, latestNonDraft, latestIsFromJimmy,
//              hasDraftReply, ok, threadCount }.
async function fetchThread(conversationId, opts = {}) {
  const empty = {
    transcript: '',
    messages: [],
    latestNonDraft: null,
    latestIsFromJimmy: false,
    hasDraftReply: false,
    ok: false,
    threadCount: 0,
  };
  const cid = String(conversationId || '').trim();
  if (!cid) return empty;

  const maxMessages = opts.maxMessages || MAX_TRANSCRIPT_MESSAGES;
  const maxChars = opts.maxChars || MAX_TRANSCRIPT_CHARS;

  // Vilken brevlåda vi läser tråden i OCH jämför "från Jimmy" mot. Anroparen
  // skickar in opts.mailbox (multi-mailbox); faller tillbaka på MAILBOX() för
  // säkerhet/bakåtkompatibilitet.
  const mailbox = opts.mailbox || MAILBOX();
  const mailboxLower = mailbox.toLowerCase();
  const select = 'subject,from,receivedDateTime,sentDateTime,body,bodyPreview,isDraft,conversationId';
  const filter = `conversationId eq '${odataQuote(cid)}'`;
  const filteredPath =
    `/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeFilter(filter)}` +
    `&$select=${select}` +
    `&$top=25`;
  // Fallback: senaste 50 meddelanden (utan filter, default-ordning) → filtrera
  // conversationId i JS. Spänner alla mappar inkl. Utkast.
  const fallbackPath =
    `/users/${encodeURIComponent(mailbox)}/messages` +
    `?$select=${select}` +
    `&$top=50`;

  let all = null;
  try {
    const data = await graphJson(filteredPath);
    all = (data && data.value) || [];
  } catch (_) {
    // Filter-frågan avvisad (t.ex. "too complex") → klient-side-fallback.
    try {
      const data = await graphJson(fallbackPath);
      all = ((data && data.value) || []).filter(m => String(m && m.conversationId || '') === cid);
    } catch (_2) {
      return empty; // degradera tyst → bara senaste meddelandet, som förr.
    }
  }

  if (!all || !all.length) return { ...empty, ok: true };

  const hasDraftReply = all.some(m => m && m.isDraft === true);

  // Icke-utkast, kronologiskt (klient-sortering som skydd även om Graph inte
  // respekterade $orderby).
  const nonDraft = all
    .filter(m => m && m.isDraft !== true)
    .sort((a, b) => new Date(a.receivedDateTime || a.sentDateTime || 0) - new Date(b.receivedDateTime || b.sentDateTime || 0));

  const latestNonDraft = nonDraft.length ? nonDraft[nonDraft.length - 1] : null;
  const latestIsFromJimmy = !!(latestNonDraft && addrOf(latestNonDraft) === mailboxLower);

  // Bygg transkription: de senaste maxMessages meddelandena, äldst först, sedan
  // kapa total längd (behåll de senaste).
  const recent = nonDraft.slice(-maxMessages);
  const lines = recent.map(m => {
    const raw = (m.body && m.body.content) || m.bodyPreview || '';
    let t = stripToText(raw, m.body && m.body.contentType);
    t = t.replace(/[ \t]+\n/g, '\n').trim();
    if (t.length > PER_BODY_CHARS) t = t.slice(0, PER_BODY_CHARS).trim() + '…';
    const when = fmtDate(m.receivedDateTime || m.sentDateTime);
    const who = speakerLabel(m, mailboxLower);
    return `[${when}] ${who}: ${t}`;
  });

  // Kapa total teckenbudget: släpp äldsta rader tills vi ryms.
  while (lines.length > 1 && lines.join('\n\n').length > maxChars) {
    lines.shift();
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > maxChars) {
    transcript = transcript.slice(-maxChars);
  }

  return { transcript, messages: all, latestNonDraft, latestIsFromJimmy, hasDraftReply, ok: true, threadCount: all.length };
}

// ── 2) Andra trådar från samma avsändare ──────────────────────
// GET /users/{mailbox}/messages?$filter=from/emailAddress/address eq '{addr}'
//        &$select=subject,conversationId,receivedDateTime,bodyPreview&$top=50
//        (ingen $orderby — sorteras klient-sidan, se not nedan)
//
// Dedupe på conversationId, exkludera aktuell tråd, behåll ~5 senaste ANDRA
// trådar. Returnerar [{ subject, date, preview }]. Tom om adressen saknas/är oss.
async function fetchOtherThreadsFromSender(senderAddress, excludeConversationId, mailbox) {
  const addr = String(senderAddress || '').trim();
  if (!addr) return [];
  const mb = mailbox || MAILBOX();
  if (addr.toLowerCase() === mb.toLowerCase()) return []; // inte oss själva

  // INGEN $orderby (samma "too complex"-begränsning som tråd-frågan när man
  // filtrerar på ett annat fält än man sorterar). Vi sorterar klient-sidan.
  const filter = `from/emailAddress/address eq '${odataQuote(addr)}'`;
  const select = 'subject,conversationId,receivedDateTime,bodyPreview';
  const path =
    `/users/${encodeURIComponent(mb)}/messages` +
    `?$filter=${encodeFilter(filter)}` +
    `&$select=${select}` +
    `&$top=50`;

  let data;
  try {
    data = await graphJson(path);
  } catch (_) {
    return [];
  }

  const msgs = ((data && data.value) || [])
    .slice()
    .sort((a, b) => new Date(b && b.receivedDateTime || 0) - new Date(a && a.receivedDateTime || 0));
  const exclude = String(excludeConversationId || '');
  const seen = new Set();
  const out = [];
  for (const m of msgs) {
    const cid = m && m.conversationId ? String(m.conversationId) : '';
    if (cid && cid === exclude) continue;      // hoppa över aktuell tråd
    if (cid && seen.has(cid)) continue;         // dedupe per tråd
    if (cid) seen.add(cid);
    out.push({
      subject: (m && m.subject) || '(inget ämne)',
      date: fmtDate(m && m.receivedDateTime),
      preview: String((m && m.bodyPreview) || '').replace(/\s+/g, ' ').trim().slice(0, OTHER_PREVIEW_CHARS),
    });
    if (out.length >= MAX_OTHER_THREADS) break;
  }
  return out;
}

// Bygger en kompakt sammanfattningssträng av andra trådar (för LLM-kontext).
function buildOtherThreadsSummary(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const rows = list.map(t => `- ${t.subject}${t.date ? ` (${t.date})` : ''}: ${t.preview}`);
  let s = 'Andra mejltrådar från samma avsändare (för kontext):\n' + rows.join('\n');
  if (s.length > OTHER_SUMMARY_CHARS) s = s.slice(0, OTHER_SUMMARY_CHARS);
  return s;
}

// Slår ihop transkription + tvärtråds-sammanfattning till ETT tydligt märkt
// kontextblock som matas in i både klassificering och utkast.
function buildThreadContextBlock(transcript, otherSummary) {
  const parts = [];
  const tr = String(transcript || '').trim();
  const os = String(otherSummary || '').trim();
  if (tr) parts.push('HELA TRÅDEN (äldst först):\n' + tr);
  if (os) parts.push(os);
  return parts.join('\n\n');
}

module.exports = {
  fetchThread,
  fetchOtherThreadsFromSender,
  buildOtherThreadsSummary,
  buildThreadContextBlock,
  // exporterade för ev. återanvändning/test:
  fmtDate,
  encodeFilter,
};
