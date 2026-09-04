// netlify/functions/kundlage.js
// Proxy mot Mäklargruvans kundläge: betalande kontor, intäkter och en tidslinje
// över köp och uppsägningar.
//
// SÄTT I NETLIFY → Environment variables:
//   DEMO_ADMIN_TOKEN = <samma slumpsträng som i maklargruvan-pilot>
//   MG_APP_URL       = https://app.maklargruvan.se   (valfri, detta är default)
//
// Båda finns redan om demokonto-knappen fungerar — samma token, samma app.
//
// ── VARFÖR EN PROXY OCH INTE ETT DIREKTANROP FRÅN FRONTEND ────────────────
// 🔴 DEMO_ADMIN_TOKEN får aldrig nå webbläsaren. Låg den i dashboardens JS
// kunde vem som helst med tillgång till sidan läsa ur den och sedan anropa
// Mäklargruvans API direkt, utanför dashboardens site-lösenord. Token bor
// därför bara här i funktionsmiljön. Samma resonemang som demo-konto.js.
//
// Varken Supabase-nyckeln eller Stripe-nyckeln finns här, och ska inte hit.
// De stannar i maklargruvan-pilots miljö.

const MG_URL = process.env.MG_APP_URL || 'https://app.maklargruvan.se';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Skydd: hela Netlify-siten är låst med site-lösenord, så bara autentiserade
  // besökare når dashboarden som anropar den här funktionen.

  const token = process.env.DEMO_ADMIN_TOKEN;
  if (!token) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'DEMO_ADMIN_TOKEN saknas i environment variables' })
    };
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);   // Netlifys tak är 10 s
    const r = await fetch(`${MG_URL}/.netlify/functions/kundlage`, {
      headers: { 'x-demo-token': token, Accept: 'application/json' },
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
      body: JSON.stringify({
        error: timeout
          ? 'Mäklargruvan svarade inte i tid.'
          : `Kunde inte nå Mäklargruvan: ${e && e.message}`
      })
    };
  }
};
