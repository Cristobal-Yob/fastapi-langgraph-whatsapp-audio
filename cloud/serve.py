import logging
import os
import uvicorn


def create_served_app():
    import json
    from pathlib import Path
    from dotenv import load_dotenv
    logging.disable(logging.CRITICAL)
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / '.env', override=False)
    if 'APP_VARIANT' not in os.environ:
        os.environ['APP_VARIANT'] = json.loads((root / 'variant.json').read_text())['variant']
    variant = os.environ['APP_VARIANT']
    from cloud.api import create_app
    app = create_app()
    if variant == 'frontend':
        from fastapi.responses import FileResponse
        from pathlib import Path
        @app.get('/')
        async def index(): return FileResponse(Path(__file__).with_name('index.html'))
    return app


def main():
    logging.disable(logging.CRITICAL)
    loopback = os.environ.get('CORE_PORT') == '18080'
    uvicorn.run('cloud.serve:create_served_app', factory=True,
                host='127.0.0.1' if loopback else '0.0.0.0',
                port=int(os.environ.get('CORE_PORT',os.environ.get('PORT','8000'))),
                access_log=False, log_config=None, server_header=False, timeout_graceful_shutdown=20)


if __name__ == '__main__': main()
