import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Store } from '../src/store.mjs';
import { Gateway } from '../src/gateway.mjs';

test('native auth stores credentials and Signal keys, claims remain volatile and bounded',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-wa-auth-'));
 let store;
 try {
  store=await Store.open({directory,capacity:2});
  await assert.rejects(Store.open({directory}));
  await store.saveCreds();
  await store.auth.keys.set({'session':{'synthetic':{key:Buffer.from('synthetic-key')}}});
  assert.equal((await store.auth.keys.get('session',['synthetic'])).synthetic.key.toString(),'synthetic-key');
  assert.equal(await store.claim('in:one'),true);assert.equal(await store.claim('in:one'),false);
  assert.equal(await store.claim('out:one'),true);await assert.rejects(store.claim('in:overflow'));
  assert.deepEqual((await readdir(directory)).sort(),['creds.json','session-synthetic.json']);
  await store.close();
  store=await Store.open({directory});assert.equal(await store.known('in:one'),false);
  assert.equal(store.auth.creds.registrationId!==undefined,true);
 } finally {if(store)await store.close();await rm(directory,{recursive:true,force:true});}
});

test('gateway rejects messages not from the owner before parsing',async()=>{
 let parsed=0;const gateway=new Gateway({parse:()=>{parsed++;return null}});
 gateway.ready=Date.now()/1000;gateway.busy=true;gateway.socket={user:{id:'123@s.whatsapp.net'}};
 gateway.store={known:async()=>false,claim:async()=>true};
 await gateway.accept({type:'notify',messages:[{key:{id:'one',remoteJid:'123@s.whatsapp.net',fromMe:false},messageTimestamp:Date.now()/1000}]});
 assert.equal(parsed,0);
});


test('basic auth opens with SQL imports and network connections forbidden',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const url=new URL('../src/store.mjs',import.meta.url).href;
 const code=[
  "import {registerHooks} from 'node:module';import net from 'node:net';import {mkdtemp,rm} from 'node:fs/promises';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';",
  "registerHooks({resolve(name,context,next){if(name==='pg'||name.startsWith('pg/'))throw Error('SQL forbidden');return next(name,context)}});",
  "net.Socket.prototype.connect=()=>{throw Error('network forbidden')};",
  "const {Store}=await import("+JSON.stringify(url)+");const folder=await mkdtemp(join(tmpdir(),'synthetic-wa-blocked-'));let store;",
  "try{store=await Store.open({directory:folder});await store.saveCreds()}finally{if(store)await store.close();if(dirname(folder)!==resolve(tmpdir())||!folder.includes('synthetic-wa-blocked-'))throw Error('unsafe cleanup');await rm(folder,{recursive:true,force:true})}"
 ].join('\n');
 await promisify(execFile)(process.execPath,['--input-type=module','--eval',code],{timeout:15000});
});

async function removeSynthetic(directory) {
 assert.equal(dirname(directory),resolve(tmpdir()));
 assert.equal(directory.includes('synthetic-wa-'),true);
 await rm(directory,{recursive:true,force:true});
}

test('stale repeated close cannot release the current native auth owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-wa-owner-'));
 let first,second,third;
 try {
  first=await Store.open({directory});await first.close();
  second=await Store.open({directory});await first.close();
  let refused=false;
  try {third=await Store.open({directory})}catch{refused=true}
  assert.equal(refused,true,'an old close must not release a new owner');
  assert.equal(second.active,true);
  await assert.rejects(first.auth.keys.get('session',['synthetic']));
 } finally {
  if(third)await third.close();if(second)await second.close();if(first)await first.close();
  await removeSynthetic(directory);
 }
});

test('forty mixed native same-key operations and permission checks are serialized',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-wa-mixed-'));
 let store;
 try {
  store=await Store.open({directory});
  const operations=Array.from({length:40},(_,index)=>store.auth.keys.set({session:{synthetic:
   index%4===0 ? null : {key:Buffer.from('value-'+index)}}}));
  const results=await Promise.allSettled(operations);
  assert.equal(results.filter(value=>value.status==='rejected').length,0,'all accepted native operations must settle successfully');
  assert.equal((await store.auth.keys.get('session',['synthetic'])).synthetic.key.toString(),'value-39');
  assert.equal(store.active,true);
 } finally {if(store)await store.close();await removeSynthetic(directory)}
});

test('close drains accepted native work, rejects new work and is idempotent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-wa-drain-'));
 let store,next,early;
 try {
  store=await Store.open({directory,capacity:1});
  assert.equal(await store.claim('one'),true);await assert.rejects(store.claim('overflow'));
  const operations=[store.auth.keys.set({session:{synthetic:{key:Buffer.from('drained')}}}),
                    store.saveCreds(),store.auth.keys.get('session',['synthetic'])];
  const settled=Promise.allSettled(operations);
  const closing=store.close(),again=store.close();
  let earlyRefused=false;
  try {early=await Store.open({directory})}catch{earlyRefused=true}
  const checks=await Promise.allSettled([store.auth.keys.get('session',['synthetic']),
   store.auth.keys.set({session:{synthetic:null}}),store.saveCreds(),store.alive(),store.claim('late')]);
  const results=await settled;await closing;await again;
  assert.equal(earlyRefused,true,'accepted auth work keeps ownership until drained');
  assert.equal(results.filter(value=>value.status==='rejected').length,0);
  assert.equal(checks.every(value=>value.status==='rejected'),true);
  assert.equal(closing,again,'repeated close must await the same tail');
  assert.equal(store.active,false);
  next=await Store.open({directory});
  assert.equal((await next.auth.keys.get('session',['synthetic'])).synthetic.key.toString(),'drained');
  await assert.rejects(store.auth.keys.get('session',['synthetic']));
 } finally {
  if(early)await early.close();if(next)await next.close();if(store)await store.close();await removeSynthetic(directory);
 }
});
