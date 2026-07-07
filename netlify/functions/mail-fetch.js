// netlify/functions/mail-fetch.js
// Läser de senaste inkorgsmeddelandena för MAILBOX_USER via Microsoft Graph.
// Read-only — skapar inga utkast, skickar ingenting. Dashboarden pollar denna
// för att rendera inkorgen.
//
// Miljövariabler:
//   MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET  (se lib/graph.js)
//   MAILBOX_USER = jimmy@peakfast.se   (fallback nedan)

const { graphJson } = require('./lib/graph');
const { getMailboxes } = require('./lib/mailboxes');

exports.handler = async (event) => {
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
  // (säkerhet — ingen godtycklig brevlåde-åtkomst). Utelämnad → första
  // konfigurerade (= dagens enda brevlåda utan multi-config).
  const mailboxes = await getMailboxes();
  const q = String((event.queryStringParameters && event.queryStringParameters.mailbox) || '').trim();
  const found = q ? mailboxes.find(m => m.address.toLowerCase() === q.toLowerCase()) : mailboxes[0];
  if (q && !found) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd brevlåda: ${q}` }) };
  }
  const mailbox = found.address;
  const select = 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead';
  const path =
    `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
    `?$top=25&$select=${select}&$orderby=receivedDateTime desc`;

  try {
    const data = await graphJson(path);
    const messages = (data.value || []).map(m => ({
      id: m.id,
      subject: m.subject || '(inget ämne)',
      fromName: m.from?.emailAddress?.name || '',
      fromAddress: m.from?.emailAddress?.address || '',
      received: m.receivedDateTime || '',
      preview: (m.bodyPreview || '').slice(0, 400),
      conversationId: m.conversationId || '',
      isRead: !!m.isRead,
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ mailbox, count: messages.length, messages }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa inkorgen: ${e.message}` }) };
  }
};
