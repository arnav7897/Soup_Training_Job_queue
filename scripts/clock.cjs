#!/usr/bin/env node
'use strict';
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const run = `clock-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const dir = path.join(root, 'runs', run); fs.mkdirSync(dir, { recursive: true });
const project = `soupclock${crypto.randomBytes(6).toString('hex')}`;
const dockerfile = path.join(dir, 'Dockerfile.clock');
fs.writeFileSync(dockerfile, fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8') + '\nUSER root\nRUN apk add --no-cache libfaketime\nUSER node\n');
const override = path.join(dir, 'compose.override.yml');
// Compose merges ports by default. A tagged YAML override replaces the base port instead.
fs.writeFileSync(override, `services:\n  api:\n    ports: !override\n      - '127.0.0.1::3000'\n  worker:\n    build:\n      context: ${JSON.stringify(root)}\n      dockerfile: ${JSON.stringify(dockerfile)}\n    deploy:\n      replicas: 1\n    environment:\n      LEASE_MS: '1200'\n      LD_PRELOAD: /usr/lib/faketime/libfaketime.so.1\n      FAKETIME: '+24h'\n      FAKETIME_DONT_FAKE_MONOTONIC: '1'\n`);
const raw = fs.createWriteStream(path.join(dir, 'events.ndjson'), { flags: 'wx' });
function record(type, fields = {}) { raw.write(JSON.stringify({ time: new Date().toISOString(), type, ...fields }) + '\n'); }
const args = ['compose','-p',project,'-f',path.join(root,'compose.yaml'),'-f',override];
async function docker(...commands) { const r = await exec('docker', [...args, ...commands], { cwd: root, timeout: 300000, maxBuffer: 16*1024*1024 }); record('command', { commands, stdout:r.stdout, stderr:r.stderr }); return r.stdout.trim(); }
async function saveLogs() { const fd=fs.openSync(path.join(dir,'compose.log'),'wx'); try { await new Promise((resolve,reject)=>{const child=spawn('docker',[...args,'logs','--no-color','--timestamps'],{cwd:root,stdio:['ignore',fd,fd]});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(`logs exited ${code}`)));}); } finally { fs.closeSync(fd); } }
async function waitForApi(base) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; }
    catch { /* API may still be starting. */ }
    await sleep(500);
  }
  throw Error('API did not become healthy within 30 seconds');
}
async function main() {
  const summary = { run, project, status:'failed', startedAt:new Date().toISOString(), errors:[], checks:{} };
  try {
    await docker('up','-d','--build');
    const port=(await docker('port','api','3000')).match(/:(\d+)$/);
    if (!port) throw Error('API port unavailable');
    await waitForApi(`http://127.0.0.1:${port[1]}`);
    const fakeNow=Number(await docker('exec','-T','worker','node','-e','console.log(Date.now())'));
    const offsetSeconds=(fakeNow-Date.now())/1000;
    const response=await fetch(`http://127.0.0.1:${port[1]}/jobs`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':run},body:JSON.stringify({name:'clock-probe',model:'gpt2-small',params:{epochs:1,batchSize:1,learningRate:0.01,durationMs:4000}})});
    const job=await response.json(); record('create',{status:response.status,job});
    if (response.status!==201) throw Error(`create failed: ${response.status}`);
    await sleep(2200);
    const sql=`SELECT json_build_object('status',status,'remaining_seconds',EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp())),'attempts',attempts) FROM jobs WHERE id='${job.id}'`;
    const during=JSON.parse(await docker('exec','-T','db','psql','-U','queue','-d','queue','-At','-c',sql));
    for(let i=0;i<30;i++){const result=await (await fetch(`http://127.0.0.1:${port[1]}/jobs/${job.id}`)).json();record('status',result);if(result.status==='succeeded')break;await sleep(500);}
    const final=JSON.parse(await docker('exec','-T','db','psql','-U','queue','-d','queue','-At','-c',`SELECT json_build_object('status',status,'attempts',attempts,'effects',(SELECT count(*) FROM effects WHERE job_id=jobs.id),'expiries',(SELECT value FROM queue_counters WHERE name='lease_expiries')) FROM jobs WHERE id='${job.id}'`));
    summary.observed={offsetSeconds,during,final};
    summary.checks={clockOffsetObserved:offsetSeconds>86000&&offsetSeconds<87000,leaseUsesDatabaseClock:during.status==='running'&&Number(during.remaining_seconds)>0&&Number(during.remaining_seconds)<3,completedOnce:final.status==='succeeded'&&final.attempts===1&&Number(final.effects)===1&&Number(final.expiries)===0};
    summary.status=Object.values(summary.checks).every(Boolean)?'passed':'failed';
  } catch(error) { summary.errors.push(String(error)); record('error',{error:String(error)}); }
  finally {
    try { await saveLogs(); } catch(error) { summary.errors.push(`logs: ${error}`); }
    try { await docker('down','--remove-orphans'); } catch(error) { summary.errors.push(`cleanup: ${error}`); }
    if(summary.errors.length)summary.status='failed';summary.finishedAt=new Date().toISOString();
    fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});record('summary',summary);
    await new Promise(resolve=>raw.end(resolve));console.log(JSON.stringify(summary,null,2));if(summary.status!=='passed')process.exitCode=1;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
