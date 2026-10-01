// netlify/functions/mail-fetch.js
// Läser inkorgen för en konfigurerad brevlåda via Microsoft Graph.
// Read-only — skapar inga utkast, skickar ingenting.
//
// Två lägen:
//   GET ?mailbox=&dagar=30     → inkorgen de senaste N dagarna (förval 30, max 90),
//                                nyast först, sidvis via @odata.nextLink.
//   GET ?mailbox=&q=Åre Strand → sök i HELA brevlådan (alla mappar, även skickat
//                                och arkiv) med Graphs $search: ämne, brödtext,
//                                avsändare och bilagenamn. Ingen tidsgräns.
//
// Svar: { mailbox, lage, dagar|q, count, truncated, messages: [...] }
//
// Miljövariabler:
//   MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET  (se lib/graph.js)

const { graphJson } = require('./lib/graph');
const { getMailboxes } = require('./lib/mailboxes');

const SELECT = 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,isDraft,hasAttachments';
const MAX_DAGAR = 90;
// Tak för inkorgsläget. 30 dagar i en aktiv mäklarinkorg är några hundra mejl;
// taket skyddar Netlifys 10 s och webbläsaren. truncated = det finns fler.
const MAX_MEJL = 600;
const SIDA = 100;
// $search sorterar på relevans; 100 träffar räcker för en träfflista.
const MAX_SOK = 100;
// Synkrona funktioner har 10 s. Ingen ny sida påbörjas efter detta.
const TIDSBUDGET_MS = 7000;

function karta(m) {
  return {
    id: m.id,
    subject: m.subject || '(inget ämne)',
    fromName: m.from?.emailAddress?.name || '',
    fromAddress: m.from?.emailAddress?.address || '',
    received: m.receivedDateTime || '',
    preview: (m.bodyPreview || '').slice(0, 400),
    conversationId: m.conversationId || '',
    isRead: !!m.isRead,
    hasAttachments: !!m.hasAttachments,
  };
}

// KQL i $search: hela frågan inom dubbla citattecken. Graph har ingen escape för
// citattecken eller backslash i $search, så de tas bort.
function sokfraga(q) {
  return '"' + String(q).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim() + '"';
}

exports.handler = async (event) => {
  const start = Date.now();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Multi-mailbox: ?mailbox= väljer inkorg. Måste vara en KONFIGURERAD brevlåda
  // (säkerhet — ingen godtycklig brevlåde-åtkomst). Utelämnad → första konfigurerade.
  const qs = event.queryStringParameters || {};
  const mailboxes = await getMailboxes();
  const mbIn = String(qs.mailbox || '').trim();
  const found = mbIn ? mailboxes.find(m => m.address.toLowerCase() === mbIn.toLowerCase()) : mailboxes[0];
  if (mbIn && !found) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd brevlåda: ${mbIn}` }) };
  }
  const mailbox = found.address;
  const bas = `/users/${encodeURIComponent(mailbox)}`;
  const q = String(qs.q || '').trim().slice(0, 200);

  try {
    // ── Sökläge: hela brevlådan ─────────────────────────────────────────
    if (q) {
      // $search går inte att kombinera med $orderby eller $filter på meddelanden,
      // så datumsorteringen görs här.
      const path = `${bas}/messages?$search=${encodeURIComponent(sokfraga(q))}&$select=${SELECT}&$top=${MAX_SOK}`;
      const data = await graphJson(path);
      const messages = (data.value || [])
        .filter(m => m && m.isDraft !== true)
        .map(karta)
        .sort((a, b) => (b.received || '').localeCompare(a.received || ''));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ mailbox, lage: 'sok', q, count: messages.length, truncated: !!data['@odata.nextLink'], messages }),
      };
    }

    // ── Inkorgsläge: senaste N dagarna ──────────────────────────────────
    const dagar = Math.min(Math.max(parseInt(qs.dagar, 10) || 30, 1), MAX_DAGAR);
    const fran = new Date(Date.now() - dagar * 86400000).toISOString();
    const filter = encodeURIComponent(`receivedDateTime ge ${fran}`);
    let next = `${bas}/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime desc&$select=${SELECT}&$top=${SIDA}`;
    const messages = [];
    let truncated = false;
    while (next) {
      if (messages.length >= MAX_MEJL || Date.now() - start > TIDSBUDGET_MS) { truncated = true; break; }
      const data = await graphJson(next);
      for (const m of data.value || []) if (m && m.isDraft !== true) messages.push(karta(m));
      next = data['@odata.nextLink'] || null;
    }
    if (messages.length > MAX_MEJL) { messages.length = MAX_MEJL; truncated = true; }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ mailbox, lage: 'inkorg', dagar, fran, count: messages.length, truncated, messages }),
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa ${q ? 'sökningen' : 'inkorgen'}: ${e.message}` }) };
  }
};
