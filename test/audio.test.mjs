import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsAudio, AudioPipeline, validateAudioConfig } from '../src/audio.mjs';
import { ElevenLabsClient } from '../src/elevenlabs.mjs';
import { MediaBoundary, runTool } from '../src/media.mjs';
import { eligibleInput } from '../src/input-guard.mjs';
import { inputDiagnostic } from '../src/input-failure.mjs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const config = { api_key: 'FAKE_KEY_NOT_FOR_USE_1234567890', voice_id: 'FAKE_VOICE',
  base_url: 'https://api.elevenlabs.io', stt_model: 'scribe_v2', tts_model: 'eleven_v4_turbo' };
class FakeSocket extends EventTarget {
  static last;
  constructor(url) { super(); this.url = url; this.sent = []; FakeSocket.last = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(data) { this.sent.push(JSON.parse(data)); }
  frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('audio output consent belongs only to the current explicit request', () => {
  for (const value of ['Mándame un audio', 'Explica esto y responde hablado', 'Envíame una nota de voz',
    'Mandame un audio de lo que no entiendo', 'Mandame un audio diciendo hola y no agregues nada más',
    '¿Podés mandarme un audio sobre FastAPI?', 'Mandame un audio con la palabra "hola"',
    'Mandame un audio sobre enviar correo', 'Oye, pls mándame un audio',
    'Mándame un audio sobre "no entiendo"', '¿Puedes responderme hablado sobre LangGraph?',
    'oye mandame un audio de esto pls', 'Ahora respondeme hablado sobre LangGraph',
    'Si podés, mandame un audio sobre FastAPI',
    'Necesito que me mandes una nota de voz sobre el resultado'])
    assert.equal(wantsAudio(value), true);
  for (const value of ['Hola', 'audio', 'No me mandes un audio', '¿Puedes mandar un audio?',
    'El ejemplo dice "mandame un audio"', 'Si digo mandame un audio', 'Antes pedí un audio', 'Ahora texto',
    '“Mandame un audio”', 'Cuando diga mandame un audio', 'Dije mandame un audio',
    '¿Podés mandar audios?', 'Dijo "mandame un audio"', 'No me mandes audio, responde en texto',
    'No respondas hablado', 'No quiero que me mandes un audio', '¿Cómo puedo pedirte un audio?',
    'En el ejemplo dice: mandame un audio', 'Si te pido responde hablado, sería una orden',
    'Traduce mandame un audio al inglés', 'Explícame la expresión mandame un audio',
    'Mandame un audio, no me mandes audio', 'Mandame un audio, responde en texto'])
    assert.equal(wantsAudio(value), false);
});

const nonRequests = [
  'No hace falta mandarme un audio',
  '¿Eres capaz de responderme en audio?',
  'El cliente comentó que me mandas un audio',
  'Si mañana te pidiera algo, responde hablado',
];
for (const message of nonRequests) test('non-request does not authorize speech: ' + message, () => {
  assert.equal(wantsAudio(message), false);
});

test('negative, capability, reported and hypothetical language causes zero synthesis or media/network effects', async () => {
  let synthesis = 0; let encoding = 0;
  const pipeline = new AudioPipeline({ voice: { async synthesize() { synthesis++; throw Error('must not run'); } },
    media: { async encodeOutput() { encoding++; throw Error('must not run'); } } });
  for (const message of [...nonRequests, 'No necesito que me mandes una nota de voz',
    'Me dijo: ¿Podés mandarme un audio?', 'En un ejemplo, mandame un audio']) {
    assert.deepEqual(await pipeline.output('actual answer', message), { text: 'actual answer' });
  }
  assert.equal(synthesis, 0); assert.equal(encoding, 0);
});

test('audio input alone does not opt into speech; per-turn opt-in resets', async () => {
  let tts = 0;
  const pipeline = new AudioPipeline({ voice: { transcribe: async () => 'Hola',
    async synthesize() { tts++; return Buffer.from('mp3'); } },
    media: { download: async () => Buffer.from('ogg'), inspectInput: async () => {},
      encodeOutput: async () => ({ audio: Buffer.from('ogg'), seconds: 1 }) } });
  assert.equal((await pipeline.input({ kind: 'audio', message: {} })).text, 'Hola');
  assert.equal((await pipeline.output('respuesta', 'Hola')).text, 'respuesta');
  const spoken = await pipeline.output('respuesta', 'Mandame un audio');
  assert.equal(spoken.ptt, true); assert.equal(spoken.waveform, null);
  assert.equal((await pipeline.output('respuesta', 'Otra pregunta')).text, 'respuesta');
  assert.equal(tts, 1);
});

test('provider failure falls back only before an audio send, never reuses another model', async () => {
  const pipeline = new AudioPipeline({ voice: { synthesize: async () => { throw Error('secret'); } }, media: {} });
  const result = await pipeline.output('actual graph answer', 'Responde hablado');
  assert.match(result.text, /^No pude generar el audio/);
  assert.ok(result.text.endsWith('actual graph answer')); assert.doesNotMatch(result.text, /secret/);
});

test('private audio config accepts only official exact models and rejects hidden fallback', () => {
  const config = { api_key: 'FAKE_KEY_NOT_FOR_USE_1234567890', voice_id: 'FAKE_VOICE',
    base_url: 'https://api.elevenlabs.io', stt_model: 'scribe_v2', tts_model: 'eleven_v4_turbo' };
  assert.equal(validateAudioConfig(config).tts_model, 'eleven_v4_turbo');
  for (const patch of [{ tts_model: 'eleven_turbo_v2_5' }, { base_url: 'https://evil.test' }, { extra: true }])
    assert.throws(() => validateAudioConfig({ ...config, ...patch }));
});

test('TTD v4 authenticates in first JSON, flushes once and includes final audio chunk', async () => {
  const client = new ElevenLabsClient(config, { WebSocket: FakeSocket });
  const work = client.synthesize('answer'); await tick(); const ws = FakeSocket.last;
  assert.equal(ws.url.includes(config.api_key), false); assert.equal(ws.url.includes(config.voice_id), false);
  assert.deepEqual(ws.sent, [{ voices: [config.voice_id], xi_api_key: config.api_key },
    { inputs: [{ text: 'answer', voice_id: config.voice_id, new_turn: false }] }, { close_socket: true }]);
  ws.frame({ audio: Buffer.from('first').toString('base64'), is_final_audio_for_turn: true });
  assert.notEqual(ws.closed, true);
  ws.frame({ audio: Buffer.from('last').toString('base64'), is_final: true });
  assert.equal((await work).toString(), 'firstlast'); assert.equal(ws.closed, true);
});

test('TTD errors, incomplete close, timeout, cancellation and byte cap fail safely without retry', async () => {
  for (const action of [ws => ws.frame({ error: 'bad', message: 'SECRET_SENTINEL' }), ws => ws.close(),
    ws => ws.frame({ is_final: true }), ws => ws.frame({ audio: Buffer.alloc(2097153).toString('base64') })]) {
    const client = new ElevenLabsClient(config, { WebSocket: FakeSocket });
    const work = client.synthesize('answer'); const rejected = assert.rejects(work, error => error.message === 'audio_output_unavailable');
    await tick(); const ws = FakeSocket.last; action(ws); await rejected; assert.equal(ws.sent.length, 3);
  }
  const client = new ElevenLabsClient(config, { WebSocket: FakeSocket, timeoutMs: 5 });
  await assert.rejects(client.synthesize('answer'), /audio_output_unavailable/);
  const work = client.synthesize('answer'); client.close(); await assert.rejects(work, /audio_output_unavailable/);
});

test('Scribe uses exact batch model, bounded body, no redirect/retry and sanitized failures', async () => {
  let calls = 0;
  const client = new ElevenLabsClient(config, { fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['xi-api-key'], config.api_key);
    assert.equal(options.body.get('model_id'), 'scribe_v2'); assert.equal(options.body.get('file').size, 3);
    return new Response(JSON.stringify({ text: 'Hola' })); } });
  assert.equal(await client.transcribe(Buffer.from('ogg')), 'Hola'); assert.equal(calls, 1);
  for (const response of [new Response('SECRET_SENTINEL', { status: 429 }), new Response('x'.repeat(32769)),
    new Response(JSON.stringify({ text: 'x'.repeat(2001) }))]) {
    const failing = new ElevenLabsClient(config, { fetch: async () => response });
    await assert.rejects(failing.transcribe(Buffer.from('ogg')), error => error.message === 'audio_input_unavailable');
  }
  const deadline = new ElevenLabsClient(config, { timeoutMs: 5, fetch: (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('SECRET_SENTINEL')))) });
  await assert.rejects(deadline.transcribe(Buffer.from('ogg')), /audio_input_unavailable/);
});

test('shutdown cancels TTD promptly even if the remote close event never arrives', async () => {
  class SilentCloseSocket extends FakeSocket { close() { this.closed = true; } }
  const client = new ElevenLabsClient(config, { WebSocket: SilentCloseSocket, timeoutMs: 100 });
  let rejected = false;
  const work = client.synthesize('answer').catch(() => { rejected = true; });
  client.close(); await tick(); assert.equal(rejected, true); await work;
});

test('codec validates actual decoded duration and format, not metadata; pipe-only protocols', async () => {
  const calls = [];
  const tool = async (command, args, cap, _timeout, input) => {
    calls.push({ command, args, cap }); assert.ok(Buffer.isBuffer(input));
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe');
    if (command === 'ffprobe') return Buffer.from(JSON.stringify({ format: { format_name: 'ogg' }, streams: [{ codec_type: 'audio', codec_name: 'opus' }] }));
    return Buffer.alloc(args.includes('s16le') ? 32000 : 100);
  };
  const media = new MediaBoundary('unused-private-path', { tool });
  assert.deepEqual(await media.inspectInput(Buffer.from('ogg')), { seconds: 1 });
  assert.equal((await media.encodeOutput(Buffer.from('mp3'))).seconds, 1);
  assert.ok(calls.some(call => call.cap === 60 * 32000 + 1));
  const over = new MediaBoundary('unused', { tool: async (command) => command === 'ffprobe' ?
    Buffer.from('{"streams":[{"codec_type":"audio","codec_name":"opus"}]}') : Buffer.alloc(60 * 32000 + 1) });
  await assert.rejects(over.inspectInput(Buffer.from('ogg')), /duration/);
  await assert.rejects(media.inspectInput(Buffer.alloc(2097153)), /size/);
  const invalid = new MediaBoundary('unused', { tool: async () => Buffer.from('{"streams":[{"codec_type":"video","codec_name":"h264"}]}') });
  await assert.rejects(invalid.inspectInput(Buffer.from('ogg')), /format/);
});

test('real offline codecs produce Ogg Opus with measured duration and bounded process output', async () => {
  const wav = await runTool('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-f', 'wav', 'pipe:1'], 40000, 10000, Buffer.alloc(32000));
  const media = new MediaBoundary('unused'); const output = await media.encodeOutput(wav);
  assert.equal(output.audio.subarray(0, 4).toString(), 'OggS'); assert.equal(output.seconds, 1);
  const input = await media.inspectInput(output.audio); assert.ok(input.seconds > 0.99 && input.seconds < 1.01);
  await assert.rejects(runTool(process.execPath, ['-e', 'process.stdout.write("xxxx")'], 1), /codec/);
  await assert.rejects(runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 1, 5), /codec/);
  const controller = new AbortController();
  const work = runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 1, 10000, null, controller.signal);
  controller.abort(); await assert.rejects(work, /codec/);
});

test('large 30-second synthetic MP3 survives successful probe stdin EOF using only bounded pipes', async () => {
  const deadline = Date.now() + 10000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const mp3 = await runTool('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1',
    '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'],
  2097152, remaining(), Buffer.alloc(30 * 32000));
  assert.ok(mp3.length >= 256 * 1024 && mp3.length <= 2097152);
  const media = new MediaBoundary('unused', { tool: (command, args, cap, _timeout, input, signal, options) =>
    runTool(command, args, cap, remaining(), input, signal, options) });
  const output = await media.encodeOutput(mp3);
  assert.equal(output.audio.subarray(0, 4).toString(), 'OggS');
  assert.ok(output.seconds >= 30 && output.seconds <= 31);
  assert.ok(Date.now() <= deadline);
});

test('probe early pipe close requires bounded valid metadata and exit0; other process failures stay fatal', async () => {
  const metadata = JSON.stringify({ format: { format_name: 'mp3' },
    streams: [{ codec_type: 'audio', codec_name: 'mp3' }] });
  const early = 'process.stdout.write(' + JSON.stringify(metadata) + ');';
  const large = Buffer.alloc(1048576);
  const probe = { probeJson: true };
  const result = await runTool(process.execPath, ['-e', early], 16384, 1000, large, null, probe);
  assert.deepEqual(JSON.parse(result), JSON.parse(metadata));
  // Decoder/encoder calls have no probe privilege, even for the same early-close status.
  await assert.rejects(runTool(process.execPath, ['-e', early], 16384, 1000, large), /codec_unavailable/);
  for (const invalid of ['not-json', '{}', '[]', '"text"', '{"format":{"format_name":"mp3"},"streams":[]}',
    '{"streams":[{"codec_type":"audio","codec_name":"mp3"}]}',
    '{"format":{"format_name":"mp3"},"streams":[{"codec_type":"audio"}]}',
    '{"format":{"format_name":42},"streams":[{"codec_type":"audio","codec_name":"mp3"}]}',
    '{"format":{"format_name":"mp3"},"streams":{"length":1,"0":{"codec_type":"audio","codec_name":"mp3"}}}']) {
    await assert.rejects(runTool(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(invalid) + ')'],
      16384, 1000, null, null, probe), /codec_unavailable/);
  }
  await assert.rejects(runTool(process.execPath, ['-e', early + 'process.exitCode=2;'],
    16384, 1000, null, null, probe), /codec_unavailable/);
  await assert.rejects(runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    16384, 5, null, null, probe), /codec_unavailable/);
  await assert.rejects(runTool(process.execPath, ['-e', early], 1, 1000, null, null, probe), /codec_unavailable/);
  await assert.rejects(runTool('nonexistent-offline-codec-test-executable', [],
    16384, 1000, null, null, probe), /codec_unavailable/);
  const controller = new AbortController();
  const work = runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    16384, 1000, null, controller.signal, probe);
  controller.abort(); await assert.rejects(work, /codec_unavailable/);
});

test('closing the audio pipeline during download prevents every later stage', async () => {
  let finish; let inspections = 0; let stt = 0;
  const pipeline = new AudioPipeline({
    media: { download: () => new Promise(resolve => { finish = resolve; }), inspectInput: async () => { inspections++; },
      close() { finish(Buffer.from('fake')); } },
    voice: { transcribe: async () => { stt++; return 'unused'; } } });
  const work = pipeline.input({ kind: 'audio' });
  pipeline.close(); await assert.rejects(work, /closed/);
  assert.equal(inspections, 0); assert.equal(stt, 0);
});
