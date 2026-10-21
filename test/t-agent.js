import { AgentProcess } from '../src/agent.js';

const a = new AgentProcess(
  { name: 'coder', cli: 'codex', prompt: 'You are terse. Answer in one word.' },
  { cwd: process.cwd() }
);

const log = [];
a.on('ready', (id) => log.push(['ready', id]));
a.on('text', (t) => log.push(['text', t.trim()]));
a.on('tool', (t) => log.push(['tool', t.name]));
a.on('error', (e) => log.push(['error', e]));
a.on('stderr', (d) => log.push(['stderr', d.trim()]));
a.on('exit', (c) => log.push(['exit', String(c)]));

let turns = 0;
a.on('turn_end', (u) => {
  turns++;
  log.push(['turn_end', JSON.stringify(u.usage)]);
  if (turns === 1) {
    // second turn must resume the SAME thread and remember turn 1
    a.send('What number did I just ask you to remember? Reply with only that number.');
  } else {
    console.log(log.map((l) => l.join(' :: ')).join('\n'));
    const sessions = new Set(log.filter((l) => l[0] === 'ready').map((l) => l[1]));
    console.log('\ndistinct thread ids:', sessions.size, [...sessions]);
    console.log('MEMORY TEST:', log.some((l) => l[0] === 'text' && l[1].includes('77')) ? 'PASS' : 'FAIL');
    a.stop();
    process.exit(0);
  }
});

a.start();
a.send('Remember the number 77. Reply with only the word OK.');
setTimeout(() => { console.log('TIMEOUT\n' + log.map((l) => l.join(' :: ')).join('\n')); process.exit(1); }, 180000);
