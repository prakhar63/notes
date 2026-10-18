// Sync between two devices: pairing and the connection. No DOM code here.
//
// The computer makes a pairing link (shown as a QR code) holding its PeerJS id and
// a one-time secret. The phone opens the link, and the two connect directly over
// WebRTC, which is encrypted. The public PeerJS server only introduces them: it
// sees the ids, never the secret (it's in the link's #hash) or any notes.
//
// PeerJS (vendor/peerjs.min.js) is loaded only when a sync starts.

const ID_PREFIX = 'pk-notes-';
const CONNECT_MS = 20000; // give up on a connection after this long
export const CODE_MS = 5 * 60 * 1000; // a pairing code works this long

// The two libraries are classic scripts that set a global; each loads once, on first use.
const loading = {};
function loadScript(src, global) {
  loading[src] ??= new Promise((resolve, reject) => {
    if (window[global]) { resolve(window[global]); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (window[global] ? resolve(window[global]) : reject(new SyncError('failed')));
    s.onerror = () => { delete loading[src]; reject(new SyncError('offline')); };
    document.head.append(s);
  });
  return loading[src];
}
const loadPeerJS = () => loadScript('./vendor/peerjs.min.js', 'Peer');

/** A QR code for `text` as an SVG path on a size×size grid (one unit per module). */
export async function qrCode(text) {
  const qrcode = await loadScript('./vendor/qrcode.js', 'qrcode');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
  }
  return { size, path };
}

/** A failure with a `reason`: 'offline', 'expired', 'timeout', 'refused', 'unsupported' or 'failed'. */
export class SyncError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function randomToken(length) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

function reasonFor(err) {
  const type = err?.type ?? err?.reason;
  if (type === 'peer-unavailable') return 'expired';
  if (['network', 'server-error', 'socket-error', 'socket-closed', 'offline'].includes(type)) return 'offline';
  if (type === 'browser-incompatible') return 'unsupported';
  return type && typeof type === 'string' && !type.includes(' ') ? type : 'failed';
}

/** Reads a pairing link's #hash ("#pair=<id>.<secret>"). Returns { id, secret } or null. */
export function parsePairHash(hash) {
  const m = /^#pair=([a-z0-9-]{8,64})\.([a-z0-9]{8,64})$/.exec(hash);
  return m ? { id: m[1], secret: m[2] } : null;
}

// Big messages go in pieces: a single WebRTC message can't be much over 64 KB everywhere.
const PART_SIZE = 16000;

// A connection both sides talk through, once the two have said hello.
// onProgress(type, received, total) reports a big message arriving piece by piece.
function channel(conn, peer, theirInfo) {
  const listeners = { message: new Set(), close: new Set(), progress: new Set() };
  const incoming = new Map(); // big message id → { type, parts, got }
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    listeners.close.forEach((fn) => fn());
    peer.destroy();
  };
  const deliver = (msg) => listeners.message.forEach((fn) => fn(msg));
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'part') { deliver(msg); return; }
    const big = incoming.get(msg.id) ?? { type: msg.of, parts: new Array(msg.n), got: 0 };
    incoming.set(msg.id, big);
    if (big.parts[msg.i] === undefined) { big.parts[msg.i] = msg.data; big.got += 1; }
    listeners.progress.forEach((fn) => fn(big.type, big.got, msg.n));
    if (big.got < msg.n) return;
    incoming.delete(msg.id);
    try { deliver(JSON.parse(big.parts.join(''))); } catch { /* damaged: ignore it */ }
  });
  conn.on('close', finish);
  conn.on('error', finish);
  peer.on('disconnected', () => { /* the introducer went away; the direct link still works */ });
  return {
    info: theirInfo,
    send(msg) {
      if (closed) return;
      const text = JSON.stringify(msg);
      if (text.length <= PART_SIZE) { conn.send(msg); return; }
      const id = randomToken(8);
      const n = Math.ceil(text.length / PART_SIZE);
      for (let i = 0; i < n; i++) {
        conn.send({ type: 'part', of: msg.type, id, i, n, data: text.slice(i * PART_SIZE, (i + 1) * PART_SIZE) });
      }
    },
    onMessage: (fn) => listeners.message.add(fn),
    onProgress: (fn) => listeners.progress.add(fn),
    onClose: (fn) => listeners.close.add(fn),
    close: () => { if (!closed) { conn.close(); finish(); } },
  };
}

/**
 * The computer's side: makes a pairing link and waits for one device to use it.
 * `info` (a value, or a function returning one) is sent to that device when it connects.
 * `onReady(link)` once the link works, `onPaired(channel)` when a device connects,
 * `onError(SyncError)` if the introducer can't be reached. Returns { stop }.
 */
export function host({ info, onReady, onPaired, onError }) {
  let peer = null;
  let stopped = false;
  let paired = false;
  const secret = randomToken(16);
  const id = ID_PREFIX + randomToken(20);

  loadPeerJS().then((Peer) => {
    if (stopped) return;
    peer = new Peer(id, { debug: 0 });
    peer.on('open', () => {
      if (stopped) return;
      const base = location.href.split('#')[0].split('?')[0];
      onReady(`${base}#pair=${id}.${secret}`);
    });
    peer.on('error', (err) => {
      if (!paired && !stopped) onError(new SyncError(reasonFor(err)));
    });
    peer.on('connection', (conn) => {
      if (paired || stopped) { conn.on('open', () => conn.close()); return; }
      conn.on('data', function hello(msg) {
        conn.off('data', hello);
        // Only the device that scanned this code knows the secret.
        if (paired || msg?.type !== 'hello' || msg.secret !== secret) { conn.close(); return; }
        paired = true;
        const ch = channel(conn, peer, msg.info ?? {});
        conn.send({ type: 'hello', info: typeof info === 'function' ? info() : info });
        onPaired(ch);
      });
    });
  }).catch((err) => { if (!stopped) onError(err instanceof SyncError ? err : new SyncError('failed')); });

  return {
    stop() {
      stopped = true;
      if (!paired) peer?.destroy();
    },
  };
}

/** The phone's side: connects to the computer from a pairing link. Resolves to a channel. */
export async function join({ id, secret }, info) {
  const Peer = await loadPeerJS();
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 0 });
    let done = false;
    const fail = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.destroy();
      reject(new SyncError(reason));
    };
    const timer = setTimeout(() => fail('timeout'), CONNECT_MS);
    peer.on('error', (err) => fail(reasonFor(err)));
    peer.on('open', () => {
      const conn = peer.connect(id, { reliable: true, serialization: 'json' });
      conn.on('open', () => conn.send({ type: 'hello', secret, info }));
      conn.on('data', function hello(msg) {
        conn.off('data', hello);
        if (msg?.type !== 'hello') { fail('refused'); return; }
        done = true;
        clearTimeout(timer);
        resolve(channel(conn, peer, msg.info ?? {}));
      });
      conn.on('close', () => fail('refused'));
      conn.on('error', () => fail('failed'));
    });
  });
}
