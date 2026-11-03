"""One authenticated request, one bounded LangGraph response. No background jobs."""
import asyncio
import hashlib
import ipaddress
import json
import os
import time
from collections import OrderedDict
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPBearer
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from langsmith import tracing_context
from pydantic import BaseModel, ConfigDict, StringConstraints

from app.memory import ConversationStore
from cloud.security import authenticate, validate_token

Identifier = Annotated[str, StringConstraints(pattern=r'^[A-Za-z0-9_-]{1,64}$')]


class ChatInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    request_id: Identifier
    conversation_id: Identifier | None = None
    response_delivery: Literal['text', 'audio'] = 'text'
    audio_capable: bool = False


def create_app(*, graph=None, request_timeout=25):
    if not 0 < request_timeout <= 25:
        raise ValueError("request_timeout must be greater than zero and at most 25 seconds.")
    token = validate_token(os.environ.get('AGENT_API_TOKEN', ''))
    memory = ConversationStore()
    requests, active = OrderedDict(), set()
    variant = os.environ.get('APP_VARIANT', 'base')
    expected_origin = os.environ.get('PUBLIC_ORIGIN','')
    swagger = variant == 'base'
    bearer = HTTPBearer(scheme_name='OperatorToken',auto_error=False,
                       description='Generated bearer secret for the single operator.')
    app = FastAPI(title='Autonomous LangGraph teaching API', docs_url='/docs' if swagger else None,
                  redoc_url=None, openapi_url='/openapi.json' if swagger else None)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({'detail':'invalid_request'}, status_code=422)

    @app.middleware('http')
    async def boundary(request, next_call):
        request.state.deadline = time.monotonic() + request_timeout
        public = (request.url.path == '/health'
                  or (variant == 'frontend' and request.method == 'GET' and request.url.path == '/')
                  or (swagger and request.method == 'GET' and request.url.path in {'/docs','/openapi.json'}))
        if not public:
            try: authenticate(request, token)
            except HTTPException as error:
                return JSONResponse({'detail':error.detail}, status_code=error.status_code)
            if expected_origin.startswith('http://') and (not request.client or not ipaddress.ip_address(request.client.host).is_loopback):
                return JSONResponse({'detail':'trusted_origin_required'}, status_code=403)
            if request.headers.get('origin') and request.headers['origin'] != expected_origin:
                return JSONResponse({'detail':'trusted_origin_required'}, status_code=403)
            try: size = int(request.headers.get('content-length', '0'))
            except ValueError: size = 16385
            if size > 16384:
                return JSONResponse({'detail':'request_too_large'}, status_code=413)
            if request.method in {'POST','PUT','PATCH'}:
                # Bound chunked bodies as well, before Pydantic can retain their contents.
                chunks, total = [], 0
                try:
                    async with asyncio.timeout(5):
                        async for chunk in request.stream():
                            total += len(chunk)
                            if total > 16384: return JSONResponse({'detail':'request_too_large'}, status_code=413)
                            chunks.append(chunk)
                except TimeoutError: return JSONResponse({'detail':'request_timeout'}, status_code=408)
                request._body = b''.join(chunks)
        response = await next_call(request)
        response.headers.update({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
        return response

    @app.get('/health')
    async def health(): return {'status':'ok'}

    @app.post('/chat', dependencies=[Depends(bearer)])
    async def chat(payload: ChatInput, request: Request):
        nonlocal graph
        if payload.response_delivery == 'audio' and not payload.audio_capable:
            raise HTTPException(422, 'audio_capability_required')
        digest = hashlib.sha256(json.dumps(payload.model_dump(), sort_keys=True).encode()).hexdigest()
        if payload.request_id in requests:
            old_digest, answer = requests[payload.request_id]
            if old_digest != digest:
                raise HTTPException(409, 'request_payload_conflict')
            requests.move_to_end(payload.request_id)
            return answer
        if payload.request_id in active:
            raise HTTPException(409, 'request_in_progress_no_automatic_retry')
        if len(active) >= 8:
            raise HTTPException(503, 'capacity_reached')
        conversation_id = payload.conversation_id or 'req-'+hashlib.sha256(payload.request_id.encode()).hexdigest()[:48]
        active.add(payload.request_id)
        try:
            async with asyncio.timeout(max(0.001, request.state.deadline-time.monotonic())):
                async with memory.use(conversation_id) as conversation:
                    if graph is None:
                        from app.provider import create_graph
                        graph = create_graph()
                    with tracing_context(enabled=False):
                        result = await graph.ainvoke({'message':payload.message,
                            'history':list(conversation.turns),'conversation_id':conversation_id,
                            'request_id':payload.request_id,
                            'response_delivery':payload.response_delivery,'audio_capable':payload.audio_capable})
                    keys = ('route','reason','response','provider','backend','model_used','fallback_used',
                            'response_model_used','response_fallback_used')
                    answer = {key:result[key] for key in keys if key in result}
                    answer['conversation_id'] = conversation_id
                    conversation.turns.append({'user':payload.message,'assistant':result['response']})
                    requests[payload.request_id] = (digest, answer)
                    if len(requests) > 128:
                        requests.popitem(last=False)
                    return answer
        except TimeoutError:
            raise HTTPException(504, 'agent_timeout_no_automatic_retry') from None
        except asyncio.CancelledError:
            raise
        except Exception:
            raise HTTPException(503, 'agent_unavailable_no_automatic_retry') from None
        finally:
            active.discard(payload.request_id)

    @app.delete('/conversations/{conversation_id}', status_code=204,dependencies=[Depends(bearer)])
    async def reset(conversation_id: Identifier):
        try: removed = memory.reset(conversation_id)
        except Exception: raise HTTPException(409, 'conversation_busy') from None
        if not removed: raise HTTPException(404, 'conversation_not_found')
        for key, (_, answer) in tuple(requests.items()):
            if answer['conversation_id'] == conversation_id: requests.pop(key)
        return Response(status_code=204)

    return app


def application(): return create_app()
