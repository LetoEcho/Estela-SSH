// ng serve + esbuild --watch + Electron pointed at the dev server. Restart Electron by hand after main changes.
import { spawn } from 'node:child_process';

const URL = 'http://localhost:4200';
const run = (cmd, args, env = {}) =>
  spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });

const children = [run('npx', ['ng', 'serve', '--port', '4200']), run('node', ['esbuild.mjs', '--watch'])];
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);

for (;;) {
  try {
    if ((await fetch(URL)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const electron = run('npx', ['electron', '.'], { ESTELA_DEV_URL: URL });
children.push(electron);
electron.on('exit', stop);
