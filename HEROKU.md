# WhatsApp Web con audio: personalizar y desplegar por Heroku CLI

Empiece por [CREAR_AGENTE.md](CREAR_AGENTE.md): crear una copia propia, configurar Python,
cambiar el rol y, si hace falta, añadir una herramienta de lectura. Este documento continúa
desde la raíz de **su copia**, con PowerShell 7, Git y Heroku CLI ya instalados.

**Estado:** estas guías describen operaciones que usted debe revisar y autorizar. No se ha
hecho un despliegue, una instalación ni una prueba pagada por redactarlas. Los repositorios
remotos anteriores no acreditan esta versión local de las fuentes.

## 1. Terminar la configuración específica

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir una nueva vinculación por código o QR y pierde la deduplicación.

No envíe credenciales personales ADC de su equipo a Heroku. El camino básico de este tutorial
usa una clave propia de Google AI Studio y `GOOGLE_GENAI_USE_VERTEXAI=false`. Si su organización
requiere Vertex, use su mecanismo autorizado de identidad de servidor y permisos mínimos;
no sustituya ese diseño copiando el archivo ADC local.

## 2. Crear su historial Git con fuentes revisadas

La copia del primer paso no contiene `.git`. No ejecute `git init` sobre el checkout original
del mantenedor ni copie su historial. En la carpeta nueva:

```powershell
git init -b main
$SourceFiles = @(
    'src/pairing.mjs', 'src/server.mjs', 'test/pairing.test.mjs',
    'test/operator.test.mjs', 'test/network-guard.mjs', 'test/docs.test.mjs',
    'DURABILIDAD.md',
    '.env.example', '.gitattributes', '.gitignore',
    '.python-version', 'Aptfile', 'CONFIGURACION.md',
    'CREAR_AGENTE.md', 'HEROKU.md', 'Procfile',
    'README.md', 'SOURCE.md', 'app.json',
    'app/__init__.py', 'app/graph.py', 'app/memory.py',
    'app/prompts.py', 'app/provider.py', 'cloud/__init__.py',
    'cloud/api.py', 'cloud/client.py', 'cloud/run.py',
    'cloud/security.py', 'cloud/serve.py', 'licenses/Baileys-MIT.txt',
    'package-lock.json', 'package.json', 'requirements-dev.txt',
    'requirements.txt', 'src/audio.mjs', 'src/backend.mjs',
    'src/download-audio.mjs', 'src/elevenlabs.mjs', 'src/gateway.mjs',
    'src/guard.mjs', 'src/index.html', 'src/input-failure.mjs',
    'src/input-guard.mjs', 'src/main.mjs', 'src/media.mjs',
    'src/ram-upload.mjs', 'src/store.mjs', 'test/audio.test.mjs',
    'test/cloud.test.mjs', 'test/database.test.mjs', 'test/direct-download.test.mjs',
    'test/ram-upload.test.mjs', 'tests/test_cloud.py', 'tests/test_graph.py',
    'tests/test_origin.py', 'tests/test_serve.py', 'tests/test_synchronous.py',
    'variant.json', 'tests/test_policy_isolation.py'
)
git add -- $SourceFiles
if (Test-Path -LiteralPath app/course_context.py) {
    git add -- app/course_context.py tests/test_course_context.py
}
git check-ignore -- .env .venv .runtime
git status --short
git diff --cached --stat
git diff --cached --name-only
```

Antes de continuar, confirme que no hay `.env`, OAuth, sesiones, registros, datos, paquetes ni
claves en el índice. Revise también sus modificaciones: los valores secretos nunca pertenecen
a Python, HTML o documentación. Si añadió la extensión del tutorial, incluya explícitamente
`app/course_context.py` y `tests/test_course_context.py`; agregue también sus pruebas/datos
públicos nuevos de manera deliberada, no con un `git add .` indiscriminado.

```powershell
git commit -m "feat: create course assistant from template"
```

Este primer commit es necesario: no existe `HEAD` para el push hasta crearlo. Si Git pide su
nombre/correo, configure su identidad propia; no use una identidad del mantenedor. El commit
es una instrucción para el lector, no una operación ejecutada al preparar esta guía.

### Publicar primero la versión en su GitHub

Cree desde GitHub un repositorio propio vacío, sin archivos ni credenciales. Después del
commit revisado del paso anterior, copie su URL HTTPS aquí. No use la URL del docente:

```powershell
$GitHubUrl = Read-Host 'URL HTTPS de su repositorio GitHub vacío'
git remote add origin $GitHubUrl
git push -u origin main
```

El despliegue debe corresponder a ese mismo commit publicado. No añada `.env`, números,
códigos, `.runtime` o `node_modules` al historial. Esta guía no crea un workflow automático.

## 3. Crear una app o seleccionar una existente

```powershell
heroku --version
heroku login
$App = Read-Host 'Nombre de su app Heroku'
heroku create $App --stack heroku-24
```

Si la app **ya existe**, omita únicamente `heroku create`: conserve `$App` con su nombre exacto.
No adivine el nombre de otra cuenta. Use **Cedar/buildpacks clásicos**; las instrucciones no
describen un despliegue Fir. Crear/configurar una app, hacer push y escalar pueden generar
cargos; continúe solo con su autorización y presupuesto.

```powershell
heroku buildpacks:set https://github.com/heroku/heroku-buildpack-apt --app $App
heroku buildpacks:add --index 2 heroku/nodejs --app $App
heroku buildpacks:add --index 3 heroku/python --app $App
heroku buildpacks --app $App
```

En aplicaciones existentes revise su lista antes de cambiarla. En WhatsApp Web, Node va antes
de Python; en audio WhatsApp, apt va primero, luego Node y por último Python. `app.json` no
aplica automáticamente variables, buildpacks ni formación cuando se usa `heroku create` y Git push.

Obtenga el origen real, que puede contener un sufijo aleatorio:

```powershell
$Info = heroku apps:info --app $App --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $Info.app.web_url) { throw 'No se pudo obtener web_url de la app.' }
$Uri = [uri]$Info.app.web_url
if ($Uri.Scheme -ne 'https') { throw 'La app debe tener un origen HTTPS válido.' }
$Origin = $Uri.GetLeftPart([System.UriPartial]::Authority)
```

## 4. Configurar variables por CLI, sin valores literales en el historial

Primero valores públicos, manteniendo separados el modelo principal y fallback:

```powershell
heroku config:set WEB_CONCURRENCY=1 APP_VARIANT=whatsapp-audio GOOGLE_GENAI_USE_VERTEXAI=false MODELO=gemini-3.5-flash-lite FALLBACK_MODEL=gemini-3.5-flash LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false "PUBLIC_ORIGIN=$Origin" --app $App
heroku config:set WA_ENABLE_CONNECTION=false --app $App
```

Mantenga `WEB_CONCURRENCY=1`: el estado temporal y las reservas pertenecen a un único proceso. El buildpack puede elegir dos procesos si omite este valor.

No configure `PORT`: Heroku lo asigna. Si sus modelos autorizados son otros, cambie ambos nombres
por modelos distintos disponibles en su cuenta. Conserve las activaciones de envío/conexión/audio
deshabilitadas mientras prepara la aplicación.

Para tokens y claves de una sola línea, introduzca el valor mediante una lectura oculta.
Este helper admite únicamente caracteres simples; rechaza comillas, espacios, saltos de línea
y metacaracteres que Windows podría reinterpretar. **No sirve para JSON ni una URL de conexión
arbitraria**. No pone valores literales en el historial ni muestra la salida del setter,
pero Heroku CLI recibe el valor en sus argumentos: otro proceso con permisos puede observarlo
brevemente. Úselo únicamente en un equipo y terminal privados, sin grabación ni depuración.

```powershell
function Set-HerokuSimpleSecret {
    param([Parameter(Mandatory)][string]$Name)
    $secureValue = Read-Host "Valor privado para $Name" -AsSecureString
    $credential = [System.Management.Automation.PSCredential]::new('operator', $secureValue)
    $value = $credential.GetNetworkCredential().Password
    try {
        if ($value -notmatch '^[A-Za-z0-9_./:=+@-]+$') {
            throw 'Valor complejo: use el procedimiento config:edit explicado debajo.'
        }
        & heroku config:set "$Name=$value" --app $App *> $null
        if ($LASTEXITCODE -ne 0) { throw "No se pudo configurar $Name; no se imprimirá el valor." }
    } finally {
        $value = $null
        $credential = $null
        $secureValue.Dispose()
    }
}
Set-HerokuSimpleSecret 'AGENT_API_TOKEN'
Set-HerokuSimpleSecret 'GOOGLE_API_KEY'
Set-HerokuSimpleSecret 'ELEVENLABS_API_KEY'
Set-HerokuSimpleSecret 'ELEVENLABS_VOICE_ID'
```

Use para `AGENT_API_TOKEN` el mismo bearer privado que eligió para su agente. Genere secretos
de operador con `secrets.token_urlsafe(32)`; no los publique ni los incluya en la carpeta de fuentes. Nunca ejecute `heroku config` para
compartir una captura: muestra los valores. No pegue secretos en ejemplos, chats o commits.

### Valores complejos o multilínea

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir una nueva vinculación por código o QR y pierde la deduplicación.


El comando nativo siguiente abre todas las variables en un editor. Configure un editor local
de confianza según su instalación de Heroku CLI (por ejemplo, `EDITOR=notepad` en Windows):

```powershell
$env:EDITOR = 'notepad'
heroku config:edit --app $App
```

**Advertencia:** utiliza un archivo temporal en texto claro y muestra un diff con valores
sin enmascarar antes de pedir confirmación. No lo use en una pantalla compartida, grabada,
un editor sincronizado o con copias de respaldo automáticas. Preserve las variables existentes,
añada `NOMBRE=valor` y guarde/cierre el editor. Para JSON OAuth use una sola línea compacta.
Revise el diff y confirme solo si es correcto. No use `config:edit NUEVA_VARIABLE`: esta guía
edita la lista completa. No existe aquí un `config:push` ni un `--prompt` seguro para secretos.
Si su política no permite este archivo temporal o argumentos transitorios, deténgase y use
el mecanismo de inyección de secretos autorizado por su organización; no debilite esa política.

Revise todos los nombres de `.env.example`, además de `COURSE_NAME` y `COURSE_CONTACT` si añadió
esa extensión. No deje un placeholder como credencial. Ningún comando de esta sección comprueba
por sí solo los permisos de las cuentas ni realiza una conversación real.

## 5. Subir la versión propia y arrancar deliberadamente

Compruebe el `Procfile` de esta carpeta: este es el comando que Heroku debe usar, no una API ajena.

```text
web: python -B -m cloud.run --port $PORT
```

El siguiente push puede lanzar un proceso `web` inicial. No suponga que la formación apagada
de `app.json` se aplica a este recorrido por CLI. Autorice el gasto antes del push y deténgase
si todavía falta configuración del canal.

Elija una instancia que admita el build y consumo real de este adaptador. Basic no constituye
una garantía de memoria suficiente para Open WebUI o el SDK de avatar; mida y seleccione una
instancia adecuada antes de validarlo. Si no tiene un tamaño validado para esos casos, no escale todavía.

```powershell
heroku git:remote --app $App
if ((git rev-parse HEAD) -ne (git rev-parse origin/main)) { throw 'Publique primero este commit en su GitHub.' }
git push heroku HEAD:main
$DynoType = 'basic'
heroku ps:scale "web=1:$DynoType" --app $App
heroku ps --app $App
heroku releases --app $App
Invoke-RestMethod -Uri ($Origin + '/health')
```

Un build correcto o `/health` no demuestran permisos,
correo recibido, vinculación, voz reproducida ni vídeo visto.

La URL pública sirve este adaptador. El `/chat` de su core permanece en `127.0.0.1:18080` dentro del dyno; no espere que una petición pública a `/chat` lo alcance. Valide la identidad y el flujo usando su interfaz, sin exponer el puerto interno.


Para comprobar sin activar efectos el core de los adaptadores con servidor privado, use las
pruebas locales de [CREAR_AGENTE.md](CREAR_AGENTE.md). Una comprobación autenticada incorrecta
debe fallar; no quite el bearer para lograr una respuesta. Active su canal real solo cuando
quiera probar una acción explícita y sus proveedores estén autorizados.

### Autorizar la vinculación de su celular

Con la app desplegada y sus variables privadas válidas, autorice esta acción y active:

```powershell
heroku config:set WA_ENABLE_CONNECTION=true --app $App
```

Abra su URL HTTPS, desbloquee con su bearer y pulse **Iniciar vinculación**. En el modo
principal ingrese su propio número solo en el panel y solicite el código una vez; luego
introdúzcalo en WhatsApp, Dispositivos vinculados, Vincular con número de teléfono.
No es un SMS. **Conectado**, no la aparición del código, confirma la sesión. Pruebe un
mensaje nuevo en Mensaje para ti. QR es una alternativa manual antes de pedir el código.

Si el resultado no se confirma, revise su celular, pulse **Desconectar**, espere el cierre
y pulse **Iniciar nuevo intento**. No reinicie Heroku ni borre autenticación para reintentar
desde el panel. Use un solo conector por celular, tanto al probar texto como texto/audio.
El deploy/reinicio del dyno sí puede perder la sesión por disco efímero. El recorrido completo,
los límites y la privacidad están en [CONFIGURACION.md](CONFIGURACION.md).

## 6. Actualizar, diagnosticar y apagar

Cada cambio posterior necesita revisión y un nuevo commit antes del push. No active trazas ni
imprima mensajes, audios, tokens o respuestas crudas del proveedor para diagnosticar. Comparta
solo etapa/categoría de error. Un timeout no prueba que un efecto remoto no haya ocurrido;
concilie envíos inciertos antes de decidir otra acción, sin reintento automático.

```powershell
heroku ps:scale web=0 --app $App
heroku ps --app $App
```

Esto apaga los dynos del proceso, no borra consumo acumulado, suscripciones ni complementos.
El disco de Heroku es efímero: OAuth, sesiones de WhatsApp y reservas de efectos deben usar el
almacenamiento externo indicado. No borre credenciales ni cambie namespaces para forzar reintentos.

## Lista final

- [ ] El repositorio propio contiene fuentes revisadas, no secretos ni historial ajeno.
- [ ] El rol y los criterios corresponden a su negocio y las rutas coinciden con el esquema.
- [ ] Las pruebas locales y las comprobaciones de su canal real se distinguen.
- [ ] Buildpacks, variables específicas y origen HTTPS son los de su propia app.
- [ ] Se autorizó el consumo y se verificó la entrega real antes de llamarlo funcional.
- [ ] Sabe apagarlo y conservar el estado que no puede perderse.

Referencias oficiales: [preparar Heroku](https://devcenter.heroku.com/articles/preparing-a-codebase-for-heroku-deployment),
[comandos CLI](https://devcenter.heroku.com/articles/heroku-cli-commands),
[Config Vars](https://devcenter.heroku.com/articles/config-vars),
[buildpacks](https://devcenter.heroku.com/articles/managing-buildpacks) y
[HTTP routing](https://devcenter.heroku.com/articles/http-routing).

## Alcance de las variables

La [plantilla local](.env.example) y `app.json` declaran las mismas variables del usuario.
El manifiesto añade `APP_VARIANT` como identidad fija; el arranque también la obtiene de
`variant.json`. No añada variables de otros canales ni configure `PORT`, `CORE_PORT`
o una URL pública para el núcleo privado. Mantenga los gates en `false` hasta la prueba autorizada.
El manifiesto usa Developer API; si elige Vertex por CLI, configure el selector, proyecto,
ubicación e identidad autorizada y no necesita `GOOGLE_API_KEY`.
Las dos variables ElevenLabs son obligatorias para arrancar el conector completo, aun con
`WA_ENABLE_CONNECTION=false`. La prueba del núcleo solo no ejecuta ese conector.

Un `.env` privado local puede usar Vertex aunque la plantilla pública empiece por Developer.
Antes de ejecutar el bloque `config:set` de Developer, compruebe su perfil; no cambie el backend
solo para copiar un comando. Para Vertex son necesarios selector `true`, proyecto, ubicación
y una identidad de servidor autorizada en el destino. El ADC local no se copia ni acredita
autenticación en Heroku. Este documento no publica los `.env` privados.
