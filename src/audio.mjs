import { InputFailure, asInputFailure } from './input-failure.mjs';

// Small delivery grammar: directed request + explicit medium, not a topic keyword.
const command = '(?:responde(?:me)?|contesta(?:me)?|manda(?:me)?|envia(?:me)?|dame|habla(?:me)?|explica(?:me)?|resume(?:me)?)';
const infinitive = '(?:responder|contestar|mandar|enviar|hablar|explicar|resumir|dar)';
const modal = '(?:puedes|podes|podrias)';
const directed = '(?:me\\s+(?:lo\\s+)?(?:respondes|contestas|mandas|envias|explicas)|' +
  'me\\s+' + modal + '\\s+' + infinitive + '|' + modal + '\\s+' + infinitive + 'me)';
const wish = '(?:quiero|necesito)(?:\\s+que\\s+(?:me\\s+)?(?:respondas|contestes|mandes|envies|hables|des))?';
const audioObject = '(?:(?:un\\s+)?audio|(?:una\\s+)?nota\\s+de\\s+voz)';
const markedMedium = '(?:en\\s+(?:(?:un\\s+)?audio|(?:una\\s+)?nota\\s+de\\s+voz)|por\\s+voz|con\\s+' + audioObject + ')';
const medium = '(?:' + markedMedium + '|hablad[oa]|' + audioObject + ')';
const response = '(?:(?:(?:la|una|tu)\\s+)?respuesta\\s+)?';
const lead = '(?:' + command + '|' + directed + '|' + wish + '|' + modal + '\\s+' + infinitive + '(?:me)?)';
const objectLead = '(?:manda(?:me)?|envia(?:me)?|dame|me\\s+(?:mandas|envias)|me\\s+' + modal +
  '\\s+(?:mandar|enviar|dar)|' + modal + '\\s+(?:mandar|enviar|dar)me|' + wish + ')';
const topic = '(?:(?!(?:y|si|cuando|ejemplo|expresion|significa|frase|decir)\\b)[a-z0-9]+\\s+){0,20}';
// A bounded topic may precede a marked format; a bare audio object needs a
// delivery verb so "explain audio" cannot silently authorize speech.
const request = new RegExp('\\b(?:' + lead + '\\s+' + topic + response + markedMedium + '|' +
  lead + '\\s+' + response + 'hablad[oa]|' + objectLead + '\\s+' + response + audioObject + ')\\b', 'g');
const fragment = new RegExp('^\\s*(?:por\\s+favor[,\\s]+)?(?=(?:en|por|con|hablad[oa])\\b)' + medium + '(?:[,\\s]+(?:por\\s+favor|porfa|pls))?\\s*$');
const nonCurrent = /\b(?:si(?!\s+(?:puedes|podes)\b)|cuando|dijo|dije|dice|digo|diga|comento|recomienda|traduce|traduci|pidiera|gustaria)\b/;
const quotedInstructionContext = /\b(?:ejemplo|expresion|significa|frase|decir)\b/;
const negativeLead = /\b(?:no|nunca|tampoco|sin)(?:\s+\w+){0,4}\s*$/;
const restriction = /(?:^|[,;.!?]|\b(?:pero|mejor|y)\s+)\s*(?:(?:pero|mejor)\s+)*(?:(?:(?:no|nunca|tampoco)\s+(?:me\s+)?(?:mandes|envies|respondas|contestes|hables)|no\s+(?:quiero|necesito|hace\s+falta|es\s+necesario))[^,;.!?]{0,60}\b(?:audio|voz|hablad[oa])\b|sin\s+(?:audio|voz)\b|(?:(?:responde(?:me)?|contesta(?:me)?|quiero)\s+)?(?:solo\s+)?(?:en\s+)?texto\b|(?:responde(?:me)?|contesta(?:me)?)\s+por\s+escrito\b)/g;

export function wantsAudio(text) {
  if (typeof text !== 'string' || text.length > 2000) return false;
  const normalized = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");
  // Keep offsets while masking quoted commands, including an unfinished quotation.
  const value = normalized.replace(/"[^"]*"|'[^']*'|`[^`]*`|["'`].*$/g, match => ' '.repeat(match.length));
  let accepted = -1;
  for (const match of value.matchAll(request)) {
    // Commas do not reset hypothetical/reporting scope; actual sentences do.
    const prefix = value.slice(0, match.index).split(/[.!?;\n]/).at(-1);
    const clausePrefix = prefix.split(/\by\b/).at(-1);
    if (!nonCurrent.test(prefix) && !quotedInstructionContext.test(clausePrefix) && !negativeLead.test(clausePrefix))
      accepted = match.index;
  }
  let offset = 0;
  for (const sentence of value.split(/[.!?;\n]/)) {
    if (fragment.test(sentence.replace(/[¿?]/g, ''))) accepted = offset;
    offset += sentence.length + 1;
  }
  if (accepted < 0) return false;
  // Explicit later text/voice restrictions win, not unrelated topic negation.
  return ![...value.matchAll(restriction)].some(match => match.index >= accepted);
}

export function validateAudioConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'api_key,base_url,stt_model,tts_model,voice_id' ||
      typeof config.api_key !== 'string' || !/^[!-~]{16,256}$/.test(config.api_key) ||
      typeof config.voice_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(config.voice_id) ||
      config.base_url !== 'https://api.elevenlabs.io' || config.stt_model !== 'scribe_v2' ||
      config.tts_model !== 'eleven_v4_turbo') throw Error('audio_configuration_invalid');
  return config;
}

export class AudioPipeline {
  constructor({ voice, media }) { this.voice = voice; this.media = media; this.closed = false; }
  assertOpen() { if (this.closed) throw Error('audio_pipeline_closed'); }
  async inputStage(stage, operation) {
    try { return await operation(); } catch (error) { throw asInputFailure(error, stage); }
  }
  async input(item, context) {
    this.assertOpen();
    if (item.kind === 'text') return { text: item.text };
    let bytes;
    try { bytes = await this.inputStage('download', () => this.media.download(item.message, context)); }
    finally { delete item.message; }
    this.assertOpen();
    await this.inputStage('inspect', () => this.media.inspectInput(bytes));
    this.assertOpen();
    const text = await this.inputStage('stt', () => this.voice.transcribe(bytes));
    this.assertOpen();
    if (typeof text !== 'string' || !text.trim() || text.length > 2000)
      throw new InputFailure('transcript_validation', 'invalid_transcript');
    return { text: text.trim() };
  }
  async output(text, currentMessage, requested = wantsAudio(currentMessage) ? 'audio' : 'text') {
    this.assertOpen();
    if (requested !== 'audio') return { text };
    let stage = 'synthesis';
    try {
      const bytes = await this.voice.synthesize(text);
      this.assertOpen();
      stage = 'encode';
      const result = await this.media.encodeOutput(bytes);
      this.assertOpen();
      // Positive measured seconds and explicit absent waveform avoid the SDK's unbounded optional decoder.
      return { ...result, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform: null };
    } catch {
      this.assertOpen(); // Cancellation is not a recoverable synthesis failure.
      return { text: 'No pude generar el audio. Te dejo la respuesta en texto:\n\n' + text, audio_failure: stage };
    }
  }
  close() { if (this.closed) return; this.closed = true; this.voice.close?.(); this.media.close?.(); }
}
