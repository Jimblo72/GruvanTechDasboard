// netlify/functions/mail-config.js
// Returnerar listan över konfigurerade brevlådor för Mail-hubbens frontend, så
// att dashboarden kan rendera en brevlåde-väljare. Exponerar ENDAST address +
// label — signatur, roll-hint och stilprofil-fil hålls serverside (läcker inte
// affärskontext/interna sökvägar till klienten).
//
// GET → { mailboxes: [{ address, label }] }
//
// Bakåtkompatibelt: utan data/mailboxes.json och utan MAILBOX_USERS returneras
// exakt en brevlåda (MAILBOX_USER || jimmy@peakfast.se). Se lib/mailboxes.js.

const { getMailboxes } = require('./lib/mailboxes');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const list = await getMailboxes();
    // Strippa allt utom address + label — inga hemligheter/interna fält ut.
    const mailboxes = list.map(m => ({ address: m.address, label: m.label }));
    return { statusCode: 200, headers, body: JSON.stringify({ mailboxes }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa brevlådekonfig: ${e.message}` }) };
  }
};
