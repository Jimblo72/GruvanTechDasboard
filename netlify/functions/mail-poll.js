// netlify/functions/mail-poll.js
// Schemalagd Netlify-funktion (var 10:e minut, se netlify.toml) som, för VARJE
// konfigurerad brevlåda (multi-mailbox, se lib/mailboxes.js):
//   1. Läser inkorgen via Graph.
//   2. Plockar ut olästa meddelanden NYARE än brevlådans senast sedda tidsstämpel.
//   3. Klassificerar var och en (Claude Haiku, ev. Gemini). För icke-brus skapas ett svarsutkast
//      (Claude + Graph createReply) — MEN endast om MAIL_AUTODRAFT === 'true'.
//      Annars torrkörning: klassificera + köa, skapa INGA utkast.
//   4. Persisterar per-brevlåde-lastSeen + en gemensam kö till data/mail-queue.json.
//
// Tillståndsform: { lastSeen: { <adress>: iso, ... }, items: [ {..., mailbox} ] }.
// MIGRERAR mjukt från den gamla formen { lastSeen: <iso-sträng>, items: [...] }:
// gamla lastSeen tolkas som legacy-brevlådans (defaultMailbox) lastSeen, och
// gamla otaggade köposter får mailbox = defaultMailbox().address.
//
// Säkerhet:
//   * MAIL_AUTODRAFT (default: torrkörning). Sätt = 'true' för att låta pollern
//     faktiskt skapa utkast i Outlook. Skickar ALDRIG — bara utkast.
//   * Max 10 nya meddelanden per brevlåda och körning; max 100 poster i kön.
//
// Schemaläggning: registrerad i netlify.toml → [functions."mail-poll"].
//
// ── TIDSBUDGET (schemalagda funktioner har 30 s TOTALT) ───────────────────
// Varje mejl kostar två LLM-anrop (+ ev. PDF-läsning). Med flera nya mejl
// räckte 30 s inte, och då dödades körningen INNAN kön och lastSeen skrevs —
// allt arbete förlorades och samma mejl togs om nästa gång. Nu:
//   * Inget nytt mejl påbörjas efter BUDGET.startMs. Resten ligger kvar
//     (olästa och nyare än lastSeen) och tas i nästa körning, äldst först.
//   * lastSeen flyttas fram PER MEJL, direkt när det är klart — aldrig förbi
//     ett mejl som inte hunnits.
//   * Hårt stopp vid BUDGET.hardStopMs: hänger ett anrop skrivs det som hunnits
//     ändå. Mejlet som hängde räknas inte som sett och tas om nästa gång
//     (skapade det ett utkast stoppar dubblettspärren i triage ett till).
//   * PDF-bilagor läses bara under de första BUDGET.attachmentsMs; senare mejl
//     triageras utan bilagor och flaggas attachmentsSkipped i kön.
//
// Varför inte en bakgrundsfunktion (15 min): sajten är lösenordsskyddad och
// skyddet gäller även funktionsadresserna. Ett anrop från den här funktionen
// till en -background-funktion får 401 och dör tyst — samma fälla som
// SEO-verktyget och AI-granskningen (se seo-queue.js). De startas därför från
// webbläsaren, som har lösenordskakan; en schemalagd poller har ingen.

const { graphJson } = require('./lib/graph');
const { triageMessage, POLL_RETRY_DELAYS } = require('./lib/triage');
const { readJsonFile, writeJsonFile } = require('./lib/store');
const { getMailboxes, defaultMailbox } = require('./lib/mailboxes');

const FILE_PATH = 'data/mail-queue.json';
const MAX_PER_RUN = 10;
const MAX_QUEUE = 100;

// Tidsbudget i ms från körningens start (Netlifys tak är 30 s).
const BUDGET = {
  attachmentsMs: 12000, // läs PDF-bilagor bara fram hit
  startMs: 16000,       // påbörja inget nytt mejl efter detta
  hardStopMs: 24000,    // skriv det som hunnits, oavsett vad som pågår
};

// Migrerar det lästa tillståndet till den nya per-brevlåde-formen. Returnerar
// { lastSeenMap, items, migrated } där migrated=true om något gammalt format
// normaliserades (→ skriv tillbaka även utan nya poster).
function migrateState(state, defAddr) {
  let migrated = false;

  // lastSeen: nytt = objekt {adress: iso}; gammalt = iso-sträng (eller null).
  let lastSeenMap;
  if (state && state.lastSeen && typeof state.lastSeen === 'object' && !Array.isArray(state.lastSeen)) {
    lastSeenMap = { ...state.lastSeen };
  } else {
    lastSeenMap = {};
    if (state && state.lastSeen) lastSeenMap[defAddr] = state.lastSeen;
    migrated = true; // gammal sträng/null → ny objektform
  }

  // items: tagga otaggade poster med legacy-brevlådan.
  const items = Array.isArray(state && state.items) ? state.items.map(it => {
    if (it && it.mailbox) return it;
    migrated = true;
    return { ...it, mailbox: defAddr };
  }) : [];

  return { lastSeenMap, items, migrated };
}

// Exporterad för test (och som dokumentation av migreringsformen).
exports.migrateState = migrateState;

function queueItem(result, m, address) {
  return {
    messageId: result.messageId,
    mailbox: address,
    category: result.category,
    subject: result.subject,
    fromName: result.fromName,
    fromAddress: result.fromAddress,
    reason: result.reason,
    confidence: result.confidence,
    suggested_action: result.suggested_action,
    needsManualConfirm: result.needsManualConfirm,
    draftId: result.draftId,
    draftWebLink: result.draftWebLink,
    autodraft: result.autodraft,
    alreadyReplied: result.alreadyReplied,
    duplicateDraft: result.duplicateDraft,
    skipReason: result.skipReason,
    attachments: result.attachments || [],
    attachmentsSkipped: !!result.attachmentsSkipped,
    received: m.receivedDateTime || '',
    timestamp: result.timestamp,
  };
}

// Själva körningen. `budget` kan skrivas över i test; handlern använder BUDGET.
async function runPoll(budget = BUDGET) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const autodraft = process.env.MAIL_AUTODRAFT === 'true';
  const log = {
    ran: new Date().toISOString(), autodraft, mailboxes: 0, considered: 0, triaged: 0,
    drafts: 0, attachmentsRead: 0, deferred: 0, hardStop: false, ms: 0, errors: [],
  };

  try {
    const defAddr = defaultMailbox().address;

    // 1. Nuvarande kö + per-brevlåde-lastSeen (migrera gammalt format).
    const { data } = await readJsonFile(FILE_PATH, { lastSeen: {}, items: [] });
    const { lastSeenMap, items: existingItems, migrated } = migrateState(data || {}, defAddr);

    // Delat tillstånd som både arbetsloopen och det hårda stoppet läser.
    // Uppdateras PER MEJL så att en ögonblicksbild alltid är konsistent.
    const newItems = [];       // nya poster över ALLA brevlådor (för denna körning)
    let lastSeenChanged = false;
    let stop = false;          // sätts av det hårda stoppet → loopen avbryter

    const work = async () => {
      const select = 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments';
      const mailboxes = await getMailboxes();
      log.mailboxes = mailboxes.length;
      const attachmentDeadline = t0 + budget.attachmentsMs;

      // 2. Iterera brevlåda för brevlåda.
      for (const mbCfg of mailboxes) {
        if (stop) return;
        const address = mbCfg.address;
        const prevSeen = lastSeenMap[address] || null;
        const lastSeen = prevSeen ? new Date(prevSeen).getTime() : 0;

        let messages;
        try {
          const inbox = await graphJson(
            `/users/${encodeURIComponent(address)}/mailFolders/inbox/messages` +
            `?$top=25&$select=${select}&$orderby=receivedDateTime desc`
          );
          messages = (inbox && inbox.value) || [];
        } catch (e) {
          // En brevlådas Graph-fel ska inte stoppa de andra.
          log.errors.push(`${address}: ${e.message}`);
          continue;
        }

        // 3. Nya + olästa, nyare än brevlådans lastSeen. Äldst först — så att
        //    ett avbrott mitt i aldrig hoppar över ett äldre mejl.
        const fresh = messages
          .filter(m => !m.isRead && new Date(m.receivedDateTime).getTime() > lastSeen)
          .sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime))
          .slice(0, MAX_PER_RUN);

        log.considered += fresh.length;

        for (let i = 0; i < fresh.length; i++) {
          const m = fresh[i];
          // Påbörja inget nytt mejl när budgeten är slut. De som återstår är
          // fortfarande olästa och nyare än lastSeen → nästa körning tar dem.
          if (stop || elapsed() > budget.startMs) {
            log.deferred += fresh.length - i;
            break;
          }
          try {
            const message = {
              id: m.id,
              subject: m.subject || '',
              fromName: m.from?.emailAddress?.name || '',
              fromAddress: m.from?.emailAddress?.address || '',
              received: m.receivedDateTime || '',
              conversationId: m.conversationId || '',
              // Kalender-detektering: @odata.type kommer per-post för härledda typer
              // (mötesmeddelanden) i inkorgskollektionen även utan explicit $select.
              odataType: m['@odata.type'] || '',
              meetingMessageType: m.meetingMessageType || '',
              text: m.bodyPreview || '',
              hasAttachments: !!m.hasAttachments,
            };
            // Pollern tar full kontext (inkl. tvärtråds-sökning och bilagor) och
            // en större retry-budget än den synkrona on-click-vägen.
            const result = await triageMessage(m.id, {
              message,
              autodraft,
              retryDelays: POLL_RETRY_DELAYS,
              includeCrossThread: true,
              includeAttachments: true,
              attachmentDeadline,
              mailbox: address,
            });
            // Blev körningen hårt stoppad medan det här mejlet pågick är
            // ögonblicksbilden redan tagen utan det — rör inget mer.
            if (stop) return;
            log.triaged++;
            if (result.draftId) log.drafts++;
            log.attachmentsRead += (result.attachments || []).filter(a => a.read).length;
            newItems.push(queueItem(result, m, address));
          } catch (e) {
            if (stop) return;
            log.errors.push(`${address}/${m.id}: ${e.message}`);
          }
          // Höj lastSeen oavsett triage-utfall så vi inte fastnar på ett
          // trasigt mejl — men först NU, när mejlet är färdigbehandlat.
          const cur = lastSeenMap[address];
          if (!cur || new Date(m.receivedDateTime) > new Date(cur)) {
            lastSeenMap[address] = m.receivedDateTime;
            lastSeenChanged = true;
          }
        }
      }
    };

    // Kör arbetet mot det hårda stoppet. Hinner arbetet klart vinner det;
    // annars sätts stop och det som hunnits skrivs.
    let timer;
    const hard = new Promise(res => {
      timer = setTimeout(() => { stop = true; log.hardStop = true; res(); }, Math.max(0, budget.hardStopMs - elapsed()));
    });
    try {
      await Promise.race([work(), hard]);
    } finally {
      clearTimeout(timer);
    }

    // 4. Persistera (nyast först i kön), om något hände eller migrering skedde.
    //    Ögonblicksbild: efter ett hårt stopp rör arbetsloopen inte tillståndet.
    const items = newItems.slice();
    const seen = { ...lastSeenMap };
    if (items.length || lastSeenChanged || migrated) {
      const merged = [...items.reverse(), ...existingItems].slice(0, MAX_QUEUE);
      await writeJsonFile(
        FILE_PATH,
        { lastSeen: seen, items: merged },
        `Mail-hub: ${items.length} nya triage-poster över ${log.mailboxes} brevlåda(or) (autodraft=${autodraft}` +
        (log.deferred ? `, ${log.deferred} till nästa körning` : '') +
        (log.hardStop ? ', hårt stopp' : '') + ')'
      );
    }
  } catch (e) {
    log.errors.push(e.message);
  }
  log.ms = elapsed();
  return log;
}

exports.runPoll = runPoll;
exports.BUDGET = BUDGET;

exports.handler = async () => {
  const log = await runPoll();
  // Icke-blockerande: alltid 200 så schemat inte spammar fel. Loggen syns i
  // Netlifys funktionslogg.
  console.log('[mail-poll]', JSON.stringify(log));
  return { statusCode: 200, body: JSON.stringify(log) };
};
