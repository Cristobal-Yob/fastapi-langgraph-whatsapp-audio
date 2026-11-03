"""A single authenticated request. Uncertainty never triggers an automatic resend."""
import os
from uuid import uuid4
import httpx


async def ask(message, conversation_id, *, request_id=None, response_delivery='text', audio_capable=False,
              http=None, base_url='http://127.0.0.1:18080'):
    owned = http is None
    client = http or httpx.AsyncClient(timeout=27, follow_redirects=False, trust_env=False)
    try:
        response = await client.post(base_url+'/chat',
            headers={'Authorization':'Bearer '+os.environ['AGENT_API_TOKEN']}, json={
                'message':message,'conversation_id':conversation_id,'request_id':request_id or uuid4().hex,
                'response_delivery':response_delivery,'audio_capable':audio_capable})
        response.raise_for_status()
        answer = response.json()
        if response.status_code != 200 or not isinstance(answer.get('response'), str):
            raise ValueError('invalid_agent_response_no_automatic_retry')
        return answer
    finally:
        if owned:
            await client.aclose()
