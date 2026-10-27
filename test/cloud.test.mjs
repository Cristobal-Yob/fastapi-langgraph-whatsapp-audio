import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../src/store.mjs';
import { eligibleText, stableIds } from '../src/guard.mjs';
import { ask } from '../src/backend.mjs';

test('encrypted session material rejects tampering',()=>{
  const key=randomBytes(32), bytes=seal(Buffer.from('synthetic-session'),key);
  assert.equal(unseal(bytes,key).toString(),'synthetic-session');
  assert.equal(bytes.includes(Buffer.from('synthetic-session')),false);
  bytes[29]^=1;assert.throws(()=>unseal(bytes,key));
});
test('self-chat only and stable request identity',()=>{
  const item={key:{id:'synthetic',remoteJid:'123@s.whatsapp.net'},message:{conversation:'test'}};
  assert.equal(eligibleText(item,['999@s.whatsapp.net']),null);
  assert.equal(eligibleText(item,['123:9@s.whatsapp.net']),'test');
  assert.deepEqual(stableIds('123:9@s.whatsapp.net','one'),stableIds('123@s.whatsapp.net','one'));
});
test('async graph submits once and polls with bearer',async()=>{
  let calls=0;
  const fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer synthetic');calls++;
    if(calls===1){assert.equal(options.method,'POST');return {status:202,json:async()=>({status_url:'/jobs/'+'a'.repeat(32)})}}
    return {ok:true,json:async()=>calls===2?{status:'running'}:{status:'done',result:{response:'Answer'}}};
  };
  const result=await ask({message:'test',request_id:'synthetic'},{fetch,token:'synthetic',sleep:async()=>{}});
  assert.equal(result.response,'Answer');assert.equal(calls,3);
});
test('uncertain backend submission is never repeated',async()=>{
  let count=0;await assert.rejects(ask({message:'test'},{fetch:async()=>{count++;throw Error()},token:'synthetic'}));
  assert.equal(count,1);
});
