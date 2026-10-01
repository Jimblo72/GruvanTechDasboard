// netlify/functions/objekt-underlag-utkast.js
// Skapar ett svarsutkast i Outlook från objektsunderlaget: frågorna till
// kunden om det som saknas för att lägga upp objektet.
//
// POST { messageId, text, mailbox? } → { draftId, draftWebLink }
//
// * messageId = kundens mejl som utkastet svarar på (createReply — utkastet
//   hamnar i tråden med originalet citerat under).
// * text = mejlets brödtext, skriven och granskad i dashboarden.
// * Skickar ALDRIG. Utkastet ligger i Outlook tills Jimmy själv skickar det.
//
// Integritet (samma regel som objekt-underlag-kalla.js): texten innehåller
// kundens namn och uppgifter. Funktionen lämnar den till Graph och glömmer —
// den sparas inte och loggas inte.
//
// Brevlådan måste vara konfigurerad (samma skydd som mail-triage).

const { createOutlookDraft } = require('./lib/triage');
const { isAllowed, defaultMailbox } = require('./lib/mailboxes');

const MAX_TEXT = 8000;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const messageId = String(payload.messageId || '').trim();
  if (!messageId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'messageId saknas' }) };
  const text = String(payload.text || '').trim();
  if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Texten är tom' }) };
  if (text.length > MAX_TEXT) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Texten är för lång (högst ${MAX_TEXT} tecken)` }) };
  }

  const mbIn = String(payload.mailbox || '').trim();
  if (mbIn && !(await isAllowed(mbIn))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd brevlåda: ${mbIn}` }) };
  }
  const mb = mbIn || defaultMailbox().address;

  try {
    const { draftId, draftWebLink } = await createOutlookDraft(messageId, text, mb);
    return { statusCode: 200, headers, body: JSON.stringify({ draftId, draftWebLink }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte skapa utkastet: ${e.message}` }) };
  }
};
