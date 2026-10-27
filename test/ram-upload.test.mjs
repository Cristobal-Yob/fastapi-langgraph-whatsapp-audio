import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv,createHash,createHmac } from 'node:crypto';
import { getMediaKeys } from '@whiskeysockets/baileys';
import { sendAudioMemory } from '../src/ram-upload.mjs';

test('RAM-only upload uses SDK media derivation and relays bounded audio once',async()=>{
  let uploaded,relayed,posts=0;
  const socket={refreshMediaConn:async()=>({auth:'synthetic',hosts:[{hostname:'mmg.whatsapp.net'}]}),
    relayMessage:async(jid,message,options)=>{relayed={jid,message,options}}};
  const plain=Buffer.from('synthetic audio bytes');
  const fetch=async(url,options)=>{posts++;assert.ok(url.startsWith('https://mmg.whatsapp.net/mms/audio/'));
    uploaded=options.body;return {ok:true,body:{cancel:async()=>{}},json:async()=>({url:'https://mmg.whatsapp.net/synthetic',direct_path:'/synthetic'})}};
  await sendAudioMemory(socket,'123@s.whatsapp.net',{audio:plain,seconds:1,ptt:true},'reserved-id',{fetch});
  const audio=relayed.message.audioMessage;
  const {iv,cipherKey,macKey}=await getMediaKeys(audio.mediaKey,'audio');
  const ciphertext=uploaded.subarray(0,-10),mac=uploaded.subarray(-10);
  assert.deepEqual(mac,createHmac('sha256',macKey).update(iv).update(ciphertext).digest().subarray(0,10));
  const decipher=createDecipheriv('aes-256-cbc',cipherKey,iv);
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext),decipher.final()]),plain);
  assert.deepEqual(Buffer.from(audio.fileEncSha256),createHash('sha256').update(uploaded).digest());
  assert.equal(relayed.options.messageId,'reserved-id');assert.equal(posts,1);
});
test('uncertain upload never retries or relays',async()=>{
  let posts=0,relay=0;
  const socket={refreshMediaConn:async()=>({auth:'synthetic',hosts:[{hostname:'mmg.whatsapp.net'}]}),relayMessage:async()=>{relay++}};
  await assert.rejects(sendAudioMemory(socket,'123@s.whatsapp.net',{audio:Buffer.from('synthetic'),seconds:1},'id',{
    fetch:async()=>{posts++;throw Error('synthetic_network_loss')}}));
  assert.equal(posts,1);assert.equal(relay,0);
});
