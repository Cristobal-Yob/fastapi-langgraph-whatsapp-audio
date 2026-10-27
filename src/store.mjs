import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

export function seal(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function unseal(value, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0,12));
  decipher.setAuthTag(value.subarray(12,28));
  return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]);
}

export class Store {
  constructor(client, namespace, key) { Object.assign(this,{ client,namespace,key }); this.active = true; }
  static async open(env = process.env) {
    if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(env.WA_ACCOUNT_NAMESPACE ?? ''))
      throw Error('durable_database_and_account_namespace_required');
    const key = Buffer.from(env.WA_STATE_ENCRYPTION_KEY ?? '', 'base64');
    if (key.length !== 32) throw Error('state_encryption_key_required');
    const client = new pg.Client({ connectionString:env.DATABASE_URL, connectionTimeoutMillis:5000, query_timeout:5000 });
    const store = new Store(client, 'whatsapp:'+env.WA_ACCOUNT_NAMESPACE, key);
    client.on('error', () => { store.active = false; store.onLost?.(); });
    try {
      await client.connect();
      await client.query('CREATE TABLE IF NOT EXISTS wa_records(namespace text,key text,encrypted bytea NOT NULL,PRIMARY KEY(namespace,key))');
      await client.query('CREATE TABLE IF NOT EXISTS wa_claims(namespace text,key text,digest text NOT NULL,status text NOT NULL,PRIMARY KEY(namespace,key))');
      const lock = createHash('sha256').update(store.namespace).digest().readBigInt64BE().toString();
      const value = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[lock]);
      if (!value.rows[0].locked) throw Error('single_owner_already_active');
      // A crash after a claim is not permission to replay. Require manual inspection before reconnecting.
      const uncertain = await client.query("SELECT key FROM wa_claims WHERE namespace=$1 AND status='uncertain' LIMIT 1",[store.namespace]);
      if (uncertain.rows.length) throw Error('uncertain_claim_requires_operator_review');
      return store;
    } catch { await client.end().catch(()=>{}); throw Error('durable_state_unavailable'); }
  }
  async alive() { if (!this.active) throw Error('ownership_lost'); await this.client.query('SELECT 1'); }
  async read(key) {
    await this.alive();
    const result = await this.client.query('SELECT encrypted FROM wa_records WHERE namespace=$1 AND key=$2',[this.namespace,key]);
    return result.rows.length ? unseal(result.rows[0].encrypted,this.key) : null;
  }
  async write(key, value) {
    await this.alive();
    if (value === null) return this.client.query('DELETE FROM wa_records WHERE namespace=$1 AND key=$2',[this.namespace,key]);
    return this.client.query('INSERT INTO wa_records VALUES($1,$2,$3) ON CONFLICT(namespace,key) DO UPDATE SET encrypted=EXCLUDED.encrypted',
      [this.namespace,key,seal(value,this.key)]);
  }
  async claim(key, digest = key) {
    await this.alive();
    const result = await this.client.query("INSERT INTO wa_claims VALUES($1,$2,$3,'uncertain') ON CONFLICT DO NOTHING RETURNING key",[this.namespace,key,digest]);
    return result.rows.length === 1;
  }
  async known(key) { const value = await this.client.query('SELECT key FROM wa_claims WHERE namespace=$1 AND key=$2',[this.namespace,key]); return value.rows.length > 0; }
  async done(key) { await this.client.query("UPDATE wa_claims SET status='done' WHERE namespace=$1 AND key=$2",[this.namespace,key]); }
  async close() { this.active = false; await this.client.end(); }
}
