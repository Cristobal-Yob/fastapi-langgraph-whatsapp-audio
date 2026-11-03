import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { request } from 'node:http';
import { createOperatorServer } from '../src/server.mjs';

const token='offline_only_A9xB7yC5zD3wE1vF8uG6tH4sJ2rK0qM';
const origin='https://synthetic.example.invalid';
const phone='999'+'0'.repeat(11)+'1';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t) {
  const instances=[];let release;
  const createGateway=()=>{
    const value={status:'disabled',closed:false,qr:'synthetic-qr',calls:0,enabled:()=>true,
      pairing:{mode:'code',publicState:()=>({mode:value.pairing.mode,code_ready:true,code_state:'ready'}),
        codeResult:()=>({code:'TESTCODE',expires_at:Date.now()+1000}),selectMode(mode){this.mode=mode;return true}},
      connect:async()=>{value.status='connecting'},requestCode:()=>{value.calls++;return true},
      halt:()=>{value.closed=true;value.status='review_required'},
      close:options=>{value.closeOptions=options;value.halt();return new Promise(resolve=>release=resolve)}};
    instances.push(value);return value;
  };
  const {server,close}=createOperatorServer({createGateway,token,origin,encodeQr:async()=> 'data:image/png;base64,synthetic'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer '+token,Origin:origin};
  const status=await fetch(base+'/api/status',{headers});const csrf=(await status.json()).csrf;
  headers['X-CSRF-Token']=csrf;headers['Content-Type']='application/json';
  t.after(async()=>{const pending=close();await flush();release?.();await pending;server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  return {base,headers,instances,server,shutdown:close,release:()=>release?.()};
}

test('code and mode endpoints retain bearer, Origin, CSRF and strict bounded input',async t=>{
  const f=await fixture(t);
  for(const headers of [{},{...f.headers,Authorization:'Bearer wrong'},{...f.headers,Origin:'https://evil.invalid'},
      {...f.headers,'X-CSRF-Token':'wrong'}]){
    const response=await fetch(f.base+'/api/code',{method:'POST',headers,body:JSON.stringify({phone})});
    assert.ok([401,403].includes(response.status));
  }
  for(const value of ['+'+phone,'bad',null]){
    const response=await fetch(f.base+'/api/code',{method:'POST',headers:f.headers,body:JSON.stringify({phone:value})});
    assert.equal(response.status,400);
  }
  assert.equal(f.instances[0].calls,0);
  const response=await fetch(f.base+'/api/code',{method:'POST',headers:f.headers,body:JSON.stringify({phone})});
  assert.equal(response.status,202);assert.equal(f.instances[0].calls,1);
  assert.equal((await response.text()).includes(phone),false);
  assert.equal((await fetch(f.base+'/api/code')).status,401);
});

test('wrong content type, extra fields and oversized input cannot request a code',async t=>{
  const f=await fixture(t);
  for(const [headers,body] of [
    [{...f.headers,'Content-Type':'text/plain'},JSON.stringify({phone})],
    [f.headers,JSON.stringify({phone,unexpected:true})],
    [f.headers,JSON.stringify({phone:'1'.repeat(500)})],
  ]){
    const response=await fetch(f.base+'/api/code',{method:'POST',headers,body});
    assert.equal(response.status,400);
  }
  assert.equal(f.instances[0].calls,0);
});

test('QR stays hidden until manual mode selection; code is protected, non-cacheable and absent from status',async t=>{
  const f=await fixture(t);
  const status=await fetch(f.base+'/api/status',{headers:f.headers});
  assert.equal((await status.text()).includes('TESTCODE'),false);
  assert.equal((await (await fetch(f.base+'/api/qr',{headers:f.headers})).json()).image,null);
  assert.equal((await fetch(f.base+'/api/mode',{method:'POST',headers:f.headers,body:JSON.stringify({mode:'qr'})})).status,200);
  assert.ok((await (await fetch(f.base+'/api/qr',{headers:f.headers})).json()).image);
  const code=await fetch(f.base+'/api/code',{headers:f.headers});
  assert.equal(code.headers.get('cache-control'),'no-store');
});

test('explicit stop drains before a fresh start; concurrent starts and stale instance callbacks cannot take ownership',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,202);
  assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,409);
  assert.equal((await fetch(f.base+'/api/stop',{method:'POST',headers:f.headers})).status,202);
  assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,409);
  assert.equal(f.instances.length,1);
  f.release();await flush();
  assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,202);
  assert.equal(f.instances.length,2);f.instances[0].halt();
  assert.equal((await (await fetch(f.base+'/api/status',{headers:f.headers})).json()).status,'connecting');
});

test('UI defaults to owner-triggered code, never persists phone/key or generates a request during polling',async()=>{
  const html=await readFile(new URL('../src/index.html',import.meta.url),'utf8');
  assert.match(html,/id="phone"/);assert.match(html,/id="requestCode"/);assert.match(html,/id="useQr"/);
  assert.match(html,/Desconectar/);assert.match(html,/Iniciar nuevo intento/);
  assert.doesNotMatch(html,/localStorage|sessionStorage|console\.(log|info)|WA_PHONE/);
});

test('a stale code response cannot redisplay a code after the owner disconnects',async()=>{
  const html=await readFile(new URL('../src/index.html',import.meta.url),'utf8');
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,removeAttribute(){}});return nodes.get(id)};
  let stopped=false,releaseCode;
  const context={AbortController,setTimeout,clearTimeout,document:{getElementById:node},setInterval:()=>1,clearInterval:()=>{},
    fetch:async(path)=>({ok:true,json:async()=>{
      if(path==='/api/status')return {status:stopped?'stopped':'connecting',mode:'code',csrf:'synthetic',code_ready:true,can_switch:true};
      if(path==='/api/code')return new Promise(resolve=>releaseCode=resolve);
      if(path==='/api/stop'){stopped=true;return {status:'stopping'}}
      throw Error('Unexpected synthetic endpoint');
    }})};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  node('key').value=token;const polling=node('unlock').onclick();await flush();
  assert.equal(typeof releaseCode,'function');
  await node('stop').onclick();releaseCode({code:'TESTCODE'});await polling;
  assert.equal(node('codeValue').textContent,'');assert.equal(node('codeBox').hidden,true);
});


test('UI rejects expired or invalid TTL and clears a live code locally despite a stalled poll',async()=>{
  const html=await readFile(new URL('../src/index.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  async function boot(expiresAt) {
    const nodes=new Map(),timers=new Map();let now=2000,nextTimer=0,poll,releasePoll,stalled=false;
    const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,removeAttribute(){}});return nodes.get(id)};
    const context={AbortController,Date:{now:()=>now},document:{getElementById:node},
      setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id},
      clearTimeout:id=>timers.delete(id),setInterval:callback=>{poll=callback;return 1},clearInterval:()=>{},
      fetch:async path=>{
        if(stalled)return new Promise(resolve=>releasePoll=()=>resolve({ok:false}));
        return {ok:true,json:async()=>path==='/api/status'
          ? {status:'connecting',mode:'code',csrf:'synthetic',code_ready:false,can_switch:false}
          : {code:'TESTCODE',expires_at:expiresAt}};
      }};
    runInNewContext(script,context);node('key').value=token;await node('unlock').onclick();
    return {node,timers,stall:()=>{stalled=true;return poll()},release:()=>releasePoll?.(),advance:()=>{now=3000}};
  }
  for(const expiresAt of [1000,2000,null,'3000',Infinity,2000+120001]) {
    const f=await boot(expiresAt);
    assert.equal(f.node('codeValue').textContent,'');assert.equal(f.node('codeBox').hidden,true);
    assert.equal(f.timers.size,0);
  }
  const f=await boot(3000);
  assert.equal(f.node('codeValue').textContent,'TEST-CODE');assert.equal(f.timers.size,1);
  const staleExpiration=[...f.timers.values()][0];
  await f.node('unlock').onclick();staleExpiration.callback();
  assert.equal(f.node('codeValue').textContent,'TEST-CODE');
  const expiration=[...f.timers.values()][0];assert.equal(expiration.delay,1000);
  const pending=f.stall();await flush();f.advance();expiration.callback();
  assert.equal(f.node('codeValue').textContent,'');assert.equal(f.node('codeBox').hidden,true);
  f.release();await pending;
  assert.equal(f.node('codeValue').textContent,'');
});

test('slow code and mode bodies cannot mutate a new attempt after stop and reconnect',async t=>{
  for(const [path,prefix,suffix] of [['code','{"phone":',JSON.stringify(phone)+'}'],['mode','{"mode":','"qr"}']]) {
    const f=await fixture(t);
    assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,202);
    const started=new Promise(resolve=>f.server.once('request',resolve));
    const slow=request(f.base+'/api/'+path,{method:'POST',headers:f.headers});
    const response=new Promise((resolve,reject)=>{slow.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});slow.on('error',reject)});
    slow.write(prefix);await started;
    assert.equal((await fetch(f.base+'/api/stop',{method:'POST',headers:f.headers})).status,202);
    f.release();await flush();
    assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,202);
    slow.end(suffix);
    assert.equal(await response,409);
    assert.equal(f.instances.length,2);assert.equal(f.instances[1].calls,0);
    assert.equal(f.instances[1].pairing.mode,'code');
  }
});


test('only protected explicit stop requests auth reset; process shutdown preserves it',async t=>{
  const explicit=await fixture(t);
  assert.equal((await fetch(explicit.base+'/api/stop',{method:'POST'})).status,401);
  assert.equal(explicit.instances[0].closeOptions,undefined);
  assert.equal((await fetch(explicit.base+'/api/stop',{method:'POST',headers:explicit.headers})).status,202);
  await flush();assert.equal(explicit.instances[0].closeOptions.resetAuth,true);
  const again=await fetch(explicit.base+'/api/stop',{method:'POST',headers:explicit.headers});
  assert.equal(again.status,202);explicit.release();await flush();
  const shutdown=await fixture(t);const closing=shutdown.shutdown();await flush();
  assert.equal(shutdown.instances[0].closeOptions.resetAuth,false);shutdown.release();await closing;
});

test('failed auth reset stays review_required, blocks new start and permits explicit stop retry',async t=>{
  const f=await fixture(t);let attempts=0;
  f.instances[0].close=async options=>{assert.equal(options.resetAuth,true);f.instances[0].halt();if(++attempts===1)throw Error('synthetic reset failure')};
  await fetch(f.base+'/api/stop',{method:'POST',headers:f.headers});await flush();
  assert.equal((await (await fetch(f.base+'/api/status',{headers:f.headers})).json()).status,'review_required');
  assert.equal((await fetch(f.base+'/api/connect',{method:'POST',headers:f.headers})).status,409);
  await fetch(f.base+'/api/stop',{method:'POST',headers:f.headers});await flush();
  assert.equal((await (await fetch(f.base+'/api/status',{headers:f.headers})).json()).status,'stopped');
  assert.equal(attempts,2);
});
