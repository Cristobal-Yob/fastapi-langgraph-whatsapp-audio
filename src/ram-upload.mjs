"use strict";
import { randomBytes,createCipheriv,createHash,createHmac } from 'node:crypto';
import { getMediaKeys,proto } from '@whiskeysockets/baileys';

// Baileys' default audio preparer writes encrypted temp files. This bounded
// equivalent uses its public media-key derivation and relay API, with no filesystem.
export async function sendAudioMemory(socket,jid,output,id,{fetch=globalThis.fetch,assertOwner=async()=>{}}={}) {
  if (!Buffer.isBuffer(output.audio) || !output.audio.length || output.audio.length>2*1024*1024 ||
      !Number.isFinite(output.seconds) || output.seconds<=0 || output.seconds>120) throw Error('media_output_invalid');
  const mediaKey=randomBytes(32),{iv,cipherKey,macKey}=await getMediaKeys(mediaKey,'audio');
  const cipher=createCipheriv('aes-256-cbc',cipherKey,iv);
  const encrypted=Buffer.concat([cipher.update(output.audio),cipher.final()]);
  const mac=createHmac('sha256',macKey).update(iv).update(encrypted).digest().subarray(0,10);
  const body=Buffer.concat([encrypted,mac]);
  const fileSha256=createHash('sha256').update(output.audio).digest();
  const fileEncSha256=createHash('sha256').update(body).digest();
  await assertOwner();
  const connection=await socket.refreshMediaConn(false);
  const host=connection.hosts?.[0]?.hostname;
  if (typeof host!=='string' || !/^(?:[a-z0-9-]+\.)*whatsapp\.net$/.test(host) || typeof connection.auth!=='string')
    throw Error('media_upload_host_invalid');
  const hash=fileEncSha256.toString('base64url');
  const url=`https://${host}/mms/audio/${hash}?auth=${encodeURIComponent(connection.auth)}&token=${hash}`;
  // Exactly one upload; an unknown result is not safe to replay or switch hosts.
  const response=await fetch(url,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{'Content-Type':'application/octet-stream',Origin:'https://web.whatsapp.com'}});
  if(!response.ok) { await response.body?.cancel?.(); throw Error('media_upload_uncertain'); }
  const value=await response.json();
  const remote=new URL(value.url);
  if(remote.protocol!=='https:' || !/(^|\.)whatsapp\.net$/.test(remote.hostname) || remote.username || remote.password ||
     typeof value.direct_path!=='string' || !value.direct_path.startsWith('/')) throw Error('media_upload_invalid');
  const message=proto.Message.fromObject({audioMessage:{url:value.url,directPath:value.direct_path,mediaKey,
    fileSha256,fileEncSha256,fileLength:output.audio.length,mediaKeyTimestamp:Math.floor(Date.now()/1000),
    mimetype:'audio/ogg; codecs=opus',seconds:output.seconds,ptt:true}});
  await assertOwner();
  await socket.relayMessage(jid,message,{messageId:id});
}
