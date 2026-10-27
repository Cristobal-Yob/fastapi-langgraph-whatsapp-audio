export async function ask(payload, { fetch = globalThis.fetch, token = process.env.AGENT_API_TOKEN,
  base = 'http://127.0.0.1:18080', sleep = ms => new Promise(resolve => setTimeout(resolve,ms)) } = {}) {
  const headers = { 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' };
  const first = await fetch(base+'/chat',{ method:'POST',headers,body:JSON.stringify(payload),
    redirect:'error',signal:AbortSignal.timeout(8000) });
  if (first.status !== 202) throw Error('agent_submission_failed_no_retry');
  const { status_url:path } = await first.json();
  if (!/^\/jobs\/[a-f0-9]{32}$/.test(path)) throw Error('invalid_job');
  const expires = Date.now()+155000;
  while (Date.now() < expires) {
    const reply = await fetch(base+path,{ headers,redirect:'error',signal:AbortSignal.timeout(8000) });
    if (!reply.ok) throw Error('agent_poll_failed_no_resubmit');
    const value = await reply.json();
    if (value.status === 'done') return value.result;
    if (value.status === 'failed') throw Error('agent_failed_no_retry');
    await sleep(400);
  }
  throw Error('agent_deadline_no_retry');
}
