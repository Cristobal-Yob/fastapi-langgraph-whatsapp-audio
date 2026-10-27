import { request as httpsRequest } from 'node:https';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { InputFailure, asInputFailure } from './input-failure.mjs';
const MAX = 2 * 1024 * 1024;
const silentLogger = Object.freeze({ info() {}, debug() {}, warn() {}, error() {} });

// rc14 forwards only dispatcher/headers to fetch, not AbortSignal. This per-job
// dispatcher keeps native HTTPS requests cancellable without replacing global fetch.
function mediaDispatcher(request, fail, recordStatus) {
  const requests = new Set(); let closed = false;
  return {
    dispatch(options, handler) {
      if (closed) { handler.onError(new InputFailure('download', 'download_failed')); return false; }
      let url;
      try {
        url = new URL(options.path, options.origin);
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
            !/(^|\.)whatsapp\.(net|com)$/.test(url.hostname) || options.method !== 'GET') throw Error();
      } catch {
        const error = new InputFailure('download', 'invalid_payload');
        fail(error); handler.onError(error); return false;
      }
      let req; let response; let delivered = false;
      const cancel = () => {
        requests.delete(cancel); req?.destroy(); response?.destroy();
        if (!delivered) { delivered = true; handler.onError(new InputFailure('download', 'download_failed')); }
      };
      requests.add(cancel);
      try {
        req = request(url, { method: 'GET', headers: options.headers }, value => {
          response = value;
          const status = response.statusCode;
          recordStatus(status);
          if (status >= 300 && status <= 399) {
            fail(new InputFailure('download', 'http_status', { httpStatus: status })); return;
          }
          let size = 0; const chunks = [];
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX + 65536) { fail(new InputFailure('download', 'byte_limit')); return; }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (delivered) return;
            delivered = true; requests.delete(cancel);
            // Complete bounded encrypted bytes first: rc14's pipe does not
            // forward source errors to its decryptor.
            handler.onHeaders(status, response.rawHeaders, () => {}, response.statusMessage);
            handler.onData(Buffer.concat(chunks, size)); handler.onComplete(response.rawTrailers);
          });
          response.once('error', () => fail(new InputFailure('download', 'stream_failed')));
          response.once('aborted', () => fail(new InputFailure('download', 'stream_failed')));
        });
        req.once('error', () => fail(new InputFailure('download', 'network_failed')));
        handler.onConnect(cancel); req.end();
      } catch { fail(new InputFailure('download', 'network_failed')); }
      return true;
    },
    close() { closed = true; for (const cancel of requests) cancel(); }
  };
}

export async function downloadAudio(item, { getSocket, signal, timeoutMs = 25000,
  downloader = downloadMediaMessage, request = httpsRequest } = {}) {
  const media = item?.message?.audioMessage;
  if (!media || (!media.url && !media.directPath) || !(media.mediaKey instanceof Uint8Array) ||
      media.mediaKey.byteLength !== 32) throw new InputFailure('download', 'invalid_payload');
  let stream; let stopped = false; let rejectStopped; let httpStatus;
  const interrupted = new Promise((_resolve, reject) => { rejectStopped = reject; });
  const fail = error => {
    if (stopped) return;
    stopped = true; rejectStopped(error); stream?.destroy(); dispatcher.close();
  };
  const dispatcher = mediaDispatcher(request, fail, status => { httpStatus = status; });
  const abort = () => fail(new InputFailure('download', 'download_failed'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new InputFailure('download', 'timeout')), timeoutMs);
  const bounded = promise => Promise.race([promise, interrupted]);
  try {
    if (signal?.aborted) abort();
    if (stopped) return await interrupted;
    const pending = Promise.resolve().then(() => downloader(item, 'stream', { options: { dispatcher } }, {
      logger: silentLogger,
      reuploadRequest: message => {
        if (stopped) throw new InputFailure('download', 'download_failed');
        const socket = getSocket?.();
        if (!socket?.updateMediaMessage) throw new InputFailure('download', 'sdk_setup_failed');
        return bounded(socket.updateMediaMessage(message));
      }
    }));
    // A late SDK result must not keep a stream alive after shutdown/deadline.
    void pending.then(value => { if (stopped) value.destroy(); }, () => {});
    try { stream = await bounded(pending); }
    catch (error) {
      if (!stopped && httpStatus >= 400) throw new InputFailure('download', 'http_status', { httpStatus });
      throw asInputFailure(error, 'download', 'sdk_setup_failed');
    }
    const collect = async () => {
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX) throw new InputFailure('download', 'byte_limit');
        chunks.push(chunk);
      }
      if (!size) throw new InputFailure('download', 'sdk_stream_failed');
      return Buffer.concat(chunks, size);
    };
    try { return await bounded(collect()); }
    catch (error) { throw asInputFailure(error, 'download', 'sdk_stream_failed'); }
  } finally {
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    stream?.destroy(); dispatcher.close();
  }
}
