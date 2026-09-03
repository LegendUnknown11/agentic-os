import { h, page, section, empty, note, button, field, input, textarea, select, check, modeDef, post, subscribe, editing } from './util.js';
import { setPrefs } from '../store.js';

let Assets, Notify, soundOn, setSound, cue;
let dependencies;
let dependencyError;
const loadDependencies = () => dependencies ??= Promise.all([
  import('../assets.js'), import('../notify.js'), import('../feel.js'),
]).then(([assets, notify, feel]) => {
  Assets = assets; Notify = notify; ({ soundOn, setSound, cue } = feel);
}).catch((error) => {
  dependencies = null;
  dependencyError = error;
  throw error;
});

const TABS = [
  ['repo', 'Repository'], ['summary', 'Summaries'], ['advisor', 'Advisor'], ['wallpaper', 'Wallpaper'],
  ['music', 'Music'], ['documents', 'Documents'], ['notifications', 'Notifications'], ['sounds', 'Sounds'], ['pet', 'Desk pet'],
];
const models = (state) => Object.entries(state.models ?? {}).flatMap(([cli, list]) => (list ?? []).map((model) => [`${cli}:${model}`, `${cli} · ${model}`]));
const fileList = (kind) => Assets.list().filter((asset) => asset.kind === kind);
const assetMessage = (state, kind) => {
  const value = state.assetNotices?.[kind];
  const feedback = note(value?.text ?? '', value?.failed ? 'danger' : 'success');
  feedback.hidden = !value?.text;
  return feedback;
};
const showAssetMessage = (state, kind, feedback, text, failed = false) => {
  const value = { text, failed };
  state.assetNotices = { ...state.assetNotices, [kind]: value };
  feedback.className = `note ${failed ? 'danger' : 'success'}`;
  feedback.textContent = text;
  feedback.hidden = false;
};
async function uploadAssets(state, root, kind, accept, control, feedback, after) {
  if (state.assetUploads?.[kind]) return;
  state.assetUploads = { ...state.assetUploads, [kind]: true };
  control.disabled = true;
  let files;
  try { files = await Assets.pick(accept); }
  catch {
    state.assetUploads = { ...state.assetUploads, [kind]: false };
    control.disabled = false;
    showAssetMessage(state, kind, feedback, 'Could not open the file picker.', true);
    return;
  }
  if (!files.length) {
    state.assetUploads = { ...state.assetUploads, [kind]: false };
    control.disabled = false;
    return;
  }
  state.assetNotices = { ...state.assetNotices, [kind]: null };
  const failures = [];
  let uploaded = 0;
  for (const file of files) {
    let result;
    try { result = await Assets.upload(file); }
    catch { result = { ok: false, error: 'upload failed' }; }
    if (result?.ok === false) failures.push(`${file.name}: ${result.error ?? 'upload failed'}`);
    else uploaded++;
  }
  after?.();
  const text = failures.length
    ? `${uploaded ? `${uploaded} uploaded. ` : ''}${failures.join(' ')}`
    : `${uploaded} file${uploaded === 1 ? '' : 's'} uploaded.`;
  const value = { text, failed: failures.length > 0 };
  showAssetMessage(state, kind, feedback, text, value.failed);
  state.assetUploads = { ...state.assetUploads, [kind]: false };
  control.disabled = false;
  if (!feedback.isConnected && root.isConnected) renderSettings(state, root);
}
async function removeAsset(state, root, kind, name, control, feedback) {
  if (control.dataset.armed !== '1') {
    control.dataset.armed = '1';
    control.textContent = 'Confirm delete';
    return;
  }
  control.disabled = true;
  const result = await Assets.remove(name);
  if (result?.ok === false) {
    delete control.dataset.armed;
    control.textContent = 'Delete';
    control.disabled = false;
    showAssetMessage(state, kind, feedback, `${name}: ${result.error ?? 'delete failed'}`, true);
    return;
  }
  showAssetMessage(state, kind, feedback, `${name} deleted.`);
  if (root.isConnected) renderSettings(state, root);
}
function settingWrite(feedback, control, action, payload, restore) {
  return async () => {
    feedback.hidden = true;
    control.disabled = true;
    const result = await post(action, payload());
    control.disabled = false;
    if (result?.ok === false) {
      restore?.();
      feedback.className = 'note danger';
      feedback.textContent = result.error ?? 'Could not save that setting.';
      feedback.hidden = false;
    } else {
      feedback.className = 'note success';
      feedback.textContent = 'Saved.';
      feedback.hidden = false;
    }
  };
}

function rangeField(label, control, format = (value) => value) {
  const wrapper = field(label, control);
  const labelNode = wrapper.querySelector('.field-label');
  const output = h('output', { class: 'field-value', text: format(control.value) });
  labelNode?.append(output);
  control.addEventListener('input', () => { output.textContent = format(control.value); });
  return wrapper;
}

function repository(state) {
  const path = input(state.repo ?? '', 'C:\\path\\to\\repo');
  const pickerMessage = note('', 'danger');
  pickerMessage.hidden = true;
  const attach = button('Attach repository', async () => {
    const value = path.value.trim();
    pickerMessage.hidden = true;
    if (!value) {
      pickerMessage.textContent = 'Choose a repository first.';
      pickerMessage.hidden = false;
      return;
    }
    attach.disabled = true;
    const result = await post('attachRepo', { path: value });
    if (result?.ok === false) {
      attach.disabled = false;
      pickerMessage.textContent = result.error ?? 'Could not attach that repository.';
      pickerMessage.hidden = false;
    } else {
      attach.disabled = false;
      pickerMessage.className = 'note success';
      pickerMessage.textContent = `Attached: ${result.repo ?? value}`;
      pickerMessage.hidden = false;
    }
  }, 'primary');
  const choose = window.kingdomShell?.chooseRepo ? button('Choose folder…', async () => {
    try {
      const picked = await window.kingdomShell.chooseRepo();
      if (picked?.path) { path.value = picked.path; attach.click(); }
      else if (picked?.error) { pickerMessage.textContent = picked.error; pickerMessage.hidden = false; }
    } catch (error) {
      pickerMessage.textContent = error?.message ?? 'Could not open the repository picker.';
      pickerMessage.hidden = false;
    }
  }) : null;
  return section('Repository', note(state.repo ? `Attached: ${state.repo}` : 'No repository attached. Chat and Cowork can run without one.'), field('Path', path, 'Code mode requires an existing git repository with at least one commit.'), h('div', { class: 'button-row' }, choose, attach), pickerMessage);
}

function summarizer(state) {
  const current = state.summarizer ?? {};
  const feedback = note('', 'danger');
  feedback.hidden = true;
  const write = (control, payload, restore) => settingWrite(feedback, control, 'summarizer', payload, restore);
  const enabled = check(current.enabled !== false);
  enabled.addEventListener('change', write(enabled, () => ({ enabled: enabled.checked }), () => { enabled.checked = current.enabled !== false; }));
  const currentModel = current.model ? `${current.cli}:${current.model}` : '';
  const model = select(models(state), currentModel);
  model.addEventListener('change', write(model, () => { const [cli, ...rest] = model.value.split(':'); return { cli, model: rest.join(':') }; }, () => { model.value = currentModel; }));
  const effort = select(['', ...(state.efforts?.byModel?.[current.model] ?? state.efforts?.[current.cli] ?? [])], current.effort ?? '');
  effort.addEventListener('change', write(effort, () => ({ effort: effort.value }), () => { effort.value = current.effort ?? ''; }));
  const words = input(current.maxWords ?? 16); words.type = 'number'; words.min = 6; words.max = 40;
  words.addEventListener('change', write(words, () => ({ maxWords: Number(words.value) }), () => { words.value = current.maxWords ?? 16; }));
  const style = textarea(current.style ?? '', 'Plain past tense. Lead with the verb.');
  style.addEventListener('blur', write(style, () => ({ style: style.value.trim() }), () => { style.value = current.style ?? ''; }));
  return section('Summaries', field('Summarise every turn', enabled, 'One short line instead of a wall of text.'), field('Runs on', model), field('Effort', effort), field('Maximum words', words), field('Style', style), feedback);
}

function advisor(state) {
  const current = state.advisor ?? {};
  const feedback = note('', 'danger');
  feedback.hidden = true;
  const write = (control, payload, restore) => settingWrite(feedback, control, 'advisor', payload, restore);
  const prompt = check(current.promptEngineer !== false);
  prompt.addEventListener('change', write(prompt, () => ({ promptEngineer: prompt.checked }), () => { prompt.checked = current.promptEngineer !== false; }));
  const auto = check(current.autoModel !== false);
  auto.addEventListener('change', write(auto, () => ({ autoModel: auto.checked }), () => { auto.checked = current.autoModel !== false; }));
  const currentModel = `${current.cli ?? ''}:${current.model ?? ''}`;
  const model = select(models(state), currentModel);
  model.addEventListener('change', write(model, () => { const [cli, ...rest] = model.value.split(':'); return { cli, model: rest.join(':') }; }, () => { model.value = currentModel; }));
  const effort = select(['', ...(state.efforts?.byModel?.[current.model] ?? state.efforts?.[current.cli] ?? [])], current.effort ?? '');
  effort.addEventListener('change', write(effort, () => ({ effort: effort.value }), () => { effort.value = current.effort ?? ''; }));
  return section('Advisor', field('Prompt engineer', prompt, 'Rewrites your instruction before the orchestrator reads it.'), field('Automatic model selector', auto), field('Runs on', model), field('Effort', effort), note('The advisor may choose different models per task when automatic selection is on.'), feedback);
}

function wallpaper(state, root) {
  const current = Assets.background();
  const feedback = assetMessage(state, 'image');
  const upload = button('Upload image', () => uploadAssets(state, root, 'image', 'image/*', upload, feedback));
  upload.disabled = Boolean(state.assetUploads?.image);
  const reset = button('No wallpaper', () => Assets.resetBackground());
  const grid = h('div', { class: 'asset-grid' }, button('None', reset, `asset-tile ${current.image ? '' : 'selected'}`));
  fileList('image').forEach((asset) => grid.append(h('button', { class: `asset-tile ${current.image === asset.name ? 'selected' : ''}`, type: 'button', style: { backgroundImage: `url("${Assets.src(asset.name)}")` }, on: { click: () => Assets.useWallpaper(asset.name) } }, h('span', { text: asset.name }))));
  const dim = input(current.dim ?? 55); dim.type = 'range'; dim.min = 0; dim.max = 90; dim.addEventListener('input', () => Assets.setBackground({ dim: Number(dim.value) }));
  const blur = input(current.blur ?? 0); blur.type = 'range'; blur.min = 0; blur.max = 24; blur.addEventListener('input', () => Assets.setBackground({ blur: Number(blur.value) }));
  return section('Wallpaper', h('div', { class: 'button-row' }, upload, reset), feedback, grid, rangeField('Dim', dim, (value) => `${value}%`), rangeField('Blur', blur, (value) => `${value}px`));
}

function music(state, root) {
  const tracks = fileList('audio').map((asset) => asset.name);
  const current = Assets.state();
  const feedback = assetMessage(state, 'audio');
  const upload = button('Upload music', () => uploadAssets(state, root, 'audio', 'audio/*', upload, feedback, () => Assets.setQueue(fileList('audio').map((asset) => asset.name))));
  upload.disabled = Boolean(state.assetUploads?.audio);
  const transport = h('div', { class: 'button-row' }, button(current.playing ? 'Pause' : 'Play', () => Assets.toggle(), 'primary'), button('Previous', () => Assets.next(-1)), button('Next', () => Assets.next(1)), button(current.loop ? 'Loop on' : 'Loop off', () => Assets.setPlayer({ loop: !current.loop })), button(current.shuffle ? 'Shuffle on' : 'Shuffle off', () => Assets.setPlayer({ shuffle: !current.shuffle })));
  const volume = input(Math.round((current.volume ?? 0.35) * 100));
  volume.type = 'range'; volume.min = 0; volume.max = 100;
  volume.addEventListener('input', () => Assets.setPlayer({ volume: Number(volume.value) / 100 }));
  const list = tracks.length ? tracks.map((name) => {
    const control = button('Delete', () => removeAsset(state, root, 'audio', name, control, feedback));
    return h('div', { class: 'list-row' }, button(name, () => Assets.play(name), 'link'), control);
  }) : [empty('Upload an audio file to start a queue.')];
  return section('Music', upload, feedback, h('div', { class: 'now-playing', text: current.name ? `${current.name} · ${Assets.fmt(current.time)} / ${Assets.fmt(current.duration)}` : 'Nothing playing' }), transport, rangeField('Volume', volume, (value) => `${value}%`), ...list);
}

function documents(state, root) {
  const feedback = assetMessage(state, 'document');
  const upload = button('Upload document', () => uploadAssets(state, root, 'document', '.pdf,.txt,.md,.csv,.json', upload, feedback));
  upload.disabled = Boolean(state.assetUploads?.document);
  const docs = fileList('document');
  const list = docs.length ? docs.map((asset) => {
    const control = button('Delete', () => removeAsset(state, root, 'document', asset.name, control, feedback));
    return h('div', { class: 'list-row' }, h('span', { text: asset.name }), control);
  }) : [empty('No documents uploaded.')];
  return section('Documents', upload, feedback, note('Documents are source material the team can reference during work.'), ...list);
}

function notifications(state, root) {
  const settings = Notify.settings();
  const request = settings.permission === 'granted' ? null : button(
    settings.permission === 'denied' ? 'Blocked in browser settings' : settings.permission === 'unsupported' ? 'Not supported here' : 'Allow desktop notifications',
    async () => {
      if (settings.permission !== 'default') return;
      request.disabled = true;
      await Notify.request();
      if (root.isConnected) renderSettings(state, root);
    }, 'primary');
  if (request && settings.permission !== 'default') request.disabled = true;
  const row = (key, label, hint) => { const c = check(settings[key]); c.disabled = settings.permission !== 'granted'; c.addEventListener('change', () => Notify.setPref({ [key]: c.checked })); return field(label, c, hint); };
  const status = settings.permission === 'unsupported' ? 'Desktop notifications are unavailable in this window.' : settings.permission === 'denied' ? 'Allow notifications in browser settings, then return here.' : 'Nothing is sent while this window is focused.';
  return section('Notifications', request, row('approvals', 'Waiting on you', 'A request the team cannot continue without.'), row('failures', 'Something broke', 'A member failed, a merge was refused, or an account hit its limit.'), row('budget', 'Spend ceiling', 'A member or the team stopped for money.'), row('done', 'Work merged', 'Off by default.'), note(status));
}

function sounds() {
  const enabled = check(soundOn());
  enabled.addEventListener('change', () => { setSound(enabled.checked); if (enabled.checked) cue('approve'); });
  return section('Sounds', field('Decision and team cues', enabled, 'Short synthesized cues after your clicks.'));
}

function pet(state) {
  const enabled = check(state.prefs.pet !== false);
  enabled.addEventListener('change', () => setPrefs({ pet: enabled.checked }));
  return section('Desk pet', field('Show the desk pet', enabled), button('Open desk pet', () => window.kingdomShell?.openPet ? window.kingdomShell.openPet() : window.open('/pet.html', 'kingdom-pet')), note('Close the pet window with its own shoo button.'));
}

const BUILDERS = { repo: repository, summary: summarizer, advisor, wallpaper, music, documents, notifications, sounds, pet };

export function renderSettings(state, root) {
  if (dependencyError) {
    root.replaceChildren(page('Settings', 'Settings could not load. Reload this window to try again.'),
      h('div', { class: 'button-row' }, note('The settings modules did not load.', 'danger'), button('Retry', () => location.reload(), 'primary')));
    return;
  }
  if (!Assets || !Notify || !soundOn) {
    root.replaceChildren(page('Settings', 'Loading settings…'));
    loadDependencies().then(() => { if (root.isConnected) renderSettings(state, root); }).catch(() => {
      if (root.isConnected) renderSettings(state, root);
    });
    return;
  }
  root.replaceChildren();
  const active = state.settingsSection ?? 'repo';
  const shell = page('Settings', 'Repository, model behaviour, assets, notifications, and the desk pet.');
  const nav = h('nav', { class: 'settings-tabs', 'aria-label': 'Settings sections' });
  for (const [key, label] of TABS) {
    const tab = button(label, () => { state.settingsSection = key; renderSettings(state, root); }, key === active ? 'selected' : '');
    if (key === active) tab.setAttribute('aria-current', 'page');
    nav.append(tab);
  }
  shell.append(nav, BUILDERS[active]?.(state, root) ?? empty('Unknown settings section.'));
  root.append(shell);
}

export function mountSettings(state, root) {
  let active = true;
  let frame = 0;
  let offStore = () => {};
  let offAssets = () => {};
  let offMusic = () => {};
  const redraw = () => {
    if (!active || frame || editing(root)) return;
    const paint = () => {
      frame = 0;
      if (active && !editing(root) && root.isConnected) renderSettings(state, root);
    };
    frame = globalThis.requestAnimationFrame ? requestAnimationFrame(paint) : (queueMicrotask(paint), 1);
  };
  const start = async () => {
    if (!Assets || !Notify || !soundOn) renderSettings(state, root);
    try { await loadDependencies(); }
    catch {
      if (active && root.isConnected !== false) renderSettings(state, root);
      return;
    }
    await Assets.refresh();
    if (!active || root.isConnected === false) return;
    offStore = subscribe(() => redraw());
    offAssets = Assets.onAssets(redraw);
    offMusic = Assets.onMusic(redraw);
    renderSettings(state, root);
  };
  void start();
  return () => {
    active = false;
    offStore?.();
    offAssets?.();
    offMusic?.();
    if (frame && globalThis.cancelAnimationFrame) cancelAnimationFrame(frame);
  };
}
export const render = renderSettings;
export const mount = mountSettings;
