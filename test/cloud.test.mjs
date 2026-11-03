import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleText, stableIds } from '../src/guard.mjs';
import { ask } from '../src/backend.mjs';

test('self-chat only and stable request identity',()=>{
  const item={key:{id:'synthetic',remoteJid:'123@s.whatsapp.net'},message:{conversation:'test'}};
  assert.equal(eligibleText(item,['999@s.whatsapp.net']),null);
  assert.equal(eligibleText(item,['123:9@s.whatsapp.net']),'test');
  assert.deepEqual(stableIds('123:9@s.whatsapp.net','one'),stableIds('123@s.whatsapp.net','one'));
});
test('direct graph sends exactly one authenticated request',async()=>{
  let calls=0;
  const fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer synthetic');
    assert.equal(options.method,'POST');calls++;
    return {status:200,json:async()=>({response:'Answer'})};
  };
  const result=await ask({message:'test',request_id:'synthetic'},{fetch,token:'synthetic'});
  assert.equal(result.response,'Answer');assert.equal(calls,1);
});

test('uncertain backend submission is never repeated',async()=>{
  let count=0;await assert.rejects(ask({message:'test'},{fetch:async()=>{count++;throw Error()},token:'synthetic'}));
  assert.equal(count,1);
});
