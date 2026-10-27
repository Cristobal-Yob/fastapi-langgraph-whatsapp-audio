import { spawn } from 'node:child_process';
import { downloadAudio } from './download-audio.mjs';
const MAX = 2 * 1024 * 1024;
function validProbeMetadata(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return typeof value?.format?.format_name === 'string' &&
      /^[a-z0-9_,]{1,80}$/.test(value.format.format_name) &&
      Array.isArray(value.streams) && value.streams.length === 1 && value.streams[0]?.codec_type === 'audio' &&
      typeof value.streams[0].codec_name === 'string' && /^[a-z0-9_]{1,40}$/.test(value.streams[0].codec_name);
  } catch { return false; }
}

export function runTool(command, args, maxOutput, timeoutMs = 20000, input = null, signal = null,
  { probeJson = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let size = 0; let failed = false; const chunks = [];
    const fail = () => { failed = true; child.kill(); };
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted) fail();
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', data => { size += data.length; if (size > maxOutput) fail(); else chunks.push(data); });
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); reject(Error('codec_unavailable')); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', fail);
      const bytes = Buffer.concat(chunks);
      if (failed || code !== 0 || (probeJson === true && !validProbeMetadata(bytes))) reject(Error('codec_unavailable'));
      else resolveResult(bytes);
    });
    child.stdin.on('error', error => {
      // A metadata probe may close stdin early. Defer only this expected pipe condition;
      // success still requires exit0 and valid bounded metadata, never a partial decode.
      if (probeJson === true && ['EPIPE', 'EOF'].includes(error?.code)) return;
      fail();
    });
    child.stdin.end(input);
  });
}

export class MediaBoundary {
  constructor(_privateTempRoot, { tool = runTool, downloadMediaMessage, request, downloadTimeoutMs = 25000 } = {}) {
    Object.assign(this, { tool, downloadMediaMessage, request, downloadTimeoutMs });
    this.controller = new AbortController();
  }
  download(item, context = {}) {
    return downloadAudio(item, { ...context, signal: this.controller.signal, timeoutMs: this.downloadTimeoutMs,
      downloader: this.downloadMediaMessage, request: this.request });
  }
  async inspectInput(bytes) { return this.job(bytes, 60, false); }
  async encodeOutput(bytes) { return this.job(bytes, 120, true); }
  async job(bytes, seconds, output) {
    if (this.controller.signal.aborted) throw Error('codec_unavailable');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX) throw Error('media_size_limit');
    // Pipe-only protocols prevent codec payloads from opening network URLs or local references.
    const flags = ['-v', 'error', '-protocol_whitelist', 'pipe', '-format_whitelist', 'ogg,mp3,wav,mov'];
    const probe = JSON.parse((await this.tool('ffprobe', [...flags, '-show_entries', 'format=format_name:stream=codec_type,codec_name', '-of', 'json', 'pipe:0'], 16384, 20000, bytes, this.controller.signal, { probeJson: true })).toString());
    if (probe.streams?.length !== 1 || probe.streams[0].codec_type !== 'audio' ||
        !['opus', 'mp3', 'pcm_s16le', 'aac', 'vorbis'].includes(probe.streams[0].codec_name)) throw Error('media_format_invalid');
    const pcm = await this.tool('ffmpeg', [...flags, '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], seconds * 32000 + 1, 20000, bytes, this.controller.signal);
    const duration = pcm.length / 32000;
    if (duration <= 0 || duration > seconds) throw Error('media_duration_limit');
    if (!output) return { seconds: duration };
    const encoded = await this.tool('ffmpeg', [...flags, '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48000', '-f', 'ogg', 'pipe:1'], MAX, 20000, bytes, this.controller.signal);
    if (encoded.length > MAX) throw Error('media_output_limit');
    const check = JSON.parse((await this.tool('ffprobe', [...flags, '-show_entries', 'format=format_name:stream=codec_type,codec_name', '-of', 'json', 'pipe:0'], 16384, 20000, encoded, this.controller.signal, { probeJson: true })).toString());
    if (check.format?.format_name !== 'ogg' || check.streams?.length !== 1 || check.streams[0].codec_name !== 'opus') throw Error('media_output_invalid');
    return { audio: encoded, seconds: Math.ceil(duration) };
  }
  close() { this.controller.abort(); }
}
