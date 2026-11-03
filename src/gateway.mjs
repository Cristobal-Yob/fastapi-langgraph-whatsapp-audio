import { makeWASocket, generateMessageIDV2, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { normalizeJid, stableIds } from './guard.mjs';
import { ask } from './backend.mjs';
import { PhoneLink } from './pairing.mjs';

const logger = pino({ level:'silent' });

export class Gateway {
  constructor({parse,pipeline=null,audio=false,createSocket=makeWASocket,openStore=()=>Store.open(),
    maxReconnects=3,reconnectMs=1000}) {
    Object.assign(this,{parse,pipeline,audio,createSocket,openStore,maxReconnects,reconnectMs});
    this.status='disabled';this.socket=this.store=this.qr=null;
    this.busy=false;this.ready=null;this.queue=[];this.authWrites=Promise.resolve();this.closed=false;
    this.generation=0;this.reconnects=0;this.everConnected=false;this.pairingRestarted=false;
    this.pairing=new PhoneLink({onUncertain:()=>this.halt()});
  }
  enabled() {return process.env.WA_ENABLE_CONNECTION==='true';}
  requestCode(phone) {return !this.closed && this.pairing.request(phone);}
  halt() {
    if(this.closed)return;
    this.status='review_required';this.closed=true;this.ready=null;this.qr=null;this.generation++;
    clearTimeout(this.reconnectTimer);this.pairing.stop();this.queue.length=0;
    try{this.socketClosed=Promise.resolve(this.socket?.end(Error('transport_stopped')))}catch(error){this.socketClosed=Promise.reject(error)}
    this.socketClosed.catch(()=>{});
    this.pipelineClosed=Promise.resolve().then(()=>this.pipeline?.close());
    this.pipelineClosed.catch(()=>{});
  }
  async connect() {
    if(!this.enabled() || this.status!=='disabled' || this.closed)throw Error('connection_not_authorized');
    this.status='preparing';
    this.opening=Promise.resolve().then(()=>this.closed ? null : this.openStore());
    this.store=await this.opening;
    if(this.closed)return;
    this.store.onLost=()=>this.halt();this.openSocket(true);
  }
  openSocket(newAttempt=false) {
    if(this.closed)return;
    const generation=++this.generation;
    const socket=this.createSocket({auth:this.store.auth,logger,browser:Browsers.ubuntu('Chrome'),
      printQRInTerminal:false,syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false});
    this.socket=socket;this.status='connecting';this.pairing.begin(socket,this.store.auth.creds,{newAttempt});
    const current=()=>!this.closed && generation===this.generation && socket===this.socket;
    socket.ev.on('creds.update',()=>{
      if(!current())return;
      this.authWrites=this.authWrites.then(()=>this.store.saveCreds()).catch(()=>this.halt());
    });
    socket.ev.on('connection.update',value=>{
      if(!current())return;
      if(Object.hasOwn(value,'qr')) {this.qr=typeof value.qr==='string' ? value.qr : null;this.pairing.observeQr(socket,value.qr);}
      if(value.connection==='open') {
        const identities=[socket.user?.id,socket.user?.lid].map(normalizeJid).filter(Boolean);
        if(this.store.auth.creds.registered!==true || !identities.length){this.halt();return;}
        this.pairing.stop();this.qr=null;this.ready=Date.now()/1000;this.status='connected';this.everConnected=true;
      }
      if(value.connection==='close') {
        const code=value.lastDisconnect?.error?.output?.statusCode;
        const registered=this.store.auth.creds.registered===true;
        const safe=code===515 ? registered && !this.pairingRestarted :
          [405,408].includes(code) && (!this.pairing.attempted || this.everConnected);
        this.ready=null;this.qr=null;this.pairing.stop();
        if(!safe || this.reconnects>=this.maxReconnects){this.halt();return;}
        if(code===515)this.pairingRestarted=true;
        this.reconnects++;this.socket=null;this.status='restarting';const revision=++this.generation;
        this.reconnectTimer=setTimeout(()=>{
          void this.authWrites.then(()=>{if(!this.closed && revision===this.generation)this.openSocket()}).catch(()=>this.halt());
        },this.reconnectMs);
        this.reconnectTimer.unref?.();
      }
    });
    socket.ev.on('messages.upsert',value=>{
      if(!current())return;
      this.serial=(this.serial??Promise.resolve()).then(()=>this.accept(value)).catch(()=>this.halt());
    });
  }
  async accept(event) {
    if (this.closed || this.ready === null || event.type !== 'notify' || event.requestId) return;
    for (const item of event.messages ?? []) {
      if (item.key?.fromMe !== true) continue;
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
    if (!this.busy) { this.busy = true; this.drainPromise = this.drain().catch(()=>this.halt()).finally(()=>{ this.busy = false; }); }
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
  close({resetAuth=false}={}) {
    if(resetAuth && this.closePromise && !this.resetRequested)return Promise.reject(Error('transport_already_closed'));
    if(this.closePromise && !(resetAuth && this.closeFailed))return this.closePromise;
    this.resetRequested=resetAuth;this.closeFailed=false;this.halt();
    this.closePromise=(async()=>{
      const results=await Promise.allSettled([this.opening,this.serial,this.drainPromise,this.pipelineClosed,this.socketClosed,this.authWrites]);
      await this.drainPromise;
      if(results.some(result=>result.status==='rejected'))throw Error('transport_close_incomplete');
      if(resetAuth && !this.store)this.store=await this.openStore();
      if(this.store)await this.store.close({resetAuth});
    })().catch(error=>{this.closeFailed=true;throw error});
    return this.closePromise;
  }
}
