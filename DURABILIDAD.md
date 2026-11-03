# Persistencia opcional: fuera del recorrido básico

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir una nueva vinculación por código o QR y pierde la deduplicación.

## Antes de ampliar

1. Mantenga el ejemplo básico en una sola instancia. No añada PostgreSQL para probar el agente.
2. Si necesita sobrevivir reinicios, diseñe y pruebe una ampliación con almacenamiento externo y permisos propios.
3. Para efectos externos, la reserva debe ser atómica antes del efecto; un resultado incierto nunca autoriza reenvío automático.
4. Pruebe caídas, concurrencia, recuperación y eliminación de datos con información sintética antes de usar cuentas reales.

Esta carpeta no incluye un backend PostgreSQL activo ni promete coordinación distribuida.
La implementación anterior se conserva en el archivo de fuentes del mantenedor, no en el paquete básico.
No copiar una URL de base de datos crea ese backend ni migra registros. No se contratan servicios desde app.json.
Nunca publique credenciales, bases SQLite, archivos Signal o registros de acciones.

[Volver a la configuración del canal](CONFIGURACION.md).

El helper nativo es adecuado para esta base de un solo proceso, no una recomendación de almacenamiento distribuido para producción. Consulte [su contrato y advertencia upstream](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/use-multi-file-auth-state.ts).
