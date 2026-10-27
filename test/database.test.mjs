import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/store.mjs';

test('PostgreSQL owns encrypted auth, singleton and uncertain claims across restart',
  {skip:process.env.RUN_DATABASE_TESTS!=='true'},async()=>{
  const namespace='synthetic-'+randomBytes(8).toString('hex');
  const env={DATABASE_URL:process.env.DATABASE_URL,WA_ACCOUNT_NAMESPACE:namespace,
    WA_STATE_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
  const store=await Store.open(env);
  try {
    await store.write('creds',Buffer.from('synthetic-credential'));
    assert.equal((await store.read('creds')).toString(),'synthetic-credential');
    const raw=await store.client.query('SELECT encrypted FROM wa_records WHERE namespace=$1',[store.namespace]);
    assert.equal(raw.rows[0].encrypted.includes(Buffer.from('synthetic-credential')),false);
    await assert.rejects(Store.open(env));
    assert.equal(await store.claim('synthetic-input'),true);
    assert.equal(await store.claim('synthetic-input'),false);
  } finally {await store.close()}
  try {await assert.rejects(Store.open(env))}
  finally {
    const db=new pg.Client({connectionString:env.DATABASE_URL});await db.connect();
    await db.query('DELETE FROM wa_records WHERE namespace=$1',['whatsapp:'+namespace]);
    await db.query('DELETE FROM wa_claims WHERE namespace=$1',['whatsapp:'+namespace]);await db.end();
  }
});
