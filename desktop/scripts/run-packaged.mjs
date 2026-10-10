import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const child = spawn(join(root, 'desktop', 'release', 'v0.3.4', 'TerrainWorkshop-win32-x64', 'TerrainWorkshop.exe'), process.argv.slice(2),
  { cwd: root, stdio: 'inherit', windowsHide: false });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
