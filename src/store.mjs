import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { mkdir, chmod, lstat, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const owners = new Map();
const defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../.runtime/whatsapp-auth');

export class Store {
  constructor(directory, capacity) {
    Object.assign(this,{directory,capacity,active:true}); this.claims=new Map();
    this.closing=false; this.authTail=Promise.resolve(); this.closePromise=null;
  }
  static async open({directory=defaultDirectory,capacity=2048}={}) {
    directory=resolve(directory);
    if (!Number.isInteger(capacity)||capacity<1||capacity>8192) throw Error('invalid_claim_capacity');
    if (owners.has(directory)) throw Error('single_owner_already_active');
    const store=new Store(directory,capacity);
    owners.set(directory,store);
    try {
      await mkdir(directory,{recursive:true,mode:0o700});
      if (!(await lstat(directory)).isDirectory()||(await lstat(directory)).isSymbolicLink()) throw Error('private_auth_directory_required');
      await chmod(directory,0o700); await store.restrictFiles();
      const {state,saveCreds}=await useMultiFileAuthState(directory);
      const get=state.keys.get.bind(state.keys),set=state.keys.set.bind(state.keys);
      state.keys.get=(type,ids)=>store.authOperation(()=>get(type,ids));
      state.keys.set=values=>store.authOperation(()=>set(values));
      store.auth=state;
      store.saveCreds=()=>store.authOperation(saveCreds);
      return store;
    } catch {
      store.active=false;
      if(owners.get(directory)===store)owners.delete(directory);
      throw Error('private_auth_unavailable');
    }
  }
  assertOwner(allowClosing=false) {
    if(!this.active||owners.get(this.directory)!==this||(!allowClosing&&this.closing))throw Error('ownership_lost');
  }
  authOperation(operation) {
    try {this.assertOwner()}catch(error){return Promise.reject(error)}
    const accepted=this.authTail.then(async()=>{
      this.assertOwner(true);
      const result=await operation();
      await this.restrictFiles();
      return result;
    });
    this.authTail=accepted.then(()=>{},()=>{
      this.active=false;
      try {this.onLost?.()}catch{}
    });
    return accepted;
  }
  async restrictFiles() {
    this.assertOwner(true);
    for (const name of await readdir(this.directory)) {
      const path=resolve(this.directory,name), info=await lstat(path);
      if (!info.isFile()||info.isSymbolicLink()||!name.endsWith('.json')) throw Error('invalid_auth_file');
      await chmod(path,0o600);
    }
  }
  async alive() {this.assertOwner();}
  async claim(key,digest=key) {
    this.assertOwner();
    if(typeof key!=='string'||key.length<1||key.length>256||typeof digest!=='string'||digest.length>256)throw Error('invalid_claim');
    if(this.claims.has(key))return false;
    if(this.claims.size>=this.capacity)throw Error('effect_capacity_reached');
    this.claims.set(key,{digest,status:'uncertain'});return true;
  }
  async known(key) {this.assertOwner();return this.claims.has(key);}
  async done(key) {this.assertOwner();const value=this.claims.get(key);if(!value)throw Error('unknown_claim');value.status='done';}
  close() {
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=this.authTail.then(()=>{
      this.active=false;this.claims.clear();
      if(owners.get(this.directory)===this)owners.delete(this.directory);
    });
    return this.closePromise;
  }
}
