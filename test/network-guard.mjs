import net from 'node:net';

// Offline suites may use loopback HTTP/IPC, never provider connections.
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args) {
  const normalized=Array.isArray(args[0]) ? args[0] : args;
  const first=normalized[0];
  const host=typeof first==='object' ? first.host : normalized[1];
  if(!['127.0.0.1','localhost','::1'].includes(host)) throw Error('external_network_forbidden_in_offline_tests');
  return connect.apply(this,args);
};
