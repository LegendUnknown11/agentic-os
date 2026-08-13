// Dictation. Two paths, and the server decides which one is live:
//
//   1. SpeechBird — the sovereign's own local Whisper, reached through
//      /api/transcribe. Accurate, free, never leaves the machine, and uses the
//      model already tuned in %APPDATA%\Dictate\settings.json. Record, stop,
//      transcribe.
//   2. The browser's own recogniser, if SpeechBird is not configured. Gives
//      live interim text, but Electron ships Chromium without a speech backend
//      so it is unavailable in the desktop app — hence path 1 being primary.
//
// Either way, F9 (or whatever SpeechBird's hotkey is) still works everywhere,
// because that pastes into the focused field with no help from us.
//
// ponytail: no wake word, no VAD, no punctuation model. Press, talk, press.
const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let serverStt = null;          // null = not asked yet
let browserSttWorks = Boolean(SR);
let notify = () => {};

export const onNotice = (fn) => { notify = fn; };

async function haveServer() {
  if (serverStt === null) {
    serverStt = await fetch('/api/transcribe')
      .then((r) => r.json()).then((j) => Boolean(j.available)).catch(() => false);
  }
  return serverStt;
}

/** Wire a mic button to a text input. Click to start, click again to stop. */
export function attachMic(button, input) {
  let stop = null;
  button.onclick = async () => {
    if (stop) { stop(); return; }
    button.classList.add('on');
    const done = () => { stop = null; button.classList.remove('on'); input.focus(); };
    try {
      if (await haveServer()) stop = await recordAndPost(input, done, button);
      else if (browserSttWorks) stop = liveDictate(input, done);
      else throw new Error('No dictation available. Point "speechbird" in kingdom.config.json '
        + 'at SpeechBird, or use its own hotkey to dictate into the field.');
    } catch (e) {
      done();
      notify(e.message, true);
    }
  };
}

/* ---------- 1. record, transcribe with SpeechBird ---------- */
async function recordAndPost(input, done, button) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    button.classList.add('thinking');   // recording is over; Whisper is working
    const blob = new Blob(chunks, { type: rec.mimeType });
    try {
      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? 'transcription failed');
      if (j.text) input.value = (input.value ? input.value.trim() + ' ' : '') + j.text;
      else notify('Nothing heard.');
    } catch (e) {
      notify(e.message, true);
    }
    button.classList.remove('thinking');
    done();
  };
  rec.start();
  return () => rec.stop();
}

/* ---------- 2. browser recogniser ---------- */
function liveDictate(input, done) {
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  const base = input.value ? input.value.trim() + ' ' : '';
  let settled = '';

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) settled += t + ' '; else interim += t;
    }
    input.value = base + settled + interim;
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed') return notify('Microphone blocked — allow it and try again.', true);
    // network / service-not-allowed: this Chromium has no speech backend.
    browserSttWorks = false;
    notify('This browser cannot transcribe. Point "speechbird" in kingdom.config.json at SpeechBird.', true);
  };
  rec.onend = done;
  rec.start();
  return () => rec.stop();
}
