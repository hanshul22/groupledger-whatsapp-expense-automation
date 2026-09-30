// pushNameCache.js
// Small in-memory JID -> WhatsApp display name (pushName) cache.
//
// Why this exists: Baileys' 'messages.reaction' event carries only JIDs
// (see waConnector.js/approvalEngine.js's handleReaction) — no display
// name, unlike a regular text message (which carries `msg.pushName`).
// Without this cache, an admin who APPROVEs/REJECTs via a ✅/❌ reaction
// always falls back to a cleaned-up JID in the Resolution's
// approved_by/rejected_by (see decisionProcessor.js's
// formatResponderIdentity) rather than their real name.
//
// This cache is populated from every incoming group text message (which
// does carry `pushName`) and is later consulted, by JID, when a reaction
// arrives — resolving a name as long as that person has sent at least one
// message in the group since this process started.
//
// Deliberately process-memory-only, not persisted to disk: a stale/wrong
// cached name is a cosmetic, self-correcting issue (the next message from
// that JID refreshes it), so the complexity of persistence isn't
// warranted here.

/**
 * Create a new, empty pushName cache.
 *
 * @returns {{
 *   remember: (jid: string, pushName: string|null|undefined) => void,
 *   get: (jid: string) => string|undefined,
 * }}
 */
function createPushNameCache() {
  const namesByJid = new Map();

  /**
   * Record/refresh the display name seen for a JID. A falsy/empty
   * `pushName` is a no-op (never overwrites a previously known good name
   * with nothing).
   *
   * @param {string} jid
   * @param {string|null|undefined} pushName
   */
  function remember(jid, pushName) {
    if (!jid || !pushName || !pushName.trim()) return;
    namesByJid.set(jid, pushName.trim());
  }

  /**
   * Look up the last-seen display name for a JID.
   *
   * @param {string} jid
   * @returns {string|undefined}
   */
  function get(jid) {
    return namesByJid.get(jid);
  }

  return { remember, get };
}

module.exports = {
  createPushNameCache,
};
