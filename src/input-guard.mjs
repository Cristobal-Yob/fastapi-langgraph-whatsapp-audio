import { normalizeJid } from './guard.mjs';
export { normalizeJid, stableIds } from './guard.mjs';

export function eligibleInput(item, identities, allowAudio = false) {
  const allowed = new Set(identities.map(normalizeJid).filter(Boolean));
  const key = item?.key;
  const peer = normalizeJid(key?.remoteJid);
  // Establish the linked self identity BEFORE inspecting any message content.
  if (!peer || !allowed.has(peer) || typeof key.id !== 'string' || !key.id || key.id.length > 256) return null;
  if (key.participant && !allowed.has(normalizeJid(key.participant))) return null;
  const content = item.message;
  if (!content || typeof content !== 'object') return null;
  const keys = Object.keys(content);
  if (keys.length !== 1) return null;
  if (allowAudio && keys[0] === 'audioMessage') {
    const audio = content.audioMessage;
    const bytes = Number(audio?.fileLength); const seconds = Number(audio?.seconds);
    if (!audio || !Number.isFinite(bytes) || bytes <= 0 || bytes > 2 * 1024 * 1024 ||
        !Number.isFinite(seconds) || seconds <= 0 || seconds > 60 ||
        typeof audio.mimetype !== 'string' || !/^audio\/(ogg|mpeg|mp4|wav)(?:;.*)?$/.test(audio.mimetype)) return null;
    // The SDK refresh callback needs the original message key and media envelope.
    // Retain it only in the bounded RAM queue until this download finishes.
    return { kind: 'audio', message: item };
  }
  if (!['conversation', 'extendedTextMessage'].includes(keys[0])) return null;
  const value = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof value !== 'string' || value.length > 2000 || !value.trim()) return null;
  return { kind: 'text', text: value.trim() };
}
