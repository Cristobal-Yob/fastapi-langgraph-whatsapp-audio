# Vincular su propio WhatsApp por código

Esta base usa Baileys, un conector comunitario **no oficial**. Revise los términos de WhatsApp y el riesgo de bloqueo antes de vincular. Es **una app, un operador y una cuenta**: cada alumno despliega su propia copia. No es un portal multiusuario. Mantenga un único conector activo por celular al alternar texto y audio.

## 1. Publicar y desplegar su copia

Siga `CREAR_AGENTE.md` y `HEROKU.md`: copie únicamente las fuentes permitidas, publique su commit en un repositorio GitHub propio y despliegue esa misma versión en su app Heroku. Configure su propio `AGENT_API_TOKEN`, `PUBLIC_ORIGIN` HTTPS y acceso a la LLM. Nunca copie credenciales del docente. No configure `PORT` ni `CORE_PORT`; el supervisor mantiene LangGraph privado en el mismo dyno.

Las plantillas empiezan con `WA_ENABLE_CONNECTION=false`. Solo después de autorizar la vinculación de SU cuenta, usando el `$App` definido en la guía Heroku, active:

```powershell
heroku config:set WA_ENABLE_CONNECTION=true --app $App
```

Esa variable habilita la acción del operador; no solicita códigos ni vincula automáticamente. Mantenga un único dyno/worker y use los buildpacks indicados en `HEROKU.md`. Localmente se requiere Node 24 y las dependencias del package-lock propio; `npm ci --ignore-scripts` es una instalación que usted debe autorizar, no una acción realizada por esta guía.

## 2. Pedir el código en el panel privado

1. Abra la URL HTTPS de SU app e introduzca SU `AGENT_API_TOKEN` en **Clave del operador**. Pulse **Desbloquear**.
2. Pulse **Iniciar vinculación**. Espere a que se habilite **Obtener código para mi número**. La aplicación espera el handshake de WhatsApp; no tiene que escanear un QR para usar código.
3. Ingrese solo SU número con código de país, entre 7 y 15 dígitos, sin `+`, espacios ni separadores. El número se introduce únicamente aquí: no va en `.env`, comandos, Git, capturas ni registros.
4. Pulse **Obtener código para mi número** una sola vez. El panel muestra el código real devuelto por WhatsApp, solo para este intento. El código **no es un SMS** ni un OTP recibido en su teléfono.
5. En WhatsApp del celular, abra **Dispositivos vinculados**, **Vincular un dispositivo** y **Vincular con número de teléfono**. Ingrese allí el código que muestra su panel.
6. Espere **Conectado**. Mostrar un código no significa que la cuenta ya esté vinculada: se confirma cuando WhatsApp abre la conexión con credenciales registradas. Envíe entonces un mensaje nuevo en **Mensaje para ti** y compruebe la respuesta del mismo LangGraph.

El código queda solo en RAM y en una respuesta autenticada, sin caché; no aparece en logs ni en `/api/status`. Se borra al desconectar, cambiar de socket o vencer el límite local de 120 segundos. WhatsApp puede invalidarlo antes. El número no se copia a un archivo propio; Baileys conserva las credenciales/identidad necesarias de su protocolo en su almacén privado.

## 3. QR alternativo y nuevo intento explícito

Si prefiere QR, pulse **Usar QR en lugar del código** antes de solicitar un código y escanéelo desde Dispositivos vinculados. Puede volver a código antes de consumir ese intento. No se cambia automáticamente de modo después de una solicitud incierta.

Ante una desconexión o resultado no confirmado, **no se solicita otro código automáticamente**. Revise primero Dispositivos vinculados en el celular. Pulse **Desconectar**, espere **Desconectado** y pulse **Iniciar nuevo intento**. El panel espera a cerrar las operaciones anteriores antes de crear un conector nuevo. No necesita reiniciar Heroku, borrar `auth`, eliminar un lock ni modificar las credenciales. Si ya existe una sesión registrada, se intenta abrir esa sesión; no se genera otro código para ella.

Solo la finalización conocida de una vinculación registrada y ciertas reconexiones tienen un presupuesto acotado de reinicio interno. Un error incierto tras pedir código se detiene para revisión: refrescar la página, consultar el estado o volver a desbloquear no genera otro código.

## 4. Privacidad y durabilidad

Baileys guarda credenciales y claves Signal con `useMultiFileAuthState` en `.runtime/whatsapp-auth`, ignorado por Git y restringido al proceso. El ledger de deduplicación vive en RAM, admite 2048 IDs y rechaza al llenarse. No se añade PostgreSQL ni un registro persistente de teléfonos/códigos. No se procesa historial, contactos ni grupos: solo mensajes nuevos enviados por la cuenta vinculada a su propio chat.

El disco de Heroku es efímero. Un deploy/reinicio puede requerir nueva vinculación y pierde la deduplicación RAM; el reintento desde el panel conserva los archivos de autenticación mientras ese dyno siga vivo. Para durabilidad entre dynos debe diseñar y probar una ampliación separada. No repita automáticamente un envío incierto.

Las pruebas offline usan sockets, números y respuestas sintéticos; no acreditan una vinculación ni entrega real. Pruebe el panel con su propio celular después del despliegue autorizado, sin compartir el número o código por chat.

## 5. Texto y audio en esta variante

Configure `ELEVENLABS_API_KEY` y `ELEVENLABS_VOICE_ID` propios. El flujo real es audio WhatsApp -> descarga limitada en RAM -> ffprobe/ffmpeg por pipes -> STT `scribe_v2` -> **el mismo LangGraph** -> texto, o TTS `eleven_v4_turbo` por WebSocket y Ogg/Opus solo si el mensaje actual pide expresamente voz. Recibir audio no autoriza voz de salida; el siguiente turno vuelve a texto sin esa petición. La gramática conserva exclusiones de citas, negaciones e hipótesis. La subida de salida usa cifrado, hashes y relay del SDK en RAM; no llama al preparador predeterminado de Baileys que crea temporales cifrados. No se guarda audio ni transcripción en disco; proveedores pueden tener su propia retención.

`Aptfile` pide ffmpeg y el buildpack apt debe ir primero. Compruebe después `ffmpeg -encoders` y `ffprobe -version`: debe existir `libopus`. Localmente instale esos binarios de manera explícita. Los códecs están limitados a protocolos pipe y audio acotado; no se sustituye la validación por una bandera. Un fallo de síntesis devuelve texto con aviso, no afirma entrega de audio.

Las dos variables ElevenLabs se validan al arrancar el conector completo, aunque
`WA_ENABLE_CONNECTION=false`. Ese gate impide vincular WhatsApp, no omite la configuración
del adaptador de audio. No active la conexión para intentar solucionar una clave faltante.
