"""Offline direct-response and deadline contracts, without providers."""
import asyncio
import os
import unittest
from unittest.mock import patch

import httpx
from cloud.api import create_app

TOKEN = 'offline_only_A9xB7yC5zD3wE1vF8uG6tH4sJ2rK0qM'


class SynchronousTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_answer_without_job_endpoint(self):
        class Graph:
            async def ainvoke(self, state):
                return {'response': 'Synthetic answer', 'route': 'generica'}
        with patch.dict(os.environ, {'AGENT_API_TOKEN': TOKEN, 'APP_VARIANT': 'base'}):
            app = create_app(graph=Graph())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            result = await http.post('/chat', headers={'Authorization': 'Bearer '+TOKEN},
                                     json={'message': 'Synthetic input', 'request_id': 'direct'})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['response'], 'Synthetic answer')
            self.assertNotIn('status_url', result.json())
            schema = (await http.get('/openapi.json')).json()
            self.assertFalse(any(path.startswith('/jobs') for path in schema['paths']))

    async def test_deadline_cancels_graph_and_does_not_return_a_demo(self):
        cancelled = asyncio.Event()
        class SlowGraph:
            async def ainvoke(self, state):
                try:
                    await asyncio.sleep(1)
                finally:
                    cancelled.set()
        with patch.dict(os.environ, {'AGENT_API_TOKEN': TOKEN, 'APP_VARIANT': 'base'}):
            app = create_app(graph=SlowGraph(), request_timeout=0.01)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            result = await http.post('/chat', headers={'Authorization': 'Bearer '+TOKEN},
                                     json={'message': 'Synthetic input', 'request_id': 'timeout'})
        self.assertEqual(result.status_code, 504)
        self.assertEqual(result.json(), {'detail': 'agent_timeout_no_automatic_retry'})
        self.assertTrue(cancelled.is_set())


    async def test_body_and_graph_share_one_deadline(self):
        class Graph:
            async def ainvoke(self, state):
                await asyncio.sleep(.15)
                return {'response':'Synthetic response'}
        async def body():
            await asyncio.sleep(.15)
            yield b'{"message":"Synthetic","request_id":"body-timeout"}'
        with patch.dict(os.environ, {'AGENT_API_TOKEN':TOKEN,'APP_VARIANT':'base'}):
            app=create_app(graph=Graph(),request_timeout=.2)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as http:
            reply=await http.post('/chat',content=body(),headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
        self.assertEqual(reply.status_code,504)
