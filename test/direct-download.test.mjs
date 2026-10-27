import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createCipheriv, hkdfSync } from 'node:crypto';
import { MediaBoundary } from '../src/media.mjs';
import { eligibleInput } from '../src/input-guard.mjs';
import { inputDiagnostic } from '../src/input-failure.mjs';
import { AudioPipeline } from '../src/audio.mjs';

const owner = '15550000001@s.whatsapp.net';
const message = () => ({ key: { id: 'SYNTHETIC', remoteJid: owner },
  message: { audioMessage: { url: 'https://mmg.whatsapp.net/synthetic', directPath: '/synthetic',
    mediaKey: Buffer.alloc(32, 7), fileLength: 32, seconds: 1, mimetype: 'audio/ogg' } } });

test('direct SDK download receives the original accepted message and live socket refresh callback without a fork', async () => {
  const original = message();
  const input = eligibleInput(original, [owner], true);
  const refreshed = message(); let calls = 0; let refreshes = 0;
  const socket = { async updateMediaMessage(value) { refreshes++; assert.equal(value, original); return refreshed; } };
  let liveSocket = { updateMediaMessage() { assert.fail('stale socket'); } };
  const fetch = globalThis.fetch;
  const media = new MediaBoundary(null, {
    forkWorker() { assert.fail('download must not fork'); },
    async downloadMediaMessage(value, type, options, context) {
      calls++; assert.equal(value, original); assert.equal(type, 'stream');
      assert.equal(typeof options.options.dispatcher.dispatch, 'function');
      liveSocket = socket;
      assert.equal(await context.reuploadRequest(value), refreshed);
      context.logger.info({ secret: 'SECRET_URL_KEY' });
      return Readable.from([Buffer.from('synthetic')]);
    }
  });
  try {
    assert.deepEqual(await media.download(input.message, { getSocket: () => liveSocket }), Buffer.from('synthetic'));
    assert.equal(calls, 1); assert.equal(refreshes, 1); assert.equal(globalThis.fetch, fetch);
    assert.doesNotMatch(readFileSync(new URL('../src/media.mjs', import.meta.url), 'utf8'), /\bfork\b|media-worker/);
  } finally { media.close(); }
});

const clear = Buffer.from('synthetic offline plaintext');
function encrypted(bytes = clear) {
  const expanded = Buffer.from(hkdfSync('sha256', Buffer.alloc(32, 7), Buffer.alloc(0), Buffer.from('WhatsApp Audio Keys'), 112));
  const cipher = createCipheriv('aes-256-cbc', expanded.subarray(16, 48), expanded.subarray(0, 16));
  return Buffer.concat([cipher.update(bytes), cipher.final(), Buffer.alloc(10)]);
}
function requestFixture({ body = encrypted(), status = 200, mode = 'complete' } = {}) {
  const jobs = [];
  const request = (url, options, onResponse) => {
    assert.equal(url.hostname, 'mmg.whatsapp.net'); assert.equal(options.method, 'GET');
    const req = new EventEmitter(); jobs.push(req);
    req.destroy = () => { req.destroyed = true; req.response?.destroy(); };
    req.end = () => queueMicrotask(() => {
      if (mode === 'headers-stall') return;
      if (mode === 'network') { req.emit('error', Error('SECRET_URL_KEY')); return; }
      const response = mode === 'body-stall' || mode === 'stream-error' ? new Readable({ read() {} }) : Readable.from([body]);
      Object.assign(response, { statusCode: status, statusMessage: 'Fixture', rawHeaders: [], rawTrailers: [] });
      req.response = response; onResponse(response);
      if (mode === 'stream-error') response.destroy(Error('SECRET_TRANSCRIPT_KEY'));
    });
    return req;
  };
  return { request, jobs };
}

test('installed high-level SDK decrypts synthetic bytes through a per-job bounded dispatcher, never global fetch', async () => {
  const fixture = requestFixture(); const before = globalThis.fetch;
  const media = new MediaBoundary(null, fixture);
  try { assert.deepEqual(await media.download(message()), clear); }
  finally { media.close(); }
  assert.equal(fixture.jobs.length, 1); assert.equal(globalThis.fetch, before);
});

test('direct downloader bounds encrypted bytes, decrypted bytes and safe transport failures', async () => {
  for (const [options, expected] of [
    [{ body: Buffer.alloc(2097152 + 65537) }, { reason: 'byte_limit' }],
    [{ body: encrypted(Buffer.alloc(2097153)) }, { reason: 'byte_limit' }],
    [{ status: 302 }, { reason: 'http_status', http_status: 302 }],
    [{ status: 404 }, { reason: 'http_status', http_status: 404 }],
    [{ mode: 'network' }, { reason: 'network_failed' }],
    [{ mode: 'stream-error' }, { reason: 'stream_failed' }],
    [{ mode: 'headers-stall' }, { reason: 'timeout' }],
    [{ mode: 'body-stall' }, { reason: 'timeout' }],
    [{ body: Buffer.alloc(29) }, { reason: 'sdk_stream_failed' }]
  ]) {
    const fixture = requestFixture(options);
    const media = new MediaBoundary(null, { ...fixture, downloadTimeoutMs: 100 });
    try {
      await assert.rejects(media.download(message()), error => {
        assert.deepEqual(inputDiagnostic(error), { stage: 'download', ...expected }); return true;
      });
      if (options.mode?.includes('stall')) assert.equal(fixture.jobs[0].destroyed, true);
      assert.equal(fixture.jobs.length, 1);
    } finally { media.close(); }
  }
});

test('shutdown aborts native request before/after headers and destroys late SDK streams', async () => {
  for (const mode of ['headers-stall', 'body-stall']) {
    const fixture = requestFixture({ mode }); const media = new MediaBoundary(null, fixture);
    const work = media.download(message()); const rejected = assert.rejects(work, /audio_download_unavailable/);
    await new Promise(resolve => setImmediate(resolve)); media.close(); await rejected;
    assert.equal(fixture.jobs[0].destroyed, true);
    await assert.rejects(media.download(message()), /audio_download_unavailable/);
    assert.equal(fixture.jobs.length, 1);
  }
  let release;
  const media = new MediaBoundary(null, { downloadMediaMessage: () => new Promise(resolve => { release = resolve; }) });
  const work = media.download(message()); const rejected = assert.rejects(work);
  await new Promise(resolve => setImmediate(resolve)); media.close(); await rejected;
  const stream = Readable.from([clear]); release(stream);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stream.destroyed, true);
});

test('invalid locations and keys fail without HTTPS, and original message is released before STT', async () => {
  const fixture = requestFixture(); const media = new MediaBoundary(null, fixture);
  try {
    for (const url of ['https://evil.test/x', 'http://mmg.whatsapp.net/x', 'https://mmg.whatsapp.net:444/x']) {
      const item = message(); item.message.audioMessage.url = url; delete item.message.audioMessage.directPath;
      await assert.rejects(media.download(item), error => inputDiagnostic(error).reason === 'invalid_payload');
    }
    for (const key of [undefined, {}, Buffer.alloc(31), new Uint8Array(33)]) {
      const item = message(); item.message.audioMessage.mediaKey = key;
      await assert.rejects(media.download(item), error => inputDiagnostic(error).reason === 'invalid_payload');
    }
    assert.equal(fixture.jobs.length, 0);
  } finally { media.close(); }
  const input = eligibleInput(message(), [owner], true);
  const pipeline = new AudioPipeline({ media: { download: async () => clear, inspectInput: async () => {} },
    voice: { transcribe: async () => { assert.equal(input.message, undefined); return 'synthetic text'; } } });
  assert.deepEqual(await pipeline.input(input), { text: 'synthetic text' });
});
