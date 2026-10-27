import { createHash } from 'node:crypto';

export function normalizeJid(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value);
  return match ? `${match[1]}@${match[2]}` : null;
}

export function eligibleText(item, identities) {
  const allowed = new Set(identities.map(normalizeJid).filter(Boolean));
  const key = item?.key;
  const peer = normalizeJid(key?.remoteJid);
  // Establish the linked self identity BEFORE inspecting any message content.
  if (!peer || !allowed.has(peer) || typeof key.id !== 'string' || !key.id || key.id.length > 256) return null;
  if (key.participant && !allowed.has(normalizeJid(key.participant))) return null;
  const content = item.message;
  if (!content || typeof content !== 'object') return null;
  const keys = Object.keys(content);
  if (keys.length !== 1 || !['conversation', 'extendedTextMessage'].includes(keys[0])) return null;
  const value = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof value !== 'string' || value.length > 2000 || !value.trim()) return null;
  return value.trim();
}

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 48);
export function stableIds(identity, messageId) {
  const canonical = normalizeJid(identity);
  if (!canonical) throw Error('linked_identity_unavailable');
  return { conversation_id: `wa_${digest(canonical)}`, request_id: `wa_${digest(`${canonical}\0${messageId}`)}` };
}
