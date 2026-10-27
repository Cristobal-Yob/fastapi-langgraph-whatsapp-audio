const MAX_BYTES = 2 * 1024 * 1024;
import { InputFailure, asInputFailure } from './input-failure.mjs';
async function boundedBody(response, max) {
  if (!response.ok) throw new InputFailure('stt', 'http_status', { httpStatus: response.status });
  if (!response.body) throw new InputFailure('stt', 'stt_failed');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw new InputFailure('stt', 'response_limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export class ElevenLabsClient {
  constructor(config, { fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, timeoutMs = 30000 } = {}) {
    Object.assign(this, { config, fetch, WebSocket, timeoutMs }); this.controllers = new Set(); this.cancelOutputs = new Set();
  }
  async transcribe(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || !bytes.length) throw Error('audio_input_limit');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData(); form.set('model_id', this.config.stt_model);
      form.set('file', new Blob([bytes]), 'voice-input.audio');
      const response = await this.fetch(`${this.config.base_url}/v1/speech-to-text`, { method: 'POST',
        redirect: 'error', signal: controller.signal, headers: { 'xi-api-key': this.config.api_key }, body: form });
      const result = JSON.parse((await boundedBody(response, 32768)).toString('utf8'));
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000)
        throw new InputFailure('transcript_validation', 'invalid_transcript');
      return result.text;
    } catch (error) {
      if (controller.signal.aborted) throw new InputFailure('stt', 'timeout');
      throw asInputFailure(error, 'stt');
    }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  synthesize(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) return Promise.reject(Error('audio_output_limit'));
    return new Promise((resolve, reject) => {
      let ws; let finished = false; let size = 0; const chunks = [];
      const finish = (error, bytes) => {
        if (finished) return; finished = true; clearTimeout(timer); this.cancelOutputs.delete(cancel);
        try { ws?.close(); } catch {}
        if (error) reject(Error('audio_output_unavailable')); else resolve(bytes);
      };
      const cancel = () => finish(true); this.cancelOutputs.add(cancel);
      const timer = setTimeout(cancel, this.timeoutMs);
      try {
        ws = new this.WebSocket('wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_44100_128');
        ws.addEventListener('open', () => {
          if (finished) return;
          try {
            ws.send(JSON.stringify({ voices: [this.config.voice_id], xi_api_key: this.config.api_key }));
            ws.send(JSON.stringify({ inputs: [{ text, voice_id: this.config.voice_id, new_turn: false }] }));
            ws.send(JSON.stringify({ close_socket: true }));
          } catch { finish(true); }
        });
        ws.addEventListener('message', event => {
          if (finished) return;
          try {
            if (typeof event.data !== 'string' || event.data.length > MAX_BYTES * 2) throw Error('frame_limit');
            const value = JSON.parse(event.data); if (value.error) throw Error('provider_error');
            if (value.audio) {
              if (typeof value.audio !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) throw Error('audio_invalid');
              const chunk = Buffer.from(value.audio, 'base64'); size += chunk.length;
              if (size > MAX_BYTES) throw Error('audio_limit'); chunks.push(chunk);
            }
            if (value.is_final === true) finish(!size, Buffer.concat(chunks));
          } catch { finish(true); }
        });
        ws.addEventListener('error', () => finish(true)); ws.addEventListener('close', () => finish(true));
      } catch { finish(true); }
    });
  }
  close() { for (const controller of this.controllers) controller.abort(); for (const cancel of this.cancelOutputs) cancel(); }
}
