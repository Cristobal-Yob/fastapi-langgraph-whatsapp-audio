import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { Gateway } from './gateway.mjs';
import { eligibleText } from './guard.mjs';

const audio = process.env.APP_VARIANT === 'whatsapp-audio';
let parse = (item,identities) => { const text = eligibleText(item,identities); return text ? { kind:'text',text } : null; };
let pipeline = null;
if (audio) {
  const { eligibleInput } = await import('./input-guard.mjs'); parse = eligibleInput;
  const { AudioPipeline, validateAudioConfig } = await import('./audio.mjs');
  const { ElevenLabsClient } = await import('./elevenlabs.mjs');
  const { MediaBoundary } = await import('./media.mjs');
  const config = validateAudioConfig({ api_key:process.env.ELEVENLABS_API_KEY,base_url:'https://api.elevenlabs.io',
    stt_model:'scribe_v2',tts_model:'eleven_v4_turbo',voice_id:process.env.ELEVENLABS_VOICE_ID });
  pipeline = new AudioPipeline({ voice:new ElevenLabsClient(config),media:new MediaBoundary(null) });
}
const gateway = new Gateway({ parse,pipeline,audio });
const token = process.env.AGENT_API_TOKEN ?? ''; const origin = process.env.PUBLIC_ORIGIN ?? '';
if (!/^[A-Za-z0-9_-]{43,128}$/.test(token) || new Set(token).size < 16 || !/^https:\/\/[^/]+$/.test(origin)) throw Error('operator_configuration_required');
const csrf = randomBytes(32).toString('base64url');
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req,res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res,200,{status:'ok'});
    if (req.method === 'GET' && req.url === '/') {
      const { readFile } = await import('node:fs/promises');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY'});
      return res.end(await readFile(new URL('./index.html',import.meta.url)));
    }
    if (!equal(req.headers.authorization,`Bearer ${token}`)) return json(res,401,{error:'operator_authentication_required'});
    if (req.headers.origin && req.headers.origin !== origin) return json(res,403,{error:'trusted_origin_required'});
    if (req.method === 'POST' && (req.headers.origin !== origin || !equal(req.headers['x-csrf-token'],csrf)))
      return json(res,403,{error:'csrf_required'});
    if (req.method === 'GET' && req.url === '/api/status') return json(res,200,{status:gateway.status,csrf});
    if (req.method === 'GET' && req.url === '/api/qr') return json(res,200,{image:gateway.qr ? await QRCode.toDataURL(gateway.qr) : null});
    if (req.method === 'POST' && req.url === '/api/connect') {
      if (gateway.status !== 'disabled') return json(res,409,{error:'already_started_or_review_required'});
      gateway.status = 'preparing';
      void gateway.connect().catch(()=>gateway.halt());
      return json(res,202,{status:'preparing'});
    }
    if (req.method === 'POST' && req.url === '/api/stop') { gateway.halt(); return json(res,202,{status:gateway.status}); }
    return json(res,404,{error:'not_found'});
  } catch { return json(res,503,{error:'operation_unavailable_no_automatic_retry'}); }
});
server.requestTimeout = 10000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? 8000),'0.0.0.0');
for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{
  server.close(); void gateway.close().finally(()=>process.exit(0));
  setTimeout(()=>process.exit(1),20000).unref();
});
