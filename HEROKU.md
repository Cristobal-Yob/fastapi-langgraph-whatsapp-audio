# Publicar WhatsApp de texto y audio desde cero

**Objetivo: Heroku Cedar con buildpacks clásicos y stack heroku-24. No se afirma compatibilidad Fir/CNB.** Las órdenes de esta guía son acciones futuras del propietario: no se ha creado ninguna app, add-on ni despliegue.

## 1. Preparar herramientas y cuentas

Necesita Python 3.12, Git, GitHub CLI, Heroku CLI y cuentas propias. Este proyecto es autónomo y debe publicarse en un repositorio GitHub **privado nuevo**, sin importar historial, entornos, `.env`, OAuth ni auth de ejemplos anteriores. Consulte [README](README.md) para entorno y pruebas.

## 2. Configurar el agente

Copie `.env.example` a `.env` solo localmente. Genere `AGENT_API_TOKEN` con `secrets.token_urlsafe(32)`. Elija Google Developer API con `GOOGLE_GENAI_USE_VERTEXAI=false` y una clave propia, o Vertex con proyecto/location y ADC configurado expresamente fuera de Git. No use variables/cuentas de otra aplicación. `MODELO` y `FALLBACK_MODEL` deben ser distintos. Las instrucciones y el fallback son los del agente fuente, sin un responder de demostración.

`PUBLIC_ORIGIN` debe ser la URL HTTPS exacta que obtenga para su app, sin slash final. La excepción de ejecución local es la API base en localhost; los controles de navegador seguros requieren HTTPS local con un proxy de confianza o un túnel **solo si usted lo autoriza**. No desactive la validación de Origin para probarlos.

## Preparación específica

Instale Node 24 y ejecute `npm ci --ignore-scripts`; cada repositorio tiene su propio package-lock y todas sus dependencias. Baileys es un conector comunitario **no oficial**; evalúe los términos y el riesgo de bloqueo de la cuenta antes de vincularla.

Configure PostgreSQL y `WA_ACCOUNT_NAMESPACE`, un identificador opaco estable para **esa cuenta**, igual si cambia entre texto y audio. No ejecute ambos a la vez ni invente un namespace nuevo para eludir el bloqueo. `WA_STATE_ENCRYPTION_KEY` se genera con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`; guárdela estable fuera de Git. Credenciales y claves Baileys se cifran AES-256-GCM en PostgreSQL. Una conexión DB mantiene el advisory lock; perderla detiene el transporte. No hay directorio de auth, SQLite, ACL Windows ni dependencia LOCALAPPDATA.

Mantenga `WA_ENABLE_CONNECTION=false` hasta autorizar la vinculación. Luego cambie a true, abra la página HTTPS, introduzca el bearer y pulse Iniciar vinculación. Solo el operador autenticado puede ver el QR en memoria. Conectarse y detener requieren Origin exacto y token CSRF; no hay códigos/QR en stdout ni un endpoint público de pairing. Escanee desde Dispositivos vinculados. Se aceptan únicamente eventos notify nuevos de su propio chat, con identidad verificada antes de leer contenido. No se reproduce historial.

Cada mensaje se reserva en PostgreSQL antes de consultar el core; el ID de salida se reserva antes de enviar. Una caída, desconexión o claim incierto detiene el transporte y exige revisión, sin reconexión/reenvío automáticos. Una revisión manual debe inspeccionar PostgreSQL y la cuenta antes de decidir un nuevo envío. No borre sesiones ni registros para forzar arranque. `/health` no afirma que WhatsApp esté conectado.

Configure `ELEVENLABS_API_KEY` y `ELEVENLABS_VOICE_ID` propios. El flujo real es audio WhatsApp -> descarga limitada en RAM -> ffprobe/ffmpeg por pipes -> STT `scribe_v2` -> **el mismo LangGraph** -> texto, o TTS `eleven_v4_turbo` por WebSocket y Ogg/Opus solo si el mensaje actual pide expresamente voz. Recibir audio no autoriza voz de salida; el siguiente turno vuelve a texto sin esa petición. La gramática conserva exclusiones de citas, negaciones e hipótesis. La subida de salida usa cifrado, hashes y relay del SDK en RAM; no llama al preparador predeterminado de Baileys que crea temporales cifrados. No se guarda audio ni transcripción en disco; proveedores pueden tener su propia retención.

`Aptfile` pide ffmpeg y el buildpack apt debe ir primero. Compruebe después `ffmpeg -encoders` y `ffprobe -version`: debe existir `libopus`. Localmente instale esos binarios de manera explícita. Los códecs están limitados a protocolos pipe y audio acotado; no se sustituye la validación por una bandera. Un fallo de síntesis devuelve texto con aviso, no afirma entrega de audio.

## 3. Verificar antes de publicar

```sh
python -B -m unittest discover -s tests -v
```

En WhatsApp añada `npm test`. Los tests de PostgreSQL se habilitan únicamente contra una base **sintética aislada** con `RUN_DATABASE_TESTS=true`, `DATABASE_URL` y `STATE_ENCRYPTION_KEY` de prueba. Los tests no deben tocar la cuenta/base real. El resultado omitido no equivale a una prueba de durabilidad.

## 4. Crear repositorio privado y app, con aprobación

Revise primero el contenido: solo código, tests, manifiestos y estas guías. No publique `.env`, claves, QR, sesiones, ledgers, uploads, entornos ni node_modules. Inicialice Git **dentro de esta carpeta nueva**, añada el allowlist revisado, haga un commit convencional y cree el repositorio privado mediante `gh repo create <su-organizacion>/<nombre> --private --source=. --remote=origin`. Empuje solo ese historial limpio tras su aprobación. No copie el `.git` original.

Cree explícitamente una aplicación **Cedar** en Heroku con stack `heroku-24`, no Fir. Asigne `heroku/python` como buildpack clásico. Su `Procfile` raíz ejecuta `web: python -B -m cloud.run`; no es un comando de desarrollo ni usa reload. `$PORT` lo lee el supervisor y el proceso público escucha en `0.0.0.0:$PORT`.

Para texto configure, en este orden, los buildpacks clásicos `heroku/nodejs` y `heroku/python`. Para audio configure primero `https://github.com/heroku/heroku-buildpack-apt`, después Node y Python; `Aptfile` contiene ffmpeg. Hágalo solo en su aplicación autorizada. El supervisor lanza Python core y Node dentro del **mismo dyno**; no use un worker separado para un endpoint loopback.

Complete las Config Vars desde un canal privado seguro, no desde un archivo versionado ni comandos que queden en capturas. Use la URL de la app en `PUBLIC_ORIGIN`. Las dependencias están fijadas en los manifiestos. No hay add-ons automáticos: use únicamente un PostgreSQL externo previamente autorizado cuando corresponda. Verifique TLS y acceso restringido de esa base con su proveedor.

Solo después de revisar configuración, alcance y coste, conecte la app al repositorio privado y despliegue la rama elegida, o añada el remoto Heroku y haga el push manual aprobado. Escale a **un solo dyno web** y un solo proceso del core. No habilite autoscaling, workers extra ni despliegues automáticos antes de validar seguridad y presupuesto. El filesystem del dyno es efímero; no use SQLite para estado de seguridad.

## 5. Aceptación y operación

1. Consulte `/health`: debe responder sin datos privados. Verifique que una solicitud de chat/control sin autenticación sea rechazada.
2. Pruebe primero una consulta inocua con su propio operador. El cliente debe recibir 202 y consultar estado; no mantenga una petición bloqueada más de 30 segundos.
3. Solo si está autorizado, habilite por separado correo, pairing o sesión pagada y pruebe con destinatario/cuenta propios. Registre aceptación del proveedor separada de recepción humana o reproducción audiovisual.
4. Compruebe reinicio, reservas inciertas y limpieza con datos sintéticos antes de usar un proveedor real. Un restart borra memoria conversacional; **no** borra PostgreSQL.
5. Si hay incertidumbre, detenga operaciones y concilie. No reintente envíos ni creaciones ciegamente. Copias de seguridad y rotación de claves requieren preservar la capacidad de descifrar estado existente.

## Fuentes oficiales

- [Procfile](https://devcenter.heroku.com/articles/procfile), [Python y .python-version](https://devcenter.heroku.com/articles/python-runtimes).
- [Disco efímero y SQLite](https://devcenter.heroku.com/articles/sqlite3), [timeout HTTP](https://devcenter.heroku.com/articles/request-timeout), [apagado](https://devcenter.heroku.com/articles/dyno-shutdown-behavior).
- [Chainlit archivado](https://docs.chainlit.io/get-started/project-status), [Open WebUI](https://docs.openwebui.com/getting-started/quick-start/).

La entrega de estas fuentes no demuestra build Linux, tamaño de slug, rendimiento cloud ni integración con cuentas. Esas comprobaciones requieren un despliegue y autorización separados.
