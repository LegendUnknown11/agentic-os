// Dictation, borrowed from SpeechBird.
//
// SpeechBird already has faster-whisper, `av` (so it decodes the browser's
// webm/opus with no ffmpeg), and a model the user has downloaded and
// tuned. Rather than ship a second Whisper or pay a cloud API, we run one warm
// worker inside its virtualenv — see stt_worker.py.
//
// ponytail: requests are serialised. Dictation is one person pressing one
// button; a queue would be machinery for a case that cannot happen.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'stt_worker.py');
// The very first clip after install also pays for the model DOWNLOAD, which
// took 140s here on small.en. Later clips only wait for a load, then nothing.
const LOAD_MS = 300_000;
const CLIP_MS = 120_000;

export class Speech {
  /** @param {string|null} dir  SpeechBird's folder (the one holding .venv) */
  constructor(dir) {
    this.dir = dir || null;
    this.proc = null;
    this.pending = null;   // {resolve, reject, timer}
    this.buf = '';
    this.model = null;
  }

  /** The venv interpreter, or null if SpeechBird is not where we were told. */
  python() {
    if (!this.dir) return null;
    for (const rel of [['.venv', 'Scripts', 'python.exe'], ['.venv', 'bin', 'python']]) {
      const p = join(this.dir, ...rel);
      if (existsSync(p)) return p;
    }
    return null;
  }

  available() {
    return Boolean(this.python()) && existsSync(WORKER);
  }

  #start() {
    const py = this.python();
    if (!py) throw new Error('SpeechBird not found — set "speechbird" in agenticos.config.json.');

    const proc = spawn(py, [WORKER], {
      cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.#onData(d));
    // Whisper chatters on stderr; only surface it if the worker then dies.
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-800); });
    // Guard on identity: a worker we already replaced must not settle the
    // request belonging to its successor. Killing one and immediately
    // dictating again did exactly that.
    const mine = () => this.proc === proc;
    proc.on('exit', () => {
      if (!mine()) return;
      this.proc = null;
      this.#settle({ error: `dictation worker exited. ${err.trim()}` });
    });
    proc.on('error', (e) => {
      if (!mine()) return;
      this.proc = null;
      this.#settle({ error: e.message });
    });
    return proc;
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.ready) { this.model = o.model ?? null; continue; }   // not a reply to anything
      this.#settle(o);
    }
  }

  #settle(o) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    // The decoder quotes the temp file it failed on; nobody wants to read that.
    if (o.error) p.reject(new Error(String(o.error).replace(/'[^']*agenticos-stt-[^']*'/g, 'the recording')));
    else p.resolve(o.text ?? '');
  }

  /**
   * @param {Buffer} audio  whatever MediaRecorder produced
   * @param {string} ext    container extension, e.g. 'webm'
   */
  async transcribe(audio, ext = 'webm') {
    if (this.pending) throw new Error('already transcribing a clip');
    // A worker that died (model swap, OOM, machine asleep) restarts here.
    const fresh = !this.proc;
    if (fresh) this.#start();

    const dir = mkdtempSync(join(tmpdir(), 'agenticos-stt-'));
    const file = join(dir, `clip.${ext.replace(/[^a-z0-9]/gi, '') || 'webm'}`);
    writeFileSync(file, audio);

    try {
      return await new Promise((resolve, reject) => {
        this.pending = {
          resolve, reject,
          timer: setTimeout(() => {
            this.pending = null;
            reject(new Error(fresh
              ? 'Dictation timed out loading the model. The first run downloads it — try again.'
              : 'Dictation timed out.'));
          }, fresh ? LOAD_MS : CLIP_MS),
        };
        this.proc.stdin.write(JSON.stringify({ path: file }) + '\n');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}
