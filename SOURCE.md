# Procedencia

La base procede del starter local FastAPI/LangGraph revisado el 27 de octubre de 2026. Se copian únicamente fuentes allowlisted; no historial Git, configuración privada, entornos ni estado de cuentas.

Baileys guarda únicamente credenciales y claves Signal con su helper nativo en `.runtime/whatsapp-auth`, privado e ignorado por Git. No guarda cuerpos de mensajes, audios ni transcripciones. El ledger de entrada/salida vive en RAM, admite 2048 IDs y rechaza al llenarse; no expulsa acciones inciertas. Use un único Node/worker/dyno y no ejecute ambas variantes con la misma cuenta. En Heroku el disco es efímero: un reinicio/deploy puede exigir otro QR y pierde la deduplicación.

Hashes SHA-256 de la base:

```json
{
  "graph.py": "aaa18441525fd8d9c4ed8ad43c2551e5349f9756ad449bbc52ec80341e979b8a",
  "prompts.py": "67806e3ff5656a3933c22c9d556fdafa0e1dd511f6a60d26e700ba23a3cff783",
  "provider.py": "0b4a2851c9ffaf6968868920f04258e45f90ced8dceda4d6b5d082dfa0fffb9e",
  "memory.py": "002ce0bbe03f18d1e38c14dea7205f6b78aa3397de885d33da8c8bddc14819bf"
}
```

El origen queda intacto y no es una dependencia runtime. No se han copiado credenciales, contenido del usuario, audios, registros ni carpetas privadas. Esta preparación no prueba entrega real.

## Upstream media compatibility

The bounded RAM-only outgoing media adapter follows Baileys 7.0.0-rc14 public `getMediaKeys`, protobuf audio fields and `relayMessage` interfaces. Its encryption/upload metadata matches the MIT-licensed implementation in [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys). The [upstream MIT notice](licenses/Baileys-MIT.txt) is retained. No upstream vendor file is modified. Unlike the default media preparer, this adapter writes neither plaintext nor encrypted audio files. Synthetic encryption/SDK compatibility checks and real local ffmpeg/ffprobe checks are not a real WhatsApp delivery or a Linux/Heroku build proof.
