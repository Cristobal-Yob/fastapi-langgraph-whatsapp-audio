# Configuración específica

Instale Node 24 y ejecute `npm ci --ignore-scripts`; cada repositorio tiene su propio package-lock y todas sus dependencias. Baileys es un conector comunitario **no oficial**; evalúe los términos y el riesgo de bloqueo de la cuenta antes de vincularla.

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir otro QR y pierde la deduplicación.

Mantenga `WA_ENABLE_CONNECTION=false` hasta autorizar la vinculación. Luego cambie a true, abra la página HTTPS, introduzca el bearer y pulse Iniciar vinculación. Solo el operador autenticado puede ver el QR en memoria. Conectarse y detener requieren Origin exacto y token CSRF; no hay códigos/QR en stdout ni un endpoint público de pairing. Escanee desde Dispositivos vinculados. Se aceptan únicamente eventos notify nuevos de su propio chat, con identidad verificada antes de leer contenido. No se reproduce historial.

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir otro QR y pierde la deduplicación.

Configure `ELEVENLABS_API_KEY` y `ELEVENLABS_VOICE_ID` propios. El flujo real es audio WhatsApp -> descarga limitada en RAM -> ffprobe/ffmpeg por pipes -> STT `scribe_v2` -> **el mismo LangGraph** -> texto, o TTS `eleven_v4_turbo` por WebSocket y Ogg/Opus solo si el mensaje actual pide expresamente voz. Recibir audio no autoriza voz de salida; el siguiente turno vuelve a texto sin esa petición. La gramática conserva exclusiones de citas, negaciones e hipótesis. La subida de salida usa cifrado, hashes y relay del SDK en RAM; no llama al preparador predeterminado de Baileys que crea temporales cifrados. No se guarda audio ni transcripción en disco; proveedores pueden tener su propia retención.

`Aptfile` pide ffmpeg y el buildpack apt debe ir primero. Compruebe después `ffmpeg -encoders` y `ffprobe -version`: debe existir `libopus`. Localmente instale esos binarios de manera explícita. Los códecs están limitados a protocolos pipe y audio acotado; no se sustituye la validación por una bandera. Un fallo de síntesis devuelve texto con aviso, no afirma entrega de audio.

Las dos variables ElevenLabs se validan al arrancar el conector completo, aunque
`WA_ENABLE_CONNECTION=false`. Ese gate impide vincular WhatsApp, no omite la configuración
del adaptador de audio. No active la conexión para intentar solucionar una clave faltante.
