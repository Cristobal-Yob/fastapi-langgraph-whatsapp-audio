import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PhoneLink, validPhone } from '../src/pairing.mjs';
import { Gateway } from '../src/gateway.mjs';

const phone = '999' + '0'.repeat(11) + '1'; // Synthetic, not a subscriber number.
const code = 'TESTCODE';
const flush = () => new Promise(resolve=>setImmediate(resolve));

function fixture(t, request = async () => code) {
  t.mock.timers.enable({ apis:['setTimeout','Date'], now:1000 });
  let failures = 0;
  const creds = { registered:false };
  const socket = { ws:{ isOpen:true }, requestPairingCode:request };
  const link = new PhoneLink({ onUncertain:()=>failures++, requestTimeoutMs:100, codeTtlMs:1000 });
  link.begin(socket, creds);
  t.after(()=>link.stop());
  return { link, socket, creds, failures:()=>failures };
}

test('phone validation accepts international digits only, never a formatted or injected value',()=>{
  assert.equal(validPhone(phone),true);
  for(const value of ['', '+'+phone, '0'+phone, '123 4567', '123456', '1'.repeat(16), 1234567, null])
    assert.equal(validPhone(value),false);
});

test('early connecting and a closed transport cannot authorize a code; a current QR handshake can',t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return code});
  assert.equal(f.link.request(phone),false);
  f.socket.ws.isOpen=false;f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.publicState().code_ready,false);
  f.socket.ws.isOpen=true;f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.publicState().code_ready,true);
  assert.equal(calls,0);
});

test('claim precedes await, one SDK result is shown privately, never included in status',async t=>{
  let resolve, calls=0;
  const f=fixture(t,()=>{calls++;return new Promise(done=>resolve=done)});
  f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.request(phone),true);assert.equal(f.link.request(phone),false);
  await flush();assert.equal(calls,1);
  resolve(code);await flush();
  assert.equal(f.link.codeResult().code,code);
  assert.equal(JSON.stringify(f.link.publicState()).includes(code),false);
  assert.equal(JSON.stringify(f.link.publicState()).includes(phone),false);
  t.mock.timers.tick(1001);
  assert.equal(f.link.codeResult().code,null);assert.equal(f.link.publicState().code_ready,false);
  assert.equal(f.failures(),1);
});

test('registered credentials, stale QR, stale socket and stop cannot yield a usable code',async t=>{
  let resolve;const f=fixture(t,()=>new Promise(done=>resolve=done));
  f.creds.registered=true;f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.request(phone),false);
  f.creds.registered=false;f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.request(phone),true);await flush();
  f.link.stop();resolve(code);await flush();
  assert.equal(f.link.codeResult().code,null);
  f.link.begin({ws:{isOpen:true},requestPairingCode:async()=>code},f.creds);
  f.link.observeQr(f.socket,'stale-qr');assert.equal(f.link.publicState().code_ready,false);
});

test('unknown failure or timeout never regenerates and QR is only a manual alternative before a claim',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;throw Error('synthetic failure')});
  assert.equal(f.link.publicState().mode,'code');
  assert.equal(f.link.selectMode('qr'),true);assert.equal(f.link.request(phone),false);
  assert.equal(f.link.selectMode('code'),true);f.link.observeQr(f.socket,'synthetic-qr');
  assert.equal(f.link.request(phone),true);await flush();
  assert.equal(f.link.request(phone),false);assert.equal(f.link.selectMode('qr'),false);
  assert.equal(calls,1);assert.equal(f.failures(),1);
});

test('pending timeout and late SDK result are invalidated without retries',async t=>{
  let resolve,calls=0;const f=fixture(t,()=>{calls++;return new Promise(done=>resolve=done)});
  f.link.observeQr(f.socket,'synthetic-qr');f.link.request(phone);await flush();
  t.mock.timers.tick(101);resolve(code);await flush();
  assert.equal(calls,1);assert.equal(f.failures(),1);assert.equal(f.link.codeResult().code,null);
});

test('provider errors never print phone or code values',async t=>{
  const printed=[];
  for(const name of ['log','info','warn','error'])t.mock.method(console,name,(...values)=>printed.push(values));
  const f=fixture(t,async()=>{throw Error(phone+code)});
  f.link.observeQr(f.socket,'synthetic-qr');f.link.request(phone);await flush();
  assert.deepEqual(printed,[]);assert.equal(f.link.codeResult().code,null);
});

function gatewayFixture(t) {
  const previous=process.env.WA_ENABLE_CONNECTION;process.env.WA_ENABLE_CONNECTION='true';
  t.after(()=>{if(previous===undefined)delete process.env.WA_ENABLE_CONNECTION;else process.env.WA_ENABLE_CONNECTION=previous});
  const sockets=[];const creds={registered:false};
  const store={auth:{creds},saveCreds:async()=>{},close:async()=>{},alive:async()=>{}};
  const gateway=new Gateway({parse:()=>null,openStore:async()=>store,reconnectMs:1,maxReconnects:1,
    createSocket:()=>{const socket={ev:new EventEmitter(),ws:{isOpen:true},end:()=>{},requestPairingCode:async()=>code};sockets.push(socket);return socket}});
  t.after(()=>gateway.close());
  return {gateway,sockets,creds,store};
}

test('only registered-success 515 can finish linking with one bounded restart; stale close is ignored',async t=>{
  const f=gatewayFixture(t);await f.gateway.connect();
  f.sockets[0].ev.emit('connection.update',{qr:'synthetic-qr'});
  assert.equal(f.gateway.requestCode(phone),true);await flush();
  f.creds.registered=true;
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.sockets.length,2);
  f.sockets[0].ev.emit('connection.update',{connection:'close'});
  assert.equal(f.gateway.closed,false);
  f.sockets[1].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
  assert.equal(f.gateway.closed,true);assert.equal(f.sockets.length,2);
});

test('unregistered 515 after a code claim halts instead of auto-retrying',async t=>{
  const f=gatewayFixture(t);await f.gateway.connect();
  f.sockets[0].ev.emit('connection.update',{qr:'synthetic-qr'});f.gateway.requestCode(phone);await flush();
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.gateway.closed,true);assert.equal(f.sockets.length,1);
});

test('close is idempotent and drains pending work before releasing the native store',async t=>{
  const f=gatewayFixture(t);await f.gateway.connect();let release,closed=0;
  f.store.close=async()=>{closed++};
  f.gateway.drainPromise=new Promise(resolve=>release=resolve);
  const closing=f.gateway.close();assert.equal(closing,f.gateway.close());await flush();
  assert.equal(closed,0);release();await closing;assert.equal(closed,1);
});

test('disconnect while native auth is opening cannot create a late socket',async t=>{
  const previous=process.env.WA_ENABLE_CONNECTION;process.env.WA_ENABLE_CONNECTION='true';
  t.after(()=>{if(previous===undefined)delete process.env.WA_ENABLE_CONNECTION;else process.env.WA_ENABLE_CONNECTION=previous});
  let release,sockets=0,closes=0;
  const store={auth:{creds:{registered:false}},close:async()=>{closes++}};
  const gateway=new Gateway({parse:()=>null,openStore:()=>new Promise(resolve=>release=resolve),
    createSocket:()=>{sockets++;throw Error('late socket forbidden')}});
  const starting=gateway.connect();await flush();const closing=gateway.close();
  await flush();assert.equal(closes,0);release(store);await starting;await closing;
  assert.equal(sockets,0);assert.ok(closes>=1);
});

test('late pipeline replies and old credential events cannot write or send into the next owner',async t=>{
  const f=gatewayFixture(t);await f.gateway.connect();
  let release,saved=0,sent=0;const rejected=[];
  const unhandled=()=>rejected.push(true);process.on('unhandledRejection',unhandled);
  t.after(()=>process.removeListener('unhandledRejection',unhandled));
  t.mock.method(globalThis,'fetch',async()=>({status:200,json:async()=>({response:'Synthetic response'})}));
  f.store.saveCreds=async()=>{saved++};
  f.sockets[0].sendMessage=async()=>{sent++};
  f.gateway.pipeline={input:async item=>item,output:()=>new Promise(resolve=>release=resolve),close:()=>{}};
  f.gateway.queue.push({text:'Synthetic request',id:'synthetic',jid:'123@s.whatsapp.net',ids:{request_id:'synthetic'}});
  f.gateway.drainPromise=f.gateway.drain().catch(()=>f.gateway.halt());
  await flush();f.sockets[0].ev.emit('creds.update',{});await flush();
  const closing=f.gateway.close();await flush();
  f.sockets[0].ev.emit('creds.update',{});f.sockets[0].ev.emit('connection.update',{qr:'stale'});
  release({text:'Late synthetic response'});await closing;
  const next=new Gateway({parse:()=>null});t.after(()=>next.close());
  f.sockets[0].ev.emit('creds.update',{});f.sockets[0].ev.emit('connection.update',{connection:'close'});
  await flush();assert.equal(saved,1);assert.equal(sent,0);assert.equal(next.closed,false);
  assert.equal(f.gateway.pairing.codeResult().code,null);assert.deepEqual(rejected,[]);
});


test('unregistered 515 before any claim cannot restart, and registered 515 restarts only once',async t=>{
  const unregistered=gatewayFixture(t);await unregistered.gateway.connect();
  const close=socket=>socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});
  close(unregistered.sockets[0]);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(unregistered.gateway.closed,true);assert.equal(unregistered.sockets.length,1);
  const registered=gatewayFixture(t);registered.gateway.maxReconnects=3;registered.creds.registered=true;
  await registered.gateway.connect();close(registered.sockets[0]);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(registered.sockets.length,2);
  close(registered.sockets[0]);assert.equal(registered.gateway.closed,false);
  close(registered.sockets[1]);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(registered.gateway.closed,true);assert.equal(registered.sockets.length,2);
});
