import { makeWASocket, initAuthCreds, BufferJSON, proto, generateMessageIDV2, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { normalizeJid, stableIds } from './guard.mjs';
import { ask } from './backend.mjs';

const logger = pino({ level:'silent' });
const encode = value => Buffer.from(JSON.stringify(value,BufferJSON.replacer));
const decode = value => JSON.parse(value.toString(),BufferJSON.reviver);

export class Gateway {
  constructor({ parse, pipeline = null, audio = false }) {
    Object.assign(this,{ parse,pipeline,audio });
    this.status = 'disabled'; this.socket = this.store = this.qr = null;
    this.busy = false; this.ready = null; this.queue = []; this.authWrites = Promise.resolve(); this.closed = false;
  }
  halt() {
    this.status = 'review_required'; this.closed = true; this.ready = null; this.qr = null;
    this.socket?.end(Error('transport_stopped')); this.pipeline?.close(); this.queue.length = 0;
  }
  async connect() {
    if (process.env.WA_ENABLE_CONNECTION !== 'true' || this.socket || this.closed) throw Error('connection_not_authorized');
    this.store = await Store.open();
    this.store.onLost = () => this.halt();
    let creds = await this.store.read('creds'); creds = creds ? decode(creds) : initAuthCreds();
    const keys = {
      get:async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const bytes = await this.store.read('key:'+type+':'+id);
          if (bytes) { let value = decode(bytes); if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value); result[id] = value; }
        }
        return result;
      },
      set:async value => {
        for (const [type,entries] of Object.entries(value))
          for (const [id,data] of Object.entries(entries)) await this.store.write('key:'+type+':'+id, data ? encode(data) : null);
      }
    };
    await this.store.write('creds',encode(creds));
    this.socket = makeWASocket({ auth:{ creds,keys },logger,browser:Browsers.ubuntu('Chrome'),
      printQRInTerminal:false,syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false });
    this.status = 'connecting';
    this.socket.ev.on('creds.update', () => {
      this.authWrites = this.authWrites.then(()=>this.store.write('creds',encode(creds))).catch(()=>this.halt());
    });
    this.socket.ev.on('connection.update', value => {
      if (value.qr) this.qr = value.qr;
      if (value.connection === 'open') { this.qr = null; this.ready = Date.now()/1000; this.status = 'connected'; }
      if (value.connection === 'close') this.halt(); // No automatic reconnect/replay on uncertain ownership.
    });
    this.socket.ev.on('messages.upsert', value => {
      this.serial = (this.serial ?? Promise.resolve()).then(()=>this.accept(value)).catch(()=>this.halt());
    });
  }
  async accept(event) {
    if (this.closed || this.ready === null || event.type !== 'notify' || event.requestId) return;
    for (const item of event.messages ?? []) {
      if (this.queue.length+(this.busy?1:0) >= 8) break;
      const timestamp = Number(item.messageTimestamp);
      if (!Number.isFinite(timestamp) || timestamp < this.ready-2 || timestamp > Date.now()/1000+30) continue;
      const identities = [this.socket.user?.id,this.socket.user?.lid].map(normalizeJid).filter(Boolean);
      const input = this.parse(item,identities,this.audio);
      if (!input || await this.store.known('out:'+item.key.id)) continue;
      const messageId = createHash('sha256').update(item.key.id).digest('hex');
      if (!await this.store.claim('in:'+messageId)) continue;
      const identity = identities.find(value=>value.endsWith('@s.whatsapp.net')) ?? identities[0];
      this.queue.push({ ...input,id:messageId,jid:item.key.remoteJid,ids:stableIds(identity,item.key.id) });
    }
    if (!this.busy) { this.busy = true; void this.drain().catch(()=>this.halt()).finally(()=>{ this.busy = false; }); }
  }
  async drain() {
    while (!this.closed && this.queue.length) {
      const item = this.queue.shift();
      const input = this.pipeline ? await this.pipeline.input(item,{ getSocket:()=>this.socket }) : item;
      const { wantsAudio } = this.audio ? await import('./audio.mjs') : { wantsAudio:()=>false };
      const delivery = wantsAudio(input.text) ? 'audio' : 'text';
      const result = await ask({ message:input.text,...item.ids,audio_capable:this.audio,response_delivery:delivery });
      const output = this.pipeline ? await this.pipeline.output(result.response,input.text,delivery) : { text:result.response };
      delete output.audio_failure;
      if (this.closed) throw Error('transport_stopped');
      await this.store.alive();
      const id = generateMessageIDV2(this.socket.user?.id);
      if (!await this.store.claim('out:'+id)) throw Error('outgoing_id_collision');
      if (output.audio) {
        const { sendAudioMemory } = await import('./ram-upload.mjs');
        await sendAudioMemory(this.socket,item.jid,output,id,{assertOwner:()=>this.store.alive()});
      } else {
        await this.socket.sendMessage(item.jid,output,{ messageId:id });
      }
      await this.store.done('out:'+id); await this.store.done('in:'+item.id);
    }
  }
  async close() {
    this.halt();
    await this.authWrites;
    if (this.store) await this.store.close();
  }
}
