// Remote control: steer a run from a phone, from anywhere, over Tailscale.
//
// The loopback server in daemon.js is left exactly as it is. Turning remote
// control on starts a SECOND http.Server on one chosen interface (the
// machine's Tailscale address by default) and turning it off closes it. Every
// request that arrives on that second server is remote by construction —
// whatever its source IP — so the classification never depends on an address
// check that a tunnel or a NAT could make lie.
//
// The token is minted on every "on", held only in this process's memory, and
// never written to disk or printed: a restart, an "off", or the next "on" all
// kill it. Turning the switch off and on again IS the revoke.
//
// What a valid token reaches is the Steer surface below and nothing else.
// Agents run unconfined (src/agent.js), so a route left off this list is not
// a missing feature, it is a door that stays shut: no /api/command, repo,
// config, uploads, tokens, workflows or the full UI bundle.

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// JSON reads a bearer-authenticated remote request may make.
export const STEER_READS = new Set(['/api/ping', '/api/approvals', '/api/remote/state']);
// POST /api/<name> actions it may take. Both spellings of the run actions,
// because daemon.js registers both (`run/pause` and `runPause`).
export const STEER_ACTIONS = new Set([
  'approve', 'reject', 'answerQuestion',
  'run/pause', 'run/resume', 'runPause', 'runResume',
  'remote/message',
]);
// The phone page itself. Static, public, carries no state — it has to load
// before its script can read the token out of the URL fragment, so these are
// the only paths served without one.
const PAGE_FILES = new Set(['/remote', '/remote.html', '/remote.js', '/app.css']);
const isPageFile = (path) => PAGE_FILES.has(path) || /^\/fonts\/[\w-][\w.-]*$/.test(path);

// Tailscale hands out addresses from the CGNAT block, 100.64.0.0/10.
export function isTailscale(address) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(address ?? '');
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** Every IPv4 address on this machine, Tailscale's first. */
export function interfaces(ifaces = networkInterfaces()) {
  const list = [];
  for (const [name, addrs] of Object.entries(ifaces ?? {})) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      list.push({ name, address: a.address, internal: Boolean(a.internal), tailscale: isTailscale(a.address) });
    }
  }
  return list.sort((x, y) => Number(y.tailscale) - Number(x.tailscale) || Number(x.internal) - Number(y.internal));
}

export const tailscaleAddress = (ifaces) => interfaces(ifaces).find((i) => i.tailscale)?.address ?? null;

/**
 * Decide one request that arrived on the remote listener.
 * Returns 'page' (a static file of the phone page — no token needed),
 * 'authorized' (valid token and a Steer route), or {status, error}.
 */
export function steerGate(method, path, authorized) {
  if (method === 'GET' && isPageFile(path)) return 'page';
  if (!authorized) return { status: 401, error: 'missing or invalid bearer token' };
  const read = method === 'GET' && STEER_READS.has(path);
  const action = method === 'POST' && path.startsWith('/api/') && STEER_ACTIONS.has(path.slice(5));
  return read || action ? 'authorized' : { status: 403, error: 'this route is not available for remote control' };
}

export class RemoteControl {
  #server = null;
  #token = null;
  #requests = new WeakSet();
  #bind = null;
  #port = null;

  /** handle(req, res) is the daemon's own request handler. */
  constructor(handle) {
    this.handle = handle;
  }

  get on() { return this.#server !== null; }

  /** True when this request arrived on the remote listener. */
  owns(req) { return this.#requests.has(req); }

  authorized(req) {
    if (!this.#token) return false;
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !value) return false;
    const presented = Buffer.from(value);
    const expected = Buffer.from(this.#token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  /** What Settings shows. Never the token. */
  status(ifaces) {
    return {
      on: this.on, bind: this.#bind, port: this.#port,
      tailscale: tailscaleAddress(ifaces), interfaces: interfaces(ifaces),
    };
  }

  /**
   * Start (or restart) the listener and mint a fresh token. Restarting kills
   * the previous token even when the address is unchanged. The url — the one
   * place the token is ever handed out — carries it in the fragment, which a
   * browser never sends to a server, so it cannot land in any request log.
   */
  async start({ bind = null, port, ifaces } = {}) {
    const address = bind || tailscaleAddress(ifaces);
    if (!address) {
      throw Object.assign(new Error('Tailscale was not found on this machine. Install and sign in to Tailscale, or choose an address.'), { status: 409, reason: 'no-tailscale' });
    }
    if (!interfaces(ifaces).some((i) => i.address === address)) {
      throw Object.assign(new Error(`${address} is not an address of this machine.`), { status: 400, reason: 'unknown-address' });
    }
    const wanted = Number(port);
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
      throw Object.assign(new Error('Port must be a whole number from 0 to 65535.'), { status: 400 });
    }
    await this.stop();
    const server = createServer((req, res) => {
      this.#requests.add(req);
      return this.handle(req, res);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(wanted, address, () => { server.off('error', reject); resolve(); });
    });
    this.#server = server;
    this.#token = randomBytes(32).toString('hex');
    this.#bind = address;
    this.#port = server.address().port;
    return { ...this.status(ifaces), url: `http://${address}:${this.#port}/remote#t=${this.#token}` };
  }

  /** Close the listener, drop every open connection, forget the token. */
  async stop() {
    const server = this.#server;
    this.#server = null;
    this.#token = null;
    this.#bind = null;
    this.#port = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
