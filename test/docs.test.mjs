import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('copy and git allowlists include the actual pairing implementation and offline tests',async()=>{
  for(const filename of ['CREAR_AGENTE.md','HEROKU.md']) {
    const text=await readFile(new URL('../'+filename,import.meta.url),'utf8');
    const list=text.match(/\$SourceFiles\s*=\s*@\(([\s\S]*?)\)/)?.[1]??'';
    for(const path of ['src/pairing.mjs','src/server.mjs','test/pairing.test.mjs',
      'test/operator.test.mjs','test/network-guard.mjs','test/docs.test.mjs'])
      assert.ok(list.includes("'"+path+"'"),filename+' must include '+path);
  }
});

test('student guide documents code, explicit retry, privacy and GitHub-before-Heroku',async()=>{
  const config=await readFile(new URL('../CONFIGURACION.md',import.meta.url),'utf8');
  assert.ok(config.includes('Desconectar') && config.includes('Iniciar nuevo intento'));
  assert.ok(config.includes('no es un SMS') && config.includes('no se solicita otro código automáticamente'));
  const deploy=await readFile(new URL('../HEROKU.md',import.meta.url),'utf8');
  assert.ok(deploy.includes('WA_ENABLE_CONNECTION=true'));
  assert.ok(deploy.includes('git push -u origin main'));
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.ok(pkg.scripts.test.includes('network-guard.mjs') && pkg.scripts.test.includes('--test-concurrency=1'));
});
