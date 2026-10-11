import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../../',import.meta.url));
const child=spawn(require('electron'),[fileURLToPath(new URL('../main/main.mjs',import.meta.url)),...process.argv.slice(2)],{cwd:root,stdio:'inherit',windowsHide:false});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code ?? 1;});
