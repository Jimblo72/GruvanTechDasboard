// netlify/functions/lib/openrouter.js
// Ett ställe för OpenRouter-anropet, delat av den synkrona ai-review.js och den
// asynkrona ai-review-background.js. Enda skillnaden mellan dem är budgeten:
// synkront måste svaret tillbaka innan Netlifys 10 s, i bakgrunden finns 15 min.
//
// Miljövariabler:
//   OPENROUTER_API_KEY          = sk-or-v1-...
//   OPENROUTER_MODEL            = <modell-id>   (valfri — förstahandsval)
//   OPENROUTER_FALLBACK_MODELS  = a,b           (valfri — reserver, komma-sep)
//   OPENROUTER_REASONING_EFFORT = low|medium|high
//
// ⚠ DATAPOLICY: OpenRouter anger att prompt och svar BEHÅLLS av leverantören
// (används ej för träning). Skicka därför bara kod hit — aldrig kundmail,
// persondata eller annat som hör hemma i mail-/triage-flödena.

// Kedjan är ordnad efter DJUP, inte fart. Ett tidigare urval gick på
// tillgänglighet inom tidstaket och landade i nemotron-3.5-lightning (3B aktiva
// av 30B) — den levererade en granskning som lät kunnig men vars tre "kritiska"
// fynd alla var falska. Aktiva parametrar: ultra 55B, inkling 41B.
// glm-5.2 är sannolikt samma familj som stealth/ox-alpha, fast namngiven.
// Andra dugliga alternativ för OPENROUTER_FALLBACK_MODELS:
//   poolside/laguna-s-2.1:free  (kodagent, 70,2 % Terminal-Bench 2.1, 8B aktiva)
//   stealth/ox-alpha            (har 429:at varje gång — aldrig svarat)
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const DEFAULT_FALLBACKS = 'z-ai/glm-5.2:free,thinkingmachines/inkling:free';

// OpenRouter avvisar längre listor med 400: "'models' array must have 3 items
// or fewer". Kedjan kapas därför här i stället för att felet ska nå användaren.
const MAX_MODELS = 3;

function buildChain() {
  const primary = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const fallbacks = (process.env.OPENROUTER_FALLBACK_MODELS || DEFAULT_FALLBACKS)
    .split(',').map(m => m.trim()).filter(Boolean);
  return [primary, ...fallbacks.filter(m => m !== primary)].slice(0, MAX_MODELS);
}

// Anropar OpenRouter och returnerar { text, model, ms, kedja }.
// opts.budgetMs  = hur länge vi får vänta (obligatoriskt i praktiken)
// opts.maxTokens = takt för svaret; tankekedjan räknas mot samma budget
async function callOpenRouter(system, userPrompt, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY saknas i Netlify environment variables');

  const kedja = buildChain();
  const budgetMs = opts.budgetMs || 8500;
  const maxTokens = opts.maxTokens || 4000;
  const t0 = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);

  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-Title': 'Gruvan Tech Dashboard', // syns i OpenRouters aktivitetslogg
      },
      body: JSON.stringify({
        model: kedja[0],
        // OpenRouter faller själv igenom listan vid 429, driftstopp, moderering
        // och för långt sammanhang, och rapporterar i svaret vilken som körde.
        models: kedja,
        max_tokens: maxTokens,
        temperature: 0.3,
        // Tankenivån är en avvägning mot budgeten, inte snålhet: synkront finns
        // det inte tid för mer. Bakgrundsvägen skickar in 'high' — där är det
        // just djupet man betalar väntetiden för.
        reasoning: { effort: opts.effort || process.env.OPENROUTER_REASONING_EFFORT || 'low' },
        messages: [
          { role: 'system', content: system || 'Du är en hjälpsam kodgranskare. Svara på svenska.' },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Modellerna hann inte svara inom ${(budgetMs / 1000).toFixed(1)} s — ` +
        `${userPrompt.length} tecken skickades till ${kedja.join(' → ')}.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const errText = await r.text();
    // 404 = modellen avvecklad (vanligt för stealth-modeller).
    // 429 = leverantörens kapacitet slut, inte vår kvot.
    const hint = r.status === 404 ? ' — modellen finns inte längre? Byt OPENROUTER_MODEL.'
      : r.status === 429 ? ` — alla ${kedja.length} modeller var upptagna (${kedja.join(', ')}). Byt ut några i OPENROUTER_FALLBACK_MODELS.`
      : '';
    throw new Error(`OpenRouter HTTP ${r.status}: ${errText.slice(0, 200)}${hint}`);
  }

  const data = await r.json();
  // OpenRouter kan svara 200 med ett fel i kroppen.
  if (data.error) {
    throw new Error(`OpenRouter: ${(data.error.message || JSON.stringify(data.error)).slice(0, 200)}`);
  }
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return { text: text || '(tomt svar)', model: data.model || kedja[0], ms: Date.now() - t0, kedja };
}

module.exports = { callOpenRouter, buildChain, MAX_MODELS };
