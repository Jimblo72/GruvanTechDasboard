// netlify/functions/demo-konto.js
// Proxy mot Mäklargruvans demokonto-API. Skapar och hanterar demokonton för nya
// demokunder och samarbetspartners (t.ex. juristbyrån Stegman).
//
// SÄTT I NETLIFY → Environment variables:
//   DEMO_ADMIN_TOKEN = <samma slumpsträng som i maklargruvan-pilot>
//   MG_APP_URL       = https://app.maklargruvan.se   (valfri, detta är default)
//
// ── VARFÖR EN PROXY OCH INTE ETT DIREKTANROP FRÅN FRONTEND ────────────────
// 🔴 DEMO_ADMIN_TOKEN får aldrig nå webbläsaren. Lade vi den i dashboardens
// JS hade vem som helst med tillgång till sidan — eller till en cachad kopia
// av den — kunnat läsa ur den och sedan anropa Mäklargruvans API direkt,
// utanför dashboardens site-lösenord. Därför bor token bara här i
// funktionsmiljön, och frontend anropar denna proxy utan hemligheter.
//
// Själva Supabase-nyckeln (service_role) finns INTE här och ska inte hit —
// den stannar i maklargruvan-pilots miljö. Se kommentaren överst i
// netlify/functions/demo-konto.js i det repot.

const MG_URL = process.env.MG_APP_URL || 'https://app.maklargruvan.se';
const TILLATNA = ['lista', 'skapa', 'andra', 'forlang', 'slack'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Skydd: hela Netlify-siten är låst med site-lösenord, så bara autentiserade
  // besökare når dashboarden som anropar denna funktion.

  const token = process.env.DEMO_ADMIN_TOKEN;
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DEMO_ADMIN_TOKEN saknas i environment variables' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  // Vitlista handlingarna här också. Proxyn ska inte kunna användas för att nå
  // något annat än de fyra avsedda operationerna, även om API:t i andra änden
  // skulle få fler i framtiden.
  if (!TILLATNA.includes(payload.handling)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `handling måste vara en av: ${TILLATNA.join(', ')}` }) };
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);   // Netlifys tak är 10 s
    const r = await fetch(`${MG_URL}/.netlify/functions/demo-konto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-demo-token': token },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    const text = await r.text();
    return { statusCode: r.status, headers, body: text || '{}' };
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return {
      statusCode: timeout ? 504 : 502,
      headers,
      body: JSON.stringify({ error: timeout ? 'Mäklargruvan svarade inte i tid' : 'Kunde inte nå Mäklargruvan' }),
    };
  }
};
