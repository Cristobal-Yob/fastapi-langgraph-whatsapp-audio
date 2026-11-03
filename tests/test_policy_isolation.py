"""Offline contracts for a chat-only graph and Spanish system instructions."""
import dataclasses
import inspect
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.graph import AgentState, GeneratedReply, RouteDecision, RoutingResult, build_graph
from app.memory import Conversation
from app.prompts import RESPONSE_PROMPT, ROUTER_PROMPT
from cloud.api import create_app

TOKEN = 'offline_only_A9xB7yC5zD3wE1vF8uG6tH4sJ2rK0qM'


class PolicyIsolationTests(unittest.IsolatedAsyncioTestCase):
    def test_no_email_policy_files_state_schema_or_api_dependency(self):
        root = Path(__file__).resolve().parents[1]
        for name in ('app/email_delivery.py', 'cloud/mail_config.py', 'cloud/mail.py', 'cloud/gmail.py'):
            self.assertFalse((root / name).exists(), name)
        self.assertEqual(set(RouteDecision.model_fields), {'route', 'reason'})
        self.assertFalse(any('email' in key for key in AgentState.__annotations__))
        self.assertFalse(any('email' in field.name for field in dataclasses.fields(Conversation)))
        self.assertNotIn('mail', inspect.signature(create_app).parameters)

    async def test_only_business_route_then_response_and_spanish_prompts(self):
        self.assertTrue(ROUTER_PROMPT.startswith('Clasifica'))
        self.assertTrue(RESPONSE_PROMPT.startswith('Redacta'))
        for word in ('email', 'correo', 'Gmail'):
            self.assertNotIn(word, ROUTER_PROMPT + RESPONSE_PROMPT)
        router, responder = AsyncMock(), AsyncMock()
        router.ainvoke.return_value = RoutingResult(route='generica', reason='Prueba',
            provider='google', backend='developer', model_used='synthetic', fallback_used=False)
        responder.ainvoke.return_value = GeneratedReply(response='Respuesta sintética',
            response_model_used='synthetic', response_fallback_used=False)
        graph = build_graph(router, responder)
        self.assertEqual(set(graph.get_graph().nodes),
            {'__start__', 'route', 'preventa', 'postventa', 'generica', '__end__'})
        result = await graph.ainvoke({'message': 'Consulta', 'history': [],
            'response_delivery': 'audio', 'audio_capable': True})
        self.assertEqual(result['response'], 'Respuesta sintética')
        system = responder.ainvoke.await_args.args[0][0].content
        self.assertIn('Entrega actual de la respuesta: audio', system)
        self.assertIn('Capacidad de audio: True', system)
        self.assertNotIn('Current response delivery', system)

    async def test_environment_cannot_enable_mail_and_api_does_not_pass_effect_state(self):
        states = []
        class Graph:
            async def ainvoke(self, state):
                states.append(state)
                return {'response': 'Respuesta sintética', 'route': 'generica',
                        'email': {'status': 'unexpected'}}
        with patch.dict(os.environ, {'AGENT_API_TOKEN': TOKEN, 'APP_VARIANT': 'gmail',
                                    'EMAIL_ENABLE_REAL_SEND': 'true'}, clear=True):
            app = create_app(graph=Graph())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/chat', headers={'Authorization': 'Bearer '+TOKEN},
                json={'message': 'Envía un correo a persona@example.invalid', 'request_id': 'isolated'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('email', response.json())
        self.assertFalse(any('email' in key for key in states[0]))


if __name__ == '__main__':
    unittest.main()
