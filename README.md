# WhatsApp Web con audio

Plantilla autónoma para construir un agente propio sobre el mismo LangGraph:
mensaje → router → respuesta real con fallback → entrega del adaptador.
No depende de otro repositorio ni de una API central.

## Crear su agente y desplegar

1. [Copiar las fuentes y personalizar rol, criterios y una herramienta de lectura opcional](CREAR_AGENTE.md).
2. [Preparar su Git y desplegar con Heroku CLI](HEROKU.md).
3. Completar la configuración de su canal y verificar una acción real autorizada.

Consulte además [la configuración específica del canal](CONFIGURACION.md) antes de activarlo.

## Archivos principales

- `app/`: grafo, prompts, proveedor/fallback y memoria RAM acotada.
- `cloud/api.py`: `POST /chat` interno o público según variante, autenticado y con plazo máximo de 25 segundos.
- `Procfile`: entrada exacta de este adaptador en Heroku, con su `PORT`.
- `.env.example`: nombres de configuración, nunca credenciales reales.
- `tests/`: contratos sintéticos, no resultados reales de proveedores.

Estas fuentes y guías son una entrega local: todavía no se han publicado ni desplegado.
Conserve credenciales, sesiones y registros fuera de Git. El catálogo no añade telefonía.

## Alcance del grafo

Router → preventa/postventa/genérica → respuesta → fin. No incluye política, nodos ni transporte de correo. Los prompts están en español.

## Variables de este ejemplo

Use únicamente su [`.env.example`](.env.example): ocho variables comunes y las específicas
del canal que aparecen allí. Los comentarios separan arranque, opciones y activación.

## Estado básico y ampliación

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir otro QR y pierde la deduplicación.

[Persistencia opcional y límites](DURABILIDAD.md).
