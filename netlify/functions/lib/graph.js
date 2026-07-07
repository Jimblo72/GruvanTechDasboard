// netlify/functions/lib/graph.js
// Hjälpbibliotek för Microsoft Graph via client credentials-flödet (app-only).
//
// App-registreringen har application permission Mail.ReadWrite (admin consent) —
// alltså INGEN inloggad användare, ingen Mail.Send. Vi läser inkorgen och skapar
// utkast (drafts), men skickar aldrig.
//
// Miljövariabler (Netlify → Site settings → Environment variables):
//   MS_TENANT_ID     = katalog-/tenant-ID
//   MS_CLIENT_ID     = app-registreringens klient-ID
//   MS_CLIENT_SECRET = klienthemlighet (endast i env — aldrig i kod)
//
// Zero-dependency: Node 20+ global fetch. CommonJS så att de befintliga
// exports.handler-funktionerna kan require:a den.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Token cachas i modulnivå — återanvänds mellan varma anrop i samma instans.
let _token = null;
let _tokenExpiry = 0; // epoch ms då token slutar gälla (med marginal)

async function getGraphToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const secret = process.env.MS_CLIENT_SECRET;

  if (!tenant) throw new Error('MS_TENANT_ID saknas i Netlify environment variables');
  if (!clientId) throw new Error('MS_CLIENT_ID saknas i Netlify environment variables');
  if (!secret) throw new Error('MS_CLIENT_SECRET saknas i Netlify environment variables');

  // Giltig cachad token? Återanvänd (60 s marginal).
  const now = Date.now();
  if (_token && now < _tokenExpiry - 60000) return _token;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Kunde inte hämta Graph-token (HTTP ${r.status}): ${errText.slice(0, 300)}`);
  }

  const data = await r.json();
  if (!data.access_token) {
    throw new Error('Graph-token saknades i svaret från Microsoft.');
  }
  _token = data.access_token;
  _tokenExpiry = now + (Number(data.expires_in || 3600) * 1000);
  return _token;
}

// Anropar Graph med bearer-token påkopplad. `path` börjar med "/" (relativt
// GRAPH_BASE) eller är en absolut URL. Returnerar Response-objektet — anroparen
// får själv kontrollera .ok och tolka body (json/tomt).
async function graphFetch(path, opts = {}) {
  const token = await getGraphToken();
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// Bekvämlighet: gör graphFetch och kastar tydligt svenskt fel vid icke-2xx.
async function graphJson(path, opts = {}) {
  const r = await graphFetch(path, opts);
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Graph ${opts.method || 'GET'} ${path} → HTTP ${r.status}: ${errText.slice(0, 300)}`);
  }
  // 204 No Content → tomt
  if (r.status === 204) return null;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

module.exports = { getGraphToken, graphFetch, graphJson, GRAPH_BASE };
