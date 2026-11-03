// One request; never repeat an uncertain response or effect automatically.
export async function ask(payload, { fetch = globalThis.fetch, token = process.env.AGENT_API_TOKEN,
  base = 'http://127.0.0.1:18080' } = {}) {
  const reply = await fetch(base+'/chat', { method:'POST', redirect:'error',
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(27000) });
  if (reply.status !== 200) throw Error('agent_failed_no_automatic_retry');
  const result = await reply.json();
  if (typeof result.response !== 'string') throw Error('invalid_agent_response');
  return result;
}
