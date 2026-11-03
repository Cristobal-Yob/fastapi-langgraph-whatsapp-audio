import asyncio
import os
from pathlib import Path
import unittest
from unittest.mock import patch, sentinel

from fastapi import FastAPI
from cloud import serve


class ServeTests(unittest.TestCase):
    def test_main_defers_api_creation_and_preserves_server_options(self):
        cases = (
            ({'APP_VARIANT': 'base', 'PORT': '8123'}, '0.0.0.0', 8123),
            ({'APP_VARIANT': 'frontend', 'PORT': '8124'}, '0.0.0.0', 8124),
            ({'APP_VARIANT': 'base', 'PORT': '8125', 'CORE_PORT': '18080'}, '127.0.0.1', 18080),
            ({'APP_VARIANT': 'whatsapp-audio', 'PORT': '8126', 'CORE_PORT': '18080'}, '127.0.0.1', 18080),
        )
        for environment, host, port in cases:
            with self.subTest(environment=environment):
                with patch.dict(os.environ, environment, clear=True), \
                        patch('cloud.api.create_app') as create_app, \
                        patch.object(serve.uvicorn, 'run') as run, \
                        patch.object(serve.logging, 'disable'):
                    serve.main()
                create_app.assert_not_called()
                run.assert_called_once_with(
                    'cloud.serve:create_served_app', factory=True, host=host, port=port,
                    access_log=False, log_config=None, server_header=False,
                    timeout_graceful_shutdown=20,
                )

    def test_factory_returns_base_api_unchanged(self):
        with patch.dict(os.environ, {'APP_VARIANT': 'base'}, clear=True), \
                patch('cloud.api.create_app', return_value=sentinel.api) as create_app:
            app = serve.create_served_app()
        self.assertIs(app, sentinel.api)
        create_app.assert_called_once_with()

    def test_factory_preserves_frontend_index_route(self):
        api = FastAPI()
        with patch.dict(os.environ, {'APP_VARIANT': 'frontend'}, clear=True), \
                patch('cloud.api.create_app', return_value=api):
            app = serve.create_served_app()
        self.assertIs(app, api)
        route = next(route for route in app.routes if route.path == '/')
        self.assertIn('GET', route.methods)
        response = asyncio.run(route.endpoint())
        self.assertEqual(Path(response.path), Path(serve.__file__).with_name('index.html'))


if __name__ == '__main__':
    unittest.main()
