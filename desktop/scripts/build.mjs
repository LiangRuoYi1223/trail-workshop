import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const [entry,args] of [
  ['node_modules/typescript/bin/tsc',['-p','tsconfig.json']],
  ['node_modules/typescript/bin/tsc',['-p','desktop/tsconfig.json']],
  ['node_modules/vite/bin/vite.js',['build','--config','desktop/vite.config.mjs']],
]) {
  const result = spawnSync(process.execPath,[path.join(root,entry),...args],{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status ?? 1);
}
