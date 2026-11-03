// Phone-code state is process-local. Only explicit owner actions request a code.
export const validPhone = value => typeof value === 'string' && /^[1-9][0-9]{6,14}$/.test(value);

export class PhoneLink {
  constructor({ onUncertain=()=>{}, requestTimeoutMs=20000, codeTtlMs=120000, windowMs=900000 }={}) {
    Object.assign(this,{onUncertain,requestTimeoutMs,codeTtlMs,windowMs});
    this.mode='code'; this.generation=0; this.attempted=false; this.phase='unavailable';
    this.code=null; this.expiresAt=null; this.socket=null; this.handshake=false;
  }
  clearTimers() {
    for(const name of ['requestTimer','codeTimer','windowTimer']) { clearTimeout(this[name]); this[name]=null; }
  }
  begin(socket,creds,{newAttempt=true}={}) {
    this.clearTimers(); this.generation++; this.socket=socket; this.creds=creds;
    this.handshake=false; this.code=null; this.expiresAt=null; this.phase='unavailable';
    if(newAttempt) { this.attempted=false; this.deadline=Date.now()+this.windowMs; }
    if(creds.registered!==true) {
      const generation=this.generation;
      this.windowTimer=setTimeout(()=>{if(generation===this.generation)this.fail()},Math.max(1,this.deadline-Date.now()));
      this.windowTimer.unref?.();
    }
  }
  observeQr(socket,qr) {
    if(socket!==this.socket) return;
    this.handshake=typeof qr==='string' && qr.length>0 && socket.ws?.isOpen===true;
    if(!this.attempted) this.phase=this.handshake ? 'ready' : 'unavailable';
  }
  ready() {
    return this.mode==='code' && this.handshake && !this.attempted && this.socket?.ws?.isOpen===true &&
      this.creds?.registered!==true && Date.now()<this.deadline;
  }
  selectMode(mode) {
    if(!['code','qr'].includes(mode) || this.attempted || this.creds?.registered===true) return false;
    this.mode=mode; return true;
  }
  request(phone) {
    if(!validPhone(phone) || !this.ready()) return false;
    // Claim synchronously, before Baileys mutates credentials and before any await.
    this.attempted=true; this.handshake=false; this.phase='pending';
    const socket=this.socket, generation=this.generation;
    const current=()=>socket===this.socket && generation===this.generation;
    this.requestTimer=setTimeout(()=>{if(current())this.fail()},this.requestTimeoutMs);
    this.requestTimer.unref?.();
    Promise.resolve().then(()=>{
      if(!current() || socket.ws?.isOpen!==true || this.creds.registered===true) throw Error('pairing_not_ready');
      return socket.requestPairingCode(phone);
    }).then(code=>{
      if(!current()) return;
      if(typeof code!=='string' || !/^[A-Z0-9]{8}$/.test(code)) { this.fail(); return; }
      clearTimeout(this.requestTimer); this.requestTimer=null;
      this.code=code; this.phase='shown'; this.expiresAt=Math.min(Date.now()+this.codeTtlMs,this.deadline);
      this.codeTimer=setTimeout(()=>{if(current())this.fail()},Math.max(1,this.expiresAt-Date.now()));
      this.codeTimer.unref?.();
    }).catch(()=>{if(current())this.fail()});
    return true;
  }
  fail() {
    this.stop('unknown'); this.onUncertain();
  }
  stop(phase='unavailable') {
    this.clearTimers(); this.generation++; this.socket=null; this.handshake=false;
    this.code=null; this.expiresAt=null; this.phase=phase;
  }
  publicState() {
    return {mode:this.mode,code_ready:this.ready(),code_state:this.phase,
      code_expires_at:this.expiresAt,can_switch:!this.attempted && this.creds?.registered!==true};
  }
  codeResult() {
    if(this.phase==='shown' && (Date.now()>=this.expiresAt || this.socket?.ws?.isOpen!==true || this.creds?.registered===true)) {
      this.code=null; this.expiresAt=null;
    }
    return {code:this.code,expires_at:this.expiresAt};
  }
}
