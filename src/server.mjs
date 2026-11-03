import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { validPhone } from './pairing.mjs';

const equal=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,value)=>{
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  res.end(JSON.stringify(value));
};
async function body(req,key) {
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')) throw Error('invalid_input');
  let bytes=0; const chunks=[];
  for await(const chunk of req) { bytes+=chunk.length; if(bytes>256)throw Error('invalid_input'); chunks.push(chunk); }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !Object.hasOwn(value,key))
    throw Error('invalid_input');
  return value[key];
}

export function createOperatorServer({createGateway,token,origin,encodeQr=value=>QRCode.toDataURL(value)}) {
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(token??'') || new Set(token).size<16 || !/^https:\/\/[^/]+$/.test(origin??''))
    throw Error('operator_configuration_required');
  let gateway=createGateway(), lifecycle='idle', stopping=null, lifecycleRevision=0;
  const csrf=randomBytes(32).toString('base64url');
  const stop=()=>{
    if(stopping) return stopping;
    if(lifecycle==='stopped') return Promise.resolve();
    lifecycle='stopping';lifecycleRevision++; const previous=gateway;
    stopping=Promise.resolve().then(()=>previous.close()).then(()=>{
      if(gateway===previous)lifecycle='stopped';
    }).catch(()=>{if(gateway===previous)lifecycle='review_required'}).finally(()=>{stopping=null});
    return stopping;
  };
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='GET' && req.url==='/health')return json(res,200,{status:'ok'});
      if(req.method==='GET' && req.url==='/') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY'});
        return res.end(await readFile(new URL('./index.html',import.meta.url)));
      }
      if(!equal(req.headers.authorization,`Bearer ${token}`))return json(res,401,{error:'operator_authentication_required'});
      if(req.headers.origin && req.headers.origin!==origin)return json(res,403,{error:'trusted_origin_required'});
      if(req.method==='POST' && (req.headers.origin!==origin || !equal(req.headers['x-csrf-token'],csrf)))
        return json(res,403,{error:'csrf_required'});
      if(req.method==='GET' && req.url==='/api/status')return json(res,200,{
        ...gateway.pairing.publicState(),status:lifecycle==='idle' ? gateway.status : lifecycle,csrf});
      if(req.method==='GET' && req.url==='/api/code')return json(res,200,
        lifecycle==='idle' && !gateway.closed ? gateway.pairing.codeResult() : {code:null,expires_at:null});
      if(req.method==='GET' && req.url==='/api/qr')return json(res,200,{image:
        lifecycle==='idle' && !gateway.closed && gateway.pairing.mode==='qr' && gateway.qr ? await encodeQr(gateway.qr) : null});
      if(req.method==='POST' && req.url==='/api/connect') {
        if(lifecycle==='stopping' || stopping || (lifecycle!=='stopped' && gateway.status!=='disabled'))
          return json(res,409,{error:'disconnect_before_new_attempt'});
        if(!gateway.enabled())return json(res,403,{error:'connection_not_authorized'});
        if(lifecycle==='stopped') { gateway=createGateway(); lifecycle='idle'; }
        lifecycleRevision++;const starting=gateway;
        void starting.connect().catch(()=>starting.halt());
        return json(res,202,{status:'preparing'});
      }
      if(req.method==='POST' && req.url==='/api/stop') { void stop(); return json(res,202,{status:lifecycle}); }
      if(req.method==='POST' && req.url==='/api/mode') {
        const target=gateway,revision=lifecycleRevision;
        let mode;try{mode=await body(req,'mode')}catch{return json(res,400,{error:'invalid_link_mode'})}
        if(!['code','qr'].includes(mode))return json(res,400,{error:'invalid_link_mode'});
        if(target!==gateway || revision!==lifecycleRevision || lifecycle!=='idle' || !target.pairing.selectMode(mode))return json(res,409,{error:'link_mode_unavailable'});
        return json(res,200,{mode});
      }
      if(req.method==='POST' && req.url==='/api/code') {
        const target=gateway,revision=lifecycleRevision;
        let phone;try{phone=await body(req,'phone')}catch{return json(res,400,{error:'invalid_phone'})}
        if(!validPhone(phone))return json(res,400,{error:'invalid_phone'});
        if(target!==gateway || revision!==lifecycleRevision || lifecycle!=='idle' || !target.requestCode(phone))return json(res,409,{error:'pairing_not_ready'});
        return json(res,202,{status:'pending'});
      }
      return json(res,404,{error:'not_found'});
    } catch { return json(res,503,{error:'operation_unavailable_no_automatic_retry'}); }
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return {server,close:stop};
}
