import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {candidateTransform} from './integration.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(here,'../..');
const mirror=path.join(here,'.generated','typecheck');
await fs.mkdir(mirror,{recursive:true});
await fs.cp(path.join(root,'src'),path.join(mirror,'src'),{recursive:true});
const experimentMirror=path.join(mirror,'experiments/boundary-planner');
await fs.mkdir(experimentMirror,{recursive:true});
for(const file of await fs.readdir(here)) {
  if (!/\.(?:ts|mts|mjs)$/.test(file)) continue;
  await fs.copyFile(path.join(here,file),path.join(experimentMirror,file));
}
for(const file of ['index.ts','fhir.ts','schedule.ts','hpsg/clause-parser.ts','hpsg/rules/site-rules.ts','date-interpretation.ts','lexer/locales/th.ts']) {
  const original=path.join(root,'src',file);
  const code=candidateTransform(await fs.readFile(original,'utf8'),original);
  if(code===undefined) throw new Error(`No transform for ${file}`);
  await fs.writeFile(path.join(mirror,'src',file),code.split(here).join(experimentMirror));
}
await fs.writeFile(path.join(mirror,'tsconfig.json'),JSON.stringify({
  extends:path.join(here,'tsconfig.json'),compilerOptions:{rootDir:root,noEmit:true,allowImportingTsExtensions:true},
  include:[path.join(mirror,'src/**/*.ts'),path.join(experimentMirror,'*.ts')],exclude:[]
},null,2));
const result=spawnSync(path.join(root,'node_modules/.bin/tsc'),['-p',path.join(mirror,'tsconfig.json')],{cwd:root,stdio:'inherit'});
if(result.error) throw result.error;
process.exitCode=result.status ?? 1;
