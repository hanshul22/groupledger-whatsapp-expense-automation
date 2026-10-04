// waConnector.js
// Phase 1 — all Baileys (WhatsApp) connection logic lives here.
//
// Responsibilities (per implementation-plan.md Phase 1 / TRD §2):
//   - Establish and persist a WhatsApp session via Baileys, using local
//     multi-file auth state (Redis-backed auth state is a later, Render-
//     deployment-phase concern — not this one).
//   - Print a scannable QR code on first connect.
//   - Auto-reconnect on any disconnect that isn't an explicit logout.
//   - Discover the target group's chat ID by logging every incoming chat ID
//     until WHATSAPP_GROUP_ID is configured.
//   - Once configured, only forward messages from that group to the caller.
//   - Expose a live (non-cached) admin check against group metadata.
//   - Expose a helper to extract plain text from a Baileys message object.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');

const { computeBackoffDelayMs } = require('./reconnectBackoff');

const logger = pino({ level: 'info' });

const AUTH_DIR = './auth';

/**
 * Extract plain text from a Baileys message object.
 * Covers conversation, extendedTextMessage.text, and image/video captions.
 * Returns null if no text content is found.
 */
function extractText(msg) {
  const message = msg?.message;
  if (!message) return null;

  if (message.conversation) {
    return message.conversation;
  }
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }
  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  return null;
}

/**
 * Extract the id of the message a given message is quoting/replying to
 * (WhatsApp's "reply" feature), if any.
 *
 * Baileys surfaces this as `message.extendedTextMessage.contextInfo.stanzaId`
 * — present whenever the user tapped "Reply" on a message before sending
 * their text, regardless of chat type (group or DM).
 *
 * @param {object} msg - A Baileys message object.
 * @returns {string|null}
 */
function extractQuotedMessageId(msg) {
  const contextInfo = msg?.message?.extendedTextMessage?.contextInfo;
  return contextInfo?.stanzaId || null;
}

/**
 * Check whether a participant is a current admin of a group.
 * Always fetches live group metadata (not cached), per architecture.md §4
 * ("Admin authority check: always re-verified live").
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} groupId
 * @param {string} participantJid
 * @returns {Promise<boolean>}
 */
async function isGroupAdmin(sock, groupId, participantJid) {
  const metadata = await sock.groupMetadata(groupId);
  // WhatsApp groups mix @lid (linked-device/anonymous) and
  // @s.whatsapp.net (phone-number) identifier spaces depending on the
  // group's addressingMode. A single field-to-field string comparison
  // (e.g. `p.id === participantJid`) is unreliable because the caller's
  // JID and each participant's `id` may come from different spaces even
  // when they refer to the same person. Match against every identifier
  // variant Baileys exposes for each participant (`id`, `lid`, `jid`) —
  // see node_modules/@whiskeysockets/baileys/lib/Types/Contact.d.ts.
  const participant = metadata.participants.find(
    (p) => p.id === participantJid || p.lid === participantJid || p.jid === participantJid
  );
  if (!participant) return false;
  return participant.admin === 'admin' || participant.admin === 'superadmin';
}

/**
 * Start (or restart, on reconnect) the WhatsApp connection.
 *
 * @param {object} handlers
 * @param {(sock: any, msg: any) => void} handlers.onGroupMessage - called only for
 *   messages arriving in the configured WHATSAPP_GROUP_ID group.
 * @param {(sock: any) => void} handlers.onReady - called once the connection opens.
 * @param {(sock: any, reaction: any) => void} handlers.onReaction - called once per
 *   reaction event received via the 'messages.reaction' listener.
 * @param {(qr: string) => void} [handlers.onQrCode] - called with the raw
 *   QR string every time Baileys issues a new one, in addition to (not
 *   instead of) the existing terminal print. Render's web log viewer
 *   mangles ASCII-art QR codes (each line gets its own timestamp prefix,
 *   breaking the grid), making the terminal QR unscannable on a host
 *   where logs are the only console you have — this hook lets index.js
 *   also serve the same QR as a real image over HTTP (GET /qr) as a
 *   reliable fallback.
 * @param {() => void} [handlers.onDisconnected] - Phase 7. Called once,
 *   synchronously, whenever the connection closes — including when it will
 *   NOT auto-reconnect (explicit logout) — before that logout check runs.
 *   Lets a Connection_Monitor (src/connectionMonitor.js) start tracking a
 *   continuous outage the moment it begins.
 * @param {() => Promise<{state: any, saveCreds: () => Promise<void>}>} [handlers.getAuthState] -
 *   Phase 7. Defaults to `() => useMultiFileAuthState(AUTH_DIR)` — today's
 *   exact behavior — so omitting this parameter entirely leaves existing
 *   deployments unaffected (Requirement 3.5). Pass a Redis-backed factory
 *   (src/authState.js's `createAuthStateFactory`) to persist the session
 *   remotely instead of to local disk.
 * @param {(fn: () => void, delayMs: number) => any} [handlers.setTimeoutFn] -
 *   Phase 7. Defaults to the global `setTimeout`. Test seam for
 *   deterministically asserting reconnect scheduling without a real delay.
 * @param {number} [handlers.reconnectAttempt] - Phase 7. Defaults to `0`.
 *   0-indexed consecutive-failed-reconnect count, threaded through
 *   recursive `startWhatsApp` calls so `computeBackoffDelayMs` can compute
 *   an increasing delay (Requirements 1.1, 1.2) and reset to `0` after a
 *   successful connection (Requirement 1.3).
 */
async function startWhatsApp({
  onGroupMessage,
  onReady,
  onReaction,
  onDisconnected,
  onQrCode,
  getAuthState = () => useMultiFileAuthState(AUTH_DIR),
  setTimeoutFn = setTimeout,
  reconnectAttempt = 0,
}) {
  const { state, saveCreds } = await getAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  // 0-indexed consecutive-failed-reconnect count for THIS connection
  // attempt onward. Reset to 0 on a successful 'open' (Requirement 1.3),
  // so a later disconnect starts backing off from the minimum delay again.
  let currentAttempt = reconnectAttempt;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with the dedicated bot WhatsApp number:');
      qrcodeTerminal.generate(qr, { small: true });
      if (typeof onQrCode === 'function') {
        onQrCode(qr);
      }
    }

    if (connection === 'open') {
      currentAttempt = 0; // Requirement 1.3
      console.log('WhatsApp connection established.');
      if (typeof onReady === 'function') {
        onReady(sock);
      }
    }

    if (connection === 'close') {
      if (typeof onDisconnected === 'function') {
        onDisconnected(); // Requirement 2.1's trigger point — fires even on logout
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.error(
          'WhatsApp session was logged out. Delete the /auth folder and restart ' +
            'the bot to re-scan the QR code. Will NOT auto-reconnect.'
        );
        return; // Requirement 1.4 — never reconnect on explicit logout
      }

      const delayMs = computeBackoffDelayMs(currentAttempt); // Requirements 1.1, 1.2
      console.warn(
        `WhatsApp connection closed (statusCode: ${statusCode}). ` +
          `Reconnecting in ${delayMs}ms (attempt ${currentAttempt + 1})...`
      );
      setTimeoutFn(() => {
        startWhatsApp({
          onGroupMessage,
          onReady,
          onReaction,
          onDisconnected,
          onQrCode,
          getAuthState,
          setTimeoutFn,
          reconnectAttempt: currentAttempt + 1,
        });
      }, delayMs);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const text = extractText(msg);
      if (!text) continue;

      const chatId = msg.key.remoteJid;
      const configuredGroupId = process.env.WHATSAPP_GROUP_ID;

      if (!configuredGroupId) {
        console.log(`Incoming chat ID: ${chatId}`);
        continue;
      }

      if (chatId !== configuredGroupId) continue;

      if (typeof onGroupMessage === 'function') {
        // A failure handling one message must never crash the process or
        // block the rest of this batch — log and move on (Baileys' own
        // EventEmitter has no idea this listener returns a promise, so an
        // uncaught rejection here would otherwise be unhandled).
        try {
          await onGroupMessage(sock, msg);
        } catch (err) {
          console.error('onGroupMessage handler failed:', err);
        }
      }
    }
  });

  sock.ev.on('messages.reaction', async (reactions) => {
    for (const reaction of reactions) {
      if (typeof onReaction === 'function') {
        try {
          await onReaction(sock, reaction);
        } catch (err) {
          console.error('onReaction handler failed:', err);
        }
      }
    }
  });

  return sock;
}

module.exports = {
  startWhatsApp,
  isGroupAdmin,
  extractText,
  extractQuotedMessageId,
};
