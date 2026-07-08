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

const { graphJson } = require('./lib/graph');
const { triageMessage, POLL_RETRY_DELAYS } = require('./lib/triage');
const { readJsonFile, writeJsonFile } = require('./lib/store');
const { getMailboxes, defaultMailbox } = require('./lib/mailboxes');

const FILE_PATH = 'data/mail-queue.json';
const MAX_PER_RUN = 10;
const MAX_QUEUE = 100;

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

exports.handler = async () => {
  const autodraft = process.env.MAIL_AUTODRAFT === 'true';
  const log = { ran: new Date().toISOString(), autodraft, mailboxes: 0, considered: 0, triaged: 0, drafts: 0, errors: [] };

  try {
    const defAddr = defaultMailbox().address;

    // 1. Nuvarande kö + per-brevlåde-lastSeen (migrera gammalt format).
    const { data } = await readJsonFile(FILE_PATH, { lastSeen: {}, items: [] });
    const { lastSeenMap, items: existingItems, migrated } = migrateState(data || {}, defAddr);

    const select = 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead';
    const mailboxes = await getMailboxes();
    log.mailboxes = mailboxes.length;

    const newItems = [];       // nya poster över ALLA brevlådor (för denna körning)
    let lastSeenChanged = false;

    // 2. Iterera brevlåda för brevlåda.
    for (const mbCfg of mailboxes) {
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

      // 3. Nya + olästa, nyare än brevlådans lastSeen. Äldst först.
      const fresh = messages
        .filter(m => !m.isRead && new Date(m.receivedDateTime).getTime() > lastSeen)
        .sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime))
        .slice(0, MAX_PER_RUN);

      log.considered += fresh.length;

      let newestSeen = prevSeen;

      for (const m of fresh) {
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
          };
          // Pollern har lång timeout → större retry-budget + full kontext
          // (inkl. tvärtråds-sökning) än den synkrona on-click-vägen.
          const result = await triageMessage(m.id, {
            message,
            autodraft,
            retryDelays: POLL_RETRY_DELAYS,
            includeCrossThread: true,
            mailbox: address,
          });
          log.triaged++;
          if (result.draftId) log.drafts++;
          newItems.push({
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
            received: m.receivedDateTime || '',
            timestamp: result.timestamp,
          });
        } catch (e) {
          log.errors.push(`${address}/${m.id}: ${e.message}`);
        }
        // Höj lastSeen oavsett triage-utfall så vi inte fastnar på ett trasigt mejl.
        if (!newestSeen || new Date(m.receivedDateTime) > new Date(newestSeen)) {
          newestSeen = m.receivedDateTime;
        }
      }

      if (newestSeen !== prevSeen) {
        lastSeenMap[address] = newestSeen;
        lastSeenChanged = true;
      }
    }

    // 4. Persistera (nyast först i kön), om något hände eller migrering skedde.
    if (newItems.length || lastSeenChanged || migrated) {
      const merged = [...newItems.reverse(), ...existingItems].slice(0, MAX_QUEUE);
      await writeJsonFile(
        FILE_PATH,
        { lastSeen: lastSeenMap, items: merged },
        `Mail-hub: ${newItems.length} nya triage-poster över ${mailboxes.length} brevlåda(or) (autodraft=${autodraft})`
      );
    }

    return { statusCode: 200, body: JSON.stringify(log) };
  } catch (e) {
    log.errors.push(e.message);
    // Icke-blockerande: logga och returnera 200 så schemat inte spammar fel.
    return { statusCode: 200, body: JSON.stringify(log) };
  }
};
