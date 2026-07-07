// netlify/functions/mail-triage.js
// Klassificerar ETT inkorgsmeddelande och skapar ett svarsutkast i Outlook-tråden.
// Anropas av dashboarden på explicit klick ("Analysera & skapa utkast") — alltså
// en gång per meddelande, inte i loop. Skickar ALDRIG.
//
// POST-body: { messageId, force? }
//   - Klassificerar via Claude Haiku (Gemini opt-in), genererar utkasttext via
//     Claude, skapar utkast via Graph (createReply + PATCH). Vid kategori "brus"
//     skapas inget utkast.
//   - `force` finns för framtida idempotens-styrning; standard skapar ett utkast
//     per anrop.
// Returnerar: { category, reason, confidence, suggested_action, needsManualConfirm,
//               draftId, draftWebLink, draftText }
//
// Miljövariabler: MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET, MAILBOX_USER,
//                 ANTHROPIC_API_KEY, MAIL_CLASSIFY_MODEL/MAIL_DRAFT_MODEL,
//                 MAIL_CLASSIFY_PROVIDER (+ GEMINI_API_KEY/GEMINI_MODEL om gemini).

const { triageMessage } = require('./lib/triage');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const messageId = String(payload.messageId || '').trim();
  if (!messageId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'messageId saknas' }) };
  }

  try {
    // Explicit klick → skapa faktiskt utkastet i Outlook.
    const result = await triageMessage(messageId, { autodraft: true, force: !!payload.force });
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Triage misslyckades: ${e.message}` }) };
  }
};
