import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Gateway } from '../src/gateway.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'synthetic-wa-reset-'));
  const directory=join(root,'whatsapp-auth');
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.match(root,/synthetic-wa-reset-/);await rm(root,{recursive:true,force:true})});
  return {root,directory,open:()=>Store.open({directory,authRoot:directory})};
}

test('explicit reset drains accepted auth, holds ownership, is idempotent and starts unregistered',async t=>{
  const f=await fixture(t),store=await f.open();let release;
  await writeFile(join(f.root,'gateway.lock'),'synthetic lock');
  store.auth.creds.registered=true;
  const pending=store.authOperation(async()=>{await new Promise(resolve=>release=resolve);await writeFile(join(f.directory,'pending.json'),'{}')});
  await flush();
  const closing=store.close({resetAuth:true});assert.equal(closing,store.close({resetAuth:true}));
  await assert.rejects(f.open());await assert.rejects(store.saveCreds());
  assert.equal((await lstat(f.directory)).isDirectory(),true);
  release();await pending;await closing;
  await assert.rejects(lstat(f.directory),{code:'ENOENT'});
  assert.equal(await readFile(join(f.root,'gateway.lock'),'utf8'),'synthetic lock');
  const next=await f.open();assert.equal(next.auth.creds.registered,false);
  await assert.rejects(store.saveCreds());await store.close({resetAuth:true});
  assert.equal((await lstat(f.directory)).isDirectory(),true,'an old reset cannot delete the new owner');
  await next.close();
});

test('ordinary store shutdown preserves registered credentials and stale reset cannot touch a new owner',async t=>{
  const f=await fixture(t),store=await f.open();store.auth.creds.registered=true;await store.saveCreds();await store.close();
  const next=await f.open();assert.equal(next.auth.creds.registered,true);
  await assert.rejects(store.close({resetAuth:true}));assert.equal((await lstat(f.directory)).isDirectory(),true);await next.close();
});

test('reset rejects an outside target and filesystem roots without deleting siblings',async t=>{
  const f=await fixture(t),outside=join(f.root,'outside');
  const store=await Store.open({directory:outside,authRoot:f.directory});await store.saveCreds();
  await assert.rejects(store.close({resetAuth:true}));
  assert.equal((await lstat(join(outside,'creds.json'))).isFile(),true);
  const unsafe=new Store(parse(f.root).root,1);unsafe.authRoot=unsafe.directory;
  await assert.rejects(unsafe.close({resetAuth:true}));
});

test('reset rejects symlink children and can retry after deletion failure without releasing ownership',async t=>{
  const f=await fixture(t),store=await f.open(),outside=join(f.root,'outside');await mkdir(outside);
  await writeFile(join(outside,'keep.json'),'synthetic outside');
  await symlink(outside,join(f.directory,'linked.json'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(store.close({resetAuth:true}));await assert.rejects(f.open());
  assert.equal(await readFile(join(outside,'keep.json'),'utf8'),'synthetic outside');
  await unlink(join(f.directory,'linked.json'));await store.close({resetAuth:true});
  await assert.rejects(lstat(f.directory),{code:'ENOENT'});
});

test('reset rejects symlink ancestors even when the target itself is a directory',async t=>{
  const f=await fixture(t),real=join(f.root,'real'),link=join(f.root,'alias');await mkdir(real);
  await symlink(real,link,process.platform==='win32'?'junction':'dir');
  const directory=join(link,'whatsapp-auth'),store=await Store.open({directory,authRoot:directory});await store.saveCreds();
  await assert.rejects(store.close({resetAuth:true}));
  assert.equal((await lstat(join(real,'whatsapp-auth','creds.json'))).isFile(),true);
  // Preserve the failed owner until this synthetic fixture is removed.
});

async function gatewayFixture(t) {
  const f=await fixture(t),sockets=[];let current;
  const previous=process.env.WA_ENABLE_CONNECTION;process.env.WA_ENABLE_CONNECTION='true';
  t.after(()=>{if(previous===undefined)delete process.env.WA_ENABLE_CONNECTION;else process.env.WA_ENABLE_CONNECTION=previous});
  const gateway=new Gateway({parse:()=>null,openStore:async()=>current=await f.open(),reconnectMs:1,
    createSocket:()=>{const socket={ev:new EventEmitter(),ws:{isOpen:true},end:()=>{}};sockets.push(socket);return socket}});
  await gateway.connect();return {...f,gateway,sockets,store:()=>current};
}

test('explicit gateway disconnect waits for socket, pipeline and auth before reset',async t=>{
  const f=await gatewayFixture(t);let socketDone,pipelineDone,authDone;
  f.sockets[0].end=()=>new Promise(resolve=>socketDone=resolve);
  f.gateway.pipeline={close:()=>new Promise(resolve=>pipelineDone=resolve)};
  const accepted=f.store().authOperation(()=>new Promise(resolve=>authDone=resolve));await flush();
  const closing=f.gateway.close({resetAuth:true});await flush();
  assert.equal((await lstat(f.directory)).isDirectory(),true);
  socketDone();pipelineDone();await flush();assert.equal((await lstat(f.directory)).isDirectory(),true);
  authDone();await accepted;await closing;await assert.rejects(lstat(f.directory),{code:'ENOENT'});
  f.sockets[0].ev.emit('creds.update',{});await flush();await assert.rejects(lstat(f.directory),{code:'ENOENT'});
});

test('transient gateway halt and ordinary process close preserve auth',async t=>{
  const f=await gatewayFixture(t);f.store().auth.creds.registered=true;await f.store().saveCreds();
  f.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});
  await f.gateway.close();assert.equal((await lstat(join(f.directory,'creds.json'))).isFile(),true);
});

test('explicit stop before connect resets saved auth without creating a socket',async t=>{
  const f=await fixture(t),store=await f.open();store.auth.creds.registered=true;await store.saveCreds();await store.close();
  const gateway=new Gateway({parse:()=>null,openStore:f.open,createSocket:()=>{throw Error('socket forbidden')}});
  await gateway.close({resetAuth:true});await assert.rejects(lstat(f.directory),{code:'ENOENT'});
});
