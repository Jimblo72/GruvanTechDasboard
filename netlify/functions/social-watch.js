// netlify/functions/social-watch.js
// Schemalagd watcher för sociala förslag (1×/dygn, se netlify.toml). Hämtar
// nya pressmeddelanden från källorna i lib/social.js, låter Claude relevans-
// filtrera + skriva 2–3 utkastvarianter (jag-form, signerade "— Jimmy") och
// köar dem i data/social-queue.json.
//
// PUBLICERAR INGENTING. Kön godkänns manuellt i dashboarden (Sociala förslag);
// publiceringssteget byggs separat och konsumerar enbart status 'godkänd'.
//
// Manuell körning görs via dashboardens "Hämta nu"-knapp, som går genom
// social-queue.js (action: 'watch') — schemalagda funktioner kan inte anropas
// över HTTP.
//
// Miljövariabler: ANTHROPIC_API_KEY, GH_TOKEN (+ GH_USER/GH_REPO).

const { runWatch } = require('./lib/social');

exports.handler = async () => {
  try {
    const log = await runWatch();
    return { statusCode: 200, body: JSON.stringify(log) };
  } catch (e) {
    // Icke-blockerande: logga och svara 200 så schemat inte spammar fel.
    return { statusCode: 200, body: JSON.stringify({ errors: [e.message] }) };
  }
};
