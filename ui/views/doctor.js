import { h, page, section, empty, note, button, get, subscribe, editing, tone } from './util.js';
import { statusDot } from '../avatar.js';

const apiError = (result, fallback) => result?.ok === false ? result.error ?? fallback : null;
const requestToken = (state) => { state.doctorRequest = (state.doctorRequest ?? 0) + 1; return state.doctorRequest; };
function bind(state, root, render) {
  const off = subscribe(() => { if (!editing(root)) render(state, root); });
  return () => off?.();
}

export function renderDoctor(state, root) {
  root.replaceChildren();
  const shell = page('Doctor', 'Checks for the command-line tools and repository readiness.');
  const checks = state.doctor?.checks ?? [];
  const loadFailure = apiError(state.doctor, 'Could not run Doctor.');
  const body = section('Readiness');
  if (state.doctorLoading) body.append(empty('Checking the local service…'));
  else {
    if (loadFailure) body.append(note(loadFailure, 'danger'));
    else if (!checks.length) body.append(empty('No checks returned.'));
    else checks.forEach((item) => {
      const dot = statusDot();
      const dotTone = tone(item.level);
      if (dotTone) dot.classList.add(dotTone);
      body.append(h('div', { class: `doctor-row ${item.level} ${tone(item.level)}`.trim() }, dot,
        h('span', { text: `${item.level === 'ok' ? '✓' : item.level === 'warn' ? '!' : '×'} ${item.message}` })));
    });
    if (state.doctor) body.append(note(state.doctor.ready ? 'Ready.' : 'Fix the failed checks, then run Doctor again.'));
  }
  const run = button(state.doctorLoading ? 'Checking…' : 'Run checks', async () => {
    const token = requestToken(state);
    state.doctorLoading = true;
    renderDoctor(state, root);
    const result = await get('/api/doctor');
    if (root.isConnected === false || state.doctorRequest !== token) {
      if (state.doctorRequest === token) state.doctorLoading = false;
      return;
    }
    state.doctorLoading = false;
    state.doctor = result;
    renderDoctor(state, root);
  }, 'primary');
  run.disabled = Boolean(state.doctorLoading);
  shell.append(body, h('div', { class: 'button-row' }, run));
  root.append(shell);
}

export function mountDoctor(state, root) {
  const token = requestToken(state);
  state.doctorLoading = true;
  renderDoctor(state, root);
  const off = bind(state, root, renderDoctor);
  void get('/api/doctor').then((result) => {
    if (root.isConnected === false || state.doctorRequest !== token) {
      if (state.doctorRequest === token) state.doctorLoading = false;
      return;
    }
    state.doctorLoading = false;
    state.doctor = result;
    renderDoctor(state, root);
  });
  return () => { requestToken(state); off?.(); };
}
export const render = renderDoctor;
export const mount = mountDoctor;
