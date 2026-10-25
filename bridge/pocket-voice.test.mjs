import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {resolve, join} from 'node:path';
import {mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {PocketVoice, validatePocketConfig, POCKET_LIMITS,
  POCKET_SOURCE_REVISION, POCKET_SOURCE_SHA256} from './pocket-voice.mjs';

const tick = () => new Promise(done => setImmediate(done));
const profile = 'johnny-silverhand';
const config = () => ({version: 1, provider: 'pocket', engine: 'pocket-tts',
  runtime: Object.fromEntries(['sourceDirectory','exportDirectory','referenceDirectory','workDirectory']
    .map(key => [key, resolve('pocket-fixtures', key)])),
  model: {sha256:'a'.repeat(64),configSha256:'b'.repeat(64),tokenizerSha256:'c'.repeat(64),
    receiptSha256:'d'.repeat(64),inputIdentity:'e'.repeat(64),selectedStep:1500},
  cpu: {threads:2}, voices: {[profile]: {reference:'runtime/voice-references/johnny.wav',
    sha256:'f'.repeat(64), transcript:'One native reference line.'}},
  preparation: {startupProfiles:[],maxCachedProfiles:2}});

function clock() {
  const jobs = new Map(); let time = 0, sequence = 0;
  return {now:()=>time, set(callback, delay) { const id=++sequence; jobs.set(id,{callback,at:time+delay}); return id; },
    clear:id=>jobs.delete(id), advance(ms) { const target=time+ms;
      for (;;) { const next=[...jobs].filter(([,job])=>job.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if (!next) break; jobs.delete(next[0]); time=next[1].at; next[1].callback(); } time=target; }};
}

function harness({autoReady=true, settings=config(), timers, isAlive}={}) {
  const requests=[], states=[], launches=[];
  const child=new EventEmitter(); child.pid=987; child.kills=0; child.kill=()=>{child.kills++;return true;};
  child.stdout=new PassThrough(); child.stderr=new PassThrough();
  child.stdin=new Writable({write(bytes,encoding,done) { requests.push(JSON.parse(bytes.toString()));done(); }});
  const client=new PocketVoice(settings,{project:process.cwd(),configPath:resolve('pocket-fixtures/config.json'),
    pythonExecutable:resolve('pocket-fixtures/python.exe'),spawnImpl:(exe,args,options)=>{
      launches.push({exe,args,options});if(autoReady)queueMicrotask(()=>ready());return child;},
    onState:state=>states.push(state),...(timers?{setTimer:timers.set,clearTimer:timers.clear}:{}),...(isAlive?{isAlive}:{})});
  const send=frame=>child.stdout.write(JSON.stringify({owner:client.owner,...frame})+'\n');
  const profiles=()=>({profiles:[profile],preparedProfiles:[profile],unavailableProfiles:{}});
  const ready=(extra={})=>send({op:'ready',protocolVersion:1,engine:'pocket-tts',device:'cpu',dtype:'torch.float32',
    runtime:'pytorch',layers:6,decodeSteps:1,sampleCfg:1,threads:2,gpuVramBytes:0,sourceRevision:POCKET_SOURCE_REVISION,
    sourceSha256:POCKET_SOURCE_SHA256,model:settings.model,workerPaths:settings.runtime,
    profiles:[profile],preparedProfiles:[],referenceHashes:{[profile]:settings.voices[profile].sha256},...extra});
  const prepared=(index=0,extra={})=>{const req=requests[index];send({op:'prepared',id:req.id,profile:req.profile,
    preparationMs:5,...profiles(),...extra});};
  const pcm=(request,index,offsetFrames,values=[0,.123,-.42,1.2],extra={})=>{
    const bytes=Buffer.alloc(values.length*4);values.forEach((value,at)=>bytes.writeFloatLE(value,at*4));
    send({op:'pcm',id:request.id,profile,index,offsetFrames,frames:values.length,sampleRate:24000,channels:1,
      format:'f32le',pcm:bytes.toString('base64'),yieldMs:index*40,copiedReadyMs:index*45,...extra});return bytes;};
  const done=(request,frames=8,chunks=2,extra={})=>send({op:'done',id:request.id,profile,frames,chunks,
    sampleRate:24000,channels:1,preparationMs:0,firstPcmYieldMs:40,firstPcmCopiedReadyMs:45,
    generationMs:110,...profiles(),...extra});
  const finish=code=>child.emit('close',code??0);
  return {client,child,requests,states,launches,send,ready,prepared,pcm,done,profiles,finish,
    close:async()=>{const closing=client.close();finish();await closing;}};
}

test('requires an explicit hashed student and executable without a development fallback',()=>{
  const original=config(),validated=validatePocketConfig(original);original.model.sha256='0'.repeat(64);
  assert.equal(validated.model.sha256,'a'.repeat(64));
  for (const invalid of [undefined,'python.exe','',resolve('python.exe')+'\n']) {
    assert.throws(()=>new PocketVoice(config(),{project:process.cwd(),configPath:resolve('config.json'),pythonExecutable:invalid}),
      /absolute|fall back/);
  }
  for (const override of [{version:2},{engine:'teacher'},{model:{sha256:'a'.repeat(64)}},{cpu:{threads:12}},
    {sampling:{decodeSteps:2}},{runtime:{sourceDirectory:resolve('source')}}])
    assert.throws(()=>validatePocketConfig({...config(),...override}));
});

test('starts one hidden CPU worker and attests every selected asset before readiness',async()=>{
  const h=harness();await h.client.start();await h.client.start();assert.equal(h.launches.length,1);
  const launch=h.launches[0];assert.equal(launch.options.windowsHide,true);
  assert.deepEqual(launch.options.stdio,['pipe','pipe','pipe']);assert.equal(launch.options.shell,undefined);
  assert.equal(launch.options.env.CUDA_VISIBLE_DEVICES,'-1');assert.equal(launch.options.env.OMP_NUM_THREADS,'2');
  assert.equal(launch.options.env.HF_TOKEN,undefined);assert.equal(launch.options.env.KAGGLE_API_TOKEN,undefined);
  assert.equal(h.client.loaded,true);assert.equal(h.client.profileReady(profile),false);
  assert.equal(h.states.at(-1).engine,'pocket-tts');assert.equal(h.states.at(-1).gpuVramBytes,0);
  await h.close();assert.equal(h.child.stdin.writableEnded,true);assert.equal(h.client.loaded,false);
});

test('a Runtime behind a junction or symlink above its folders starts: the worker reports the real places, and the bridge compares real places',async t=>{
  const base=realpathSync.native(mkdtempSync(join(tmpdir(),'pocket-link-'))),real=join(base,'real'),library=join(base,'library');
  const fields=['sourceDirectory','exportDirectory','referenceDirectory','workDirectory'];
  for (const key of fields) mkdirSync(join(real,key),{recursive:true});
  try { symlinkSync(real,library,'junction'); } catch (error) { rmSync(base,{recursive:true,force:true}); return t.skip(`directory links are not available here: ${error.code}`); }
  try {
    const settings={...config(),runtime:Object.fromEntries(fields.map(key=>[key,join(library,key)]))};
    const h=harness({autoReady:false,settings});const starting=h.client.start();await tick();
    h.ready({workerPaths:Object.fromEntries(fields.map(key=>[key,join(real,key)]))});await starting;
    assert.equal(h.client.loaded,true);await h.close();
  } finally { try { rmdirSync(library); } catch {} rmSync(base,{recursive:true,force:true}); }
});

test('a worker that cannot start says why in its fatal frame: the failure keeps the reason, cut short and without control characters',async()=>{
  // Two 0.2.2 reports only said "Pocket student runtime is unavailable"; the reason was in the worker's own stderr lines.
  const h=harness({autoReady:false});
  const starting=assert.rejects(h.client.start(),/Pocket student runtime is unavailable \(ValueError: Pocket source differs from the pinned official revision\)$/);
  await tick();h.send({op:'fatal',message:'Pocket student runtime is unavailable.',reason:'ValueError: Pocket source differs from the pinned official revision'});
  await starting;
  const plain=harness({autoReady:false});
  const bare=assert.rejects(plain.client.start(),/^Error: Pocket student runtime is unavailable$/);
  await tick();plain.send({op:'fatal',message:'Pocket student runtime is unavailable.'});await bare;
  const long=harness({autoReady:false});
  const cut=long.client.start().catch(error=>error);
  await tick();long.send({op:'fatal',reason:'Err\n'+'x'.repeat(500)});
  const error=await cut;assert(error.message.length<=70+300+4&&!/\n/.test(error.message),error.message);
});

test('rejects wrong model, source, CPU precision, paths or conditioning identities before streaming',async()=>{
  for (const override of [{model:{...config().model,sha256:'0'.repeat(64)}},{sourceSha256:'0'.repeat(64)},
    {dtype:'torch.float16'},{layers:24},{device:'cuda:0'},
    {workerPaths:{...config().runtime,exportDirectory:resolve('wrong')}},{referenceHashes:{[profile]:'0'.repeat(64)}}]) {
    const h=harness({autoReady:false});const failed=assert.rejects(h.client.start(),/attest|reference identities/);
    h.ready(override);await failed;assert.equal(h.client.loaded,false);await h.close();
  }
});

test('passes a whole reply once and hands off copied PCM before completion with ACK backpressure',async()=>{
  const h=harness(),packets=[];let release;
  const gate=new Promise(done=>{release=done;});
  const text="My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?";
  let completed=false;
  const synthesis=h.client.synthesizeStream(profile,text,{onPcm:async packet=>{packets.push(packet);if(packet.index===1)await gate;}});
  synthesis.then(()=>{completed=true;});await tick();h.prepared();await tick();
  const request=h.requests[1];assert.equal(request.op,'stream');assert.equal(request.text,text);
  const first=h.pcm(request,1,0);await tick();assert.equal(packets.length,1);assert.equal(completed,false);
  assert.equal(h.requests.filter(row=>row.op==='ack').length,0,'a reused producer buffer cannot overtake the sink');
  assert.equal(packets[0].timebase,'audio-seconds');assert.equal(packets[0].startSeconds,0);
  assert.deepEqual([...packets[0].pcm],Array.from({length:4},(_,at)=>first.readFloatLE(at*4)));
  assert.ok(packets[0].pcm[3]>1,'source float PCM is not normalized or clipped');
  release();await tick();assert.equal(h.requests.at(-1).op,'ack');
  h.pcm(request,2,4);await tick();assert.equal(packets[1].startSeconds,4/24000);h.done(request);
  const result=await synthesis;assert.equal(result.frames,8);assert.equal(result.chunks,2);assert.equal(result.audio,undefined);
  assert.equal(result.timing.voiceFirstPcmYieldMs,40);assert.equal(result.timing.voiceFirstPcmCopiedReadyMs,45);
  assert.equal(h.requests.filter(row=>row.op==='stream').length,1);await h.close();
});

test('abort releases the caller but the next turn waits for confirmed physical cancellation',async()=>{
  const h=harness(),controller=new AbortController();let heard=0;
  const first=h.client.synthesizeStream(profile,'A first complete reply.',{signal:controller.signal,onPcm:()=>{heard++;}});
  const rejected=assert.rejects(first,{name:'AbortError'});await tick();h.prepared();await tick();const request=h.requests[1];
  controller.abort();await rejected;assert.equal(h.requests.at(-1).op,'cancel');
  const second=h.client.prepareProfile(profile);await tick();assert.equal(h.requests.filter(row=>row.op==='prepare').length,1);
  h.pcm(request,1,0);await tick();assert.equal(heard,0,'late cancelled PCM is never admitted');
  h.send({op:'cancelled',id:request.id,profile,...h.profiles()});await tick();
  assert.equal(h.requests.at(-1).op,'prepare');h.prepared(h.requests.length-1);await second;await h.close();
});

test('sink failure cancels the exact request and never acknowledges unpublished audio',async()=>{
  const h=harness();const synthesis=h.client.synthesizeStream(profile,'One reply.',{onPcm:()=>{throw Error('sink owner retired');}});
  const rejected=assert.rejects(synthesis,/sink owner retired/);await tick();h.prepared();await tick();
  const request=h.requests[1];h.pcm(request,1,0);await tick();assert.equal(h.requests.at(-1).op,'cancel');
  assert.equal(h.requests.filter(row=>row.op==='ack').length,0);
  h.send({op:'cancelled',id:request.id,profile,...h.profiles()});await rejected;await h.close();
});

test('withdraws only a changed reference and never aliases it to another voice',async()=>{
  const h=harness();const preparation=h.client.prepareProfile(profile),rejected=assert.rejects(preparation,/could not prepare/);
  await tick();h.send({op:'error',id:h.requests[0].id,profile,profiles:[],preparedProfiles:[],unavailableProfiles:{[profile]:'unavailable'}});
  await rejected;assert.equal(h.client.hasProfile(profile),false);assert.equal(h.client.profileReady(profile),false);
  assert.deepEqual(await h.client.prepareProfile(profile),{provider:'text',ready:true,reason:'unavailable'});
  await h.close();
});

test('rejects invalid packet order and copied-ready clocks without delivering it',async()=>{
  for (const extra of [{offsetFrames:4},{index:2},{copiedReadyMs:30},{frames:10}]) {
    const h=harness();let heard=0;
    const synthesis=h.client.synthesizeStream(profile,'One reply.',{onPcm:()=>{heard++;}}),rejected=assert.rejects(synthesis,/PCM/);
    await tick();h.prepared();await tick();h.pcm(h.requests[1],1,0,undefined,extra);
    await rejected;assert.equal(heard,0);assert.equal(h.client.profileReady(profile),false);await h.close();
  }
});

test('terminal native synthesis failure retires the owned worker and cannot reuse a possibly unjoined decoder',async()=>{
  const h=harness();const synthesis=h.client.synthesizeStream(profile,'One reply.',{onPcm:()=>{}});
  const rejected=assert.rejects(synthesis,/generation stopped/);await tick();h.prepared();await tick();
  const request=h.requests[1];h.send({op:'error',id:request.id,profile,terminal:true,...h.profiles()});await rejected;
  assert.equal(h.child.stdin.writableEnded,true);assert.equal(h.client.profileReady(profile),false);
  const count=h.requests.length;await assert.rejects(h.client.prepareProfile(profile),/generation stopped/);
  assert.equal(h.requests.length,count,'a cached prompt cannot authorize another job on the failed worker');
  h.finish(1);await h.client.close();
});

test('hung cancellation and shutdown kill only the owned handle and require exit confirmation',async()=>{
  const timers=clock(),h=harness({timers});const controller=new AbortController();
  const synthesis=h.client.synthesizeStream(profile,'One reply.',{signal:controller.signal,onPcm:()=>{}}),rejected=assert.rejects(synthesis,{name:'AbortError'});
  await tick();h.prepared();await tick();h.pcm(h.requests[1],1,0);await tick();controller.abort();await rejected;
  // The first deadline only says so and goes on waiting; the worker is stopped when the long one has passed too.
  timers.advance(POCKET_LIMITS.cancelMs);await tick();assert.equal(h.client.failure,undefined,'the worker is given the longer wait');
  timers.advance(POCKET_LIMITS.cancelHardMs);await tick();assert.ok(h.client.failure);assert.match(h.client.failure.message,/did not stop its cancelled request/);assert.equal(h.child.stdin.writableEnded,true);
  timers.advance(POCKET_LIMITS.closeGraceMs);assert.equal(h.child.kills,1);
  const close=h.client.close(),failed=assert.rejects(close,/exit could not be confirmed/);
  timers.advance(POCKET_LIMITS.killRetryMs);assert.equal(h.child.kills,2,'stopped again before it is called unconfirmed');
  timers.advance(POCKET_LIMITS.exitMs-POCKET_LIMITS.killRetryMs);await failed;assert.equal(h.child.kills,2);
  h.finish();
});

// An exit that was not confirmed is not a process that is still running: the process is looked at again, and the late close ends the wait.
test('recoverExit: an unconfirmed exit is checked again, stopped again, and resolves when the process is gone',async()=>{
  const timers=clock();let alive=true;const h=harness({timers,isAlive:()=>alive});
  h.client.start();await tick();await tick();
  const close=h.client.close(),failed=assert.rejects(close,/exit could not be confirmed/);
  timers.advance(POCKET_LIMITS.closeGraceMs+POCKET_LIMITS.exitMs);await failed;
  const kills=h.child.kills,recovered=h.client.recoverExit({timeoutMs:60_000,pollMs:1000,killMs:10_000});
  timers.advance(25_000);assert.ok(h.child.kills>kills,'it is stopped again while it still runs');
  alive=false;timers.advance(1000);assert.equal(await recovered,true);assert.equal(h.client.child,null);
});

test('recoverExit gives up (false) when the process is still running after its time',async()=>{
  const timers=clock(),h=harness({timers,isAlive:()=>true});
  h.client.start();await tick();await tick();
  const close=h.client.close(),failed=assert.rejects(close,/exit could not be confirmed/);
  timers.advance(POCKET_LIMITS.closeGraceMs+POCKET_LIMITS.exitMs);await failed;
  const recovered=h.client.recoverExit({timeoutMs:5000,pollMs:1000,killMs:2000});timers.advance(6000);
  assert.equal(await recovered,false);
});

// A first-time preparation of a voice takes 1.4 to 4.5 s and cannot be interrupted. V's typed line is cancelled on purpose when the companion's voice
// starts, so the first line after an install used to take the whole worker down at the 2 s cancel deadline (and Pocket then stayed failed).
test('cancelling a voice preparation waits for it to finish instead of killing the worker, and the worker goes on with the next job', async () => {
  const timers = clock(), h = harness({timers}), controller = new AbortController();
  const preparing = h.client.prepareProfile(profile, {signal: controller.signal}), rejected = assert.rejects(preparing, {name: 'AbortError'});
  await tick(); const request = h.requests[0]; assert.equal(request.op, 'prepare');
  controller.abort(); await rejected; assert.equal(h.requests.at(-1).op, 'cancel');
  // The old deadline and then some pass with the worker still preparing: it is not stopped.
  timers.advance(POCKET_LIMITS.cancelMs * 2); await tick();
  assert.equal(h.client.failure, undefined); assert.equal(h.child.stdin.writableEnded, false); assert.equal(h.child.kills, 0);
  // The next job queues behind it (the worker takes one at a time); nothing is sent while the preparation runs.
  const next = h.client.prepareProfile(profile); await tick(); assert.equal(h.requests.filter(row => row.op === 'prepare').length, 1);
  // The preparation ends: the worker answers 'cancelled' (what it prepared stays), and the same worker runs the next job.
  h.send({op: 'cancelled', id: request.id, profile, ...h.profiles()}); await tick();
  assert.equal(h.client.failure, undefined); assert.equal(h.requests.at(-1).op, 'prepare'); assert.notEqual(h.requests.at(-1).id, request.id);
  timers.advance(POCKET_LIMITS.prepareCancelMs); await tick(); assert.equal(h.client.failure, undefined, 'the answered cancel has no deadline left');
  h.prepared(h.requests.length - 1); assert.equal((await next).ready, true);
  assert.equal(h.launches.length, 1, 'one worker throughout'); await h.close();
});

test('a cancelled preparation that never ends still stops the worker, after the longer wait', async () => {
  const timers = clock(), h = harness({timers}), controller = new AbortController();
  const preparing = h.client.prepareProfile(profile, {signal: controller.signal}), rejected = assert.rejects(preparing, {name: 'AbortError'});
  await tick(); controller.abort(); await rejected;
  timers.advance(POCKET_LIMITS.prepareCancelMs + POCKET_LIMITS.cancelHardMs - 1); await tick(); assert.equal(h.client.failure, undefined);
  timers.advance(1); await tick(); assert.match(h.client.failure.message, /did not stop its cancelled request/);
  assert.equal(h.child.stdin.writableEnded, true);
  timers.advance(POCKET_LIMITS.closeGraceMs); assert.equal(h.child.kills, 1);
  h.finish();
});

// A long decoder chunk is cut into consecutive packets by the worker, all with the chunk's one clock; the bridge takes them in order.
test('consecutive packets cut from one decoder chunk (the same clocks) are accepted in order', async () => {
  const h = harness(), packets = [];
  const synthesis = h.client.synthesizeStream(profile, 'One long reply.', {onPcm: packet => { packets.push(packet); }});
  await tick(); h.prepared(); await tick(); const request = h.requests[1];
  h.pcm(request, 1, 0); await tick();
  h.pcm(request, 2, 4, undefined, {yieldMs: 40, copiedReadyMs: 45}); await tick();
  h.pcm(request, 3, 8, undefined, {yieldMs: 40, copiedReadyMs: 45}); await tick();
  assert.deepEqual(packets.map(packet => packet.index), [1, 2, 3]);
  h.done(request, 12, 3); const result = await synthesis; assert.equal(result.frames, 12); assert.equal(result.chunks, 3);
  await h.close();
});

// 0.2.4 report (RTX 5050 laptop, OmniVoice beside it): V's first line was dropped while the worker was starved of CPU, the cancel came before
// any sound, and the 2 s deadline took the worker down ("did not stop its cancelled request"). Before its first sound a stream is still
// preparing the voice or reading the text, which cannot be interrupted, so it gets the long wait.
test('a stream cancelled before its first sound waits for the worker to answer instead of killing it at the 2 s deadline', async () => {
  const timers = clock(), h = harness({timers}), controller = new AbortController();
  const synthesis = h.client.synthesizeStream(profile, 'One reply.', {signal: controller.signal, onPcm: () => {}}), rejected = assert.rejects(synthesis, {name: 'AbortError'});
  await tick(); h.prepared(); await tick(); const request = h.requests[1]; assert.equal(request.op, 'stream');
  controller.abort(); await rejected; assert.equal(h.requests.at(-1).op, 'cancel');
  timers.advance(POCKET_LIMITS.cancelMs * 2); await tick();
  assert.equal(h.client.failure, undefined); assert.equal(h.child.stdin.writableEnded, false); assert.equal(h.child.kills, 0);
  h.send({op: 'cancelled', id: request.id, profile, ...h.profiles()}); await tick();
  timers.advance(POCKET_LIMITS.prepareCancelMs); await tick();
  assert.equal(h.client.failure, undefined, 'the answered cancel has no deadline left'); assert.equal(h.launches.length, 1, 'one worker throughout');
  await h.close();
});

test('a stream cancelled before its first sound that never answers still stops the worker, after the long wait', async () => {
  const timers = clock(), h = harness({timers}), controller = new AbortController();
  const synthesis = h.client.synthesizeStream(profile, 'One reply.', {signal: controller.signal, onPcm: () => {}}), rejected = assert.rejects(synthesis, {name: 'AbortError'});
  await tick(); h.prepared(); await tick(); controller.abort(); await rejected;
  timers.advance(POCKET_LIMITS.prepareCancelMs + POCKET_LIMITS.cancelHardMs - 1); await tick(); assert.equal(h.client.failure, undefined);
  timers.advance(1); await tick(); assert.match(h.client.failure.message, /did not stop its cancelled request/);
  timers.advance(POCKET_LIMITS.closeGraceMs); assert.equal(h.child.kills, 1);
  h.finish();
});

test('Keep prepared voices is sent with each prepare and stream request only while on, and the source is reported',async()=>{
  const off=harness();
  const first=off.client.prepareProfile(profile);await tick();
  assert.equal(off.requests[0].op,'prepare');assert.equal('keep' in off.requests[0],false,'off sends no keep flag');
  off.prepared(0);assert.equal((await first).preparationSource,undefined);
  off.client.setKeepPrepared(true);
  const second=off.client.synthesizeStream(profile,'A reply.',{onPcm:()=>{}});await tick();
  const prepare=off.requests.find((row,at)=>at>0&&row.op==='prepare');
  assert.equal(prepare.keep,true);off.prepared(off.requests.indexOf(prepare),{preparationSource:'disk',preparationMs:14});await tick();
  const stream=off.requests.find(row=>row.op==='stream');assert.equal(stream.keep,true);
  off.pcm(stream,1,0);await tick();off.done(stream,4,1,{preparationSource:'memory'});
  const result=await second;assert.equal(result.timing.voicePreparationSource,'memory');
  await off.close();
  const on=new PocketVoice(config(),{project:process.cwd(),configPath:resolve('pocket-fixtures/config.json'),
    pythonExecutable:resolve('pocket-fixtures/python.exe'),keepPreparedVoices:true,spawnImpl:()=>{throw Error('not started');}});
  assert.equal(on.keepPrepared,true);on.setKeepPrepared(false);assert.equal(on.keepPrepared,false);
  on.setKeepPrepared('yes');assert.equal(on.keepPrepared,false,'only a real boolean turns it on');
});

// ---- the startup watchdog: a worker stuck while starting (a starved CPU, a hung import) is stopped and started once more, then given up ----

function restartHarness() {
  const timers = clock(), launches = [], logs = [], children = [];
  const make = () => {
    const child = new EventEmitter(); child.pid = 1000 + children.length; child.kills = 0; child.kill = () => { child.kills++; return true; };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({write(bytes, encoding, done) { done(); }});
    children.push(child); return child;
  };
  const settings = config();
  const client = new PocketVoice(settings, {project: process.cwd(), configPath: resolve('pocket-fixtures/config.json'),
    pythonExecutable: resolve('pocket-fixtures/python.exe'), setTimer: timers.set, clearTimer: timers.clear, now: timers.now,
    onLog: line => logs.push(line), spawnImpl: (exe, args) => { launches.push(args); return make(); }});
  const send = (child, frame) => child.stdout.write(JSON.stringify({owner: client.owner, ...frame}) + '\n');
  const ready = child => send(child, {op: 'ready', protocolVersion: 1, engine: 'pocket-tts', device: 'cpu', dtype: 'torch.float32',
    runtime: 'pytorch', layers: 6, decodeSteps: 1, sampleCfg: 1, threads: 2, gpuVramBytes: 0, sourceRevision: POCKET_SOURCE_REVISION,
    sourceSha256: POCKET_SOURCE_SHA256, model: settings.model, workerPaths: settings.runtime,
    profiles: [profile], preparedProfiles: [], referenceHashes: {[profile]: settings.voices[profile].sha256}});
  return {client, timers, launches, logs, children, send, ready};
}

test('a worker stuck importing is stopped and started once more; the second one gets ready, and every phase is logged with its time', async () => {
  const h = restartHarness();
  const starting = h.client.start(); await tick();
  assert.equal(h.launches.length, 1);
  h.send(h.children[0], {op: 'state', state: 'loading'}); h.send(h.children[0], {op: 'state', state: 'loading', phase: 'importing-dependencies'}); await tick();
  h.timers.advance(POCKET_LIMITS.stallMs['importing-dependencies'] + POCKET_LIMITS.stallGraceMs['importing-dependencies'] - 1); await tick();
  assert.equal(h.children[0].kills, 0, 'not yet');
  h.timers.advance(1); await tick();
  assert.equal(h.children[0].kills, 1, 'the stuck worker is stopped'); assert.equal(h.children[0].stdin.writableEnded, true);
  assert.equal(h.launches.length, 1, 'the new worker starts when the old one is confirmed gone');
  h.children[0].emit('close', 1); await tick();
  assert.equal(h.launches.length, 2); assert.equal(h.client.failure, undefined); assert.equal(h.client.loaded, false);
  h.send(h.children[1], {op: 'state', state: 'loading', phase: 'importing-dependencies'}); h.ready(h.children[1]);
  await starting; assert.equal(h.client.loaded, true);
  const log = h.logs.join('');
  assert.match(log, /\[PocketStart\] \+[\d.]+s attempt 1\/2: worker started/);
  assert.match(log, /phase importing-dependencies/); assert.match(log, /stalled at importing-dependencies/);
  assert.match(log, /attempt 2\/2: worker started/); assert.match(log, /attempt 2\/2: ready/);
  h.client.close(); h.children[1].emit('close', 0);
});

test('a worker that stalls again is given up on cleanly: one restart only, no loop, the start fails', async () => {
  const h = restartHarness();
  const starting = h.client.start(), failed = assert.rejects(starting, /stalled/); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: 'importing-dependencies'}); await tick();
  h.timers.advance(STALL_AND_GRACE); await tick(); h.children[0].emit('close', 1); await tick();
  assert.equal(h.launches.length, 2);
  h.send(h.children[1], {op: 'state', state: 'loading', phase: 'importing-dependencies'}); await tick();
  h.timers.advance(STALL_AND_GRACE); await failed;
  assert.equal(h.launches.length, 2, 'never a third worker'); assert.ok(h.client.failure);
  assert.equal(h.children[1].stdin.writableEnded, true);
  assert.match(h.logs.join(''), /stalled at importing-dependencies again; giving up/);
  h.children[1].emit('close', 1); await tick();
  await assert.rejects(h.client.start(), /stalled/);
  assert.equal(h.launches.length, 2);
});

test('a worker that keeps moving through its phases is not restarted, and a slow phase gets its longer limit', async () => {
  const h = restartHarness();
  const starting = h.client.start(); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: 'importing-dependencies'}); await tick();
  h.timers.advance(POCKET_LIMITS.stallMs['default'] - 1000); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: 'loading-student'}); await tick();
  h.timers.advance(POCKET_LIMITS.stallMs['default'] + 1000); await tick();
  assert.equal(h.children[0].kills, 0, 'loading the student has its own, longer limit');
  h.send(h.children[0], {op: 'state', state: 'loading', phase: 'student-loaded'}); h.ready(h.children[0]);
  await starting; assert.equal(h.launches.length, 1); assert.equal(h.client.loaded, true);
  h.timers.advance(10 * POCKET_LIMITS.startupMs); await tick();
  assert.equal(h.children[0].kills, 0, 'a worker that is ready is never judged by the startup limits');
  h.client.close(); h.children[0].emit('close', 0);
});

// ---- progress: a slow import that keeps moving is never stopped; one that stands still is; the hard bound ends either ----

const IMPORT = 'importing-dependencies';
// The window of no progress plus the one bounded extra wait before a stuck worker is stopped.
const STALL_AND_GRACE = POCKET_LIMITS.stallMs[IMPORT] + POCKET_LIMITS.stallGraceMs[IMPORT];
const beat = async (h, child, cpuMs, step) => { h.send(child, {op: 'heartbeat', cpuMs, ...(step ? {step} : {})}); await tick(); };

test('a slow import that makes progress is not killed, however long it takes within the hard bound, and then gets ready', async () => {
  const h = restartHarness();
  const starting = h.client.start(); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
  // Three stall windows of a worker whose CPU time creeps (200 ms per 2 s beat), with a mark after each heavy import.
  let cpu = 0;
  for (let at = 0; at < 3 * POCKET_LIMITS.stallMs[IMPORT]; at += 2000) {
    h.timers.advance(2000); cpu += 200; await beat(h, h.children[0], cpu, at === 20_000 ? 'numpy' : at === 120_000 ? 'torch' : undefined);
  }
  assert.equal(h.children[0].kills, 0, 'a worker that moves is not stopped'); assert.equal(h.launches.length, 1);
  assert.equal(h.client.failure, undefined);
  h.send(h.children[0], {op: 'state', state: 'loading', phase: 'loading-student'}); h.send(h.children[0], {op: 'state', state: 'loading', phase: 'student-loaded'});
  h.ready(h.children[0]);
  await starting; assert.equal(h.client.loaded, true); assert.equal(h.launches.length, 1);
  const log = h.logs.join('');
  assert.match(log, /imported numpy \(worker CPU/); assert.match(log, /imported torch/); assert.match(log, /still importing-dependencies \(worker CPU [\d.]+s\), not stalled/);
  assert.doesNotMatch(log, /stalled at/);
  // A beat that arrives after the worker is ready changes nothing.
  await beat(h, h.children[0], 99_999); h.timers.advance(10 * POCKET_LIMITS.startupMs); await tick(); assert.equal(h.children[0].kills, 0);
  h.client.close(); h.children[0].emit('close', 0);
});

test('a hung import (nothing moving, however many beats) is stopped after the window and the grace wait, and a slow second attempt is not', async () => {
  const h = restartHarness();
  const starting = h.client.start(); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
  await beat(h, h.children[0], 1500);
  // Beats that add no CPU, no I/O and no module (a deadlock) are not progress and do not push the window back.
  for (let at = 0; at < STALL_AND_GRACE - 4000; at += 2000) { h.timers.advance(2000); await beat(h, h.children[0], 1500 + 50); }
  assert.equal(h.children[0].kills, 0, 'not before the window and the grace wait');
  assert.match(h.logs.join(''), /nothing moved at importing-dependencies for 60s, worker CPU 1\.5s; waiting 120s more before stopping the worker/);
  h.timers.advance(4000); await tick();
  assert.equal(h.children[0].kills, 1, 'a worker with no progress for the window and the grace wait is stopped');
  assert.match(h.logs.join(''), /stalled at importing-dependencies for 60s without progress, worker CPU 1\.5s; stopping/);
  // A beat that was already on its way while it is being stopped counts for nothing (and is not an error).
  await beat(h, h.children[0], 9_000_000);
  h.children[0].emit('close', 1); await tick();
  assert.equal(h.launches.length, 2);
  // The second attempt starts cold and creeps along for longer than a window: it is left alone.
  h.send(h.children[1], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
  for (let at = 0, cpu = 0; at < 2 * POCKET_LIMITS.stallMs[IMPORT]; at += 2000) { h.timers.advance(2000); cpu += 150; await beat(h, h.children[1], cpu); }
  assert.equal(h.children[1].kills, 0, 'a second attempt that moves is not stopped'); assert.equal(h.launches.length, 2);
  h.ready(h.children[1]); await starting; assert.equal(h.client.loaded, true);
  assert.match(h.logs.join(''), /attempt 2\/2: ready/); assert.doesNotMatch(h.logs.join(''), /again; giving up/);
  h.client.close(); h.children[1].emit('close', 0);
});

// 0.2.3 reports: a virus scan or a cold disk costs the worker wall time and no CPU time, and the CPU-only watchdog stopped it in the middle of its imports.
test('a worker whose CPU time stands still but that reads files or loads modules is not stopped, and a grace wait that sees progress starts the window over', async () => {
  const h = restartHarness();
  const starting = h.client.start(); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
  const frame = (cpuMs, ioBytes, modules) => { h.send(h.children[0], {op: 'heartbeat', cpuMs, ioBytes, modules}); return tick(); };
  await frame(500, 1_000_000, 200);
  // A window and a half of a scan: CPU frozen, but the reads creep (a megabyte per 30 s) and a module appears now and then.
  for (let at = 0, io = 1_000_000, modules = 200; at < 1.5 * POCKET_LIMITS.stallMs[IMPORT]; at += 2000) {
    h.timers.advance(2000);
    if (at % 30_000 === 0) io += 1_000_000;
    if (at % 50_000 === 0) modules += 1;
    await frame(500, io, modules);
  }
  assert.equal(h.children[0].kills, 0, 'I/O and module growth are progress'); assert.equal(h.launches.length, 1);
  // Then it stops for the window, gets the grace wait, and shows a module before the end of it: the window starts over.
  h.timers.advance(POCKET_LIMITS.stallMs[IMPORT] + 1000); await tick();
  assert.match(h.logs.join(''), /waiting 120s more/);
  await frame(500, 9_000_000, 9999); h.timers.advance(POCKET_LIMITS.stallMs[IMPORT] - 1000); await tick();
  assert.equal(h.children[0].kills, 0, 'progress during the grace wait is progress');
  h.ready(h.children[0]); await starting; assert.equal(h.client.loaded, true);
  h.client.close(); h.children[0].emit('close', 0);
});

test('heartbeat I/O and module counts are checked like the CPU time', async () => {
  for (const bad of [{ioBytes: -1}, {ioBytes: 1.5}, {modules: '9'}, {modules: -2}]) {
    const h = restartHarness();
    const starting = h.client.start(), failed = assert.rejects(starting, /Invalid Pocket worker heartbeat/); await tick();
    h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
    h.send(h.children[0], {op: 'heartbeat', cpuMs: 5, ...bad}); await failed;
    h.children[0].emit('close', 1);
  }
});

test('a worker that hangs on both attempts is stopped twice at the window and then given up on, and Pocket stays failed', async () => {
  const h = restartHarness();
  const starting = h.client.start(), failed = assert.rejects(starting, /stalled/); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await beat(h, h.children[0], 800);
  h.timers.advance(STALL_AND_GRACE); await tick(); h.children[0].emit('close', 1); await tick();
  h.send(h.children[1], {op: 'state', state: 'loading', phase: IMPORT}); await beat(h, h.children[1], 800);
  h.timers.advance(2000); await beat(h, h.children[1], 810);
  h.timers.advance(STALL_AND_GRACE); await failed;
  assert.equal(h.launches.length, 2); assert.match(h.logs.join(''), /again; giving up/);
  assert.equal(h.children[1].stdin.writableEnded, true); h.children[1].emit('close', 1);
});

test('the hard bound ends a worker that keeps moving but never gets ready: no restart, the start fails', async () => {
  const h = restartHarness();
  const starting = h.client.start(), failed = assert.rejects(starting, /timed out/); await tick();
  h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
  let cpu = 0;
  for (let at = 0; at < POCKET_LIMITS.startupMs + 2000 && !h.client.failure; at += 2000) { h.timers.advance(2000); cpu += 200; await beat(h, h.children[0], cpu); }
  await failed;
  assert.equal(h.launches.length, 1, 'a progressing worker is failed at the bound, never restarted into another cold import');
  assert.equal(h.children[0].stdin.writableEnded, true);
  h.children[0].emit('close', 1);
});

test('heartbeats are checked: a malformed beat or an unknown import step fails the worker', async () => {
  for (const bad of [{cpuMs: -1}, {cpuMs: 1.5}, {cpuMs: '5'}, {cpuMs: 5, step: 'os'}, {}]) {
    const h = restartHarness();
    const starting = h.client.start(), failed = assert.rejects(starting, /Invalid Pocket worker heartbeat/); await tick();
    h.send(h.children[0], {op: 'state', state: 'loading', phase: IMPORT}); await tick();
    h.send(h.children[0], {op: 'heartbeat', ...bad}); await failed;
    h.children[0].emit('close', 1);
  }
});

test('a preparation a reply waits on is urgent for the worker (normal priority), a voice warmed ahead of time is not', async () => {
  const h = harness();
  const warming = h.client.prepareProfile(profile); await tick();
  const warm = h.requests.at(-1);
  assert.equal(warm.op, 'prepare'); assert.equal('urgent' in warm, false, 'warming ahead of a reply stays below normal');
  h.prepared(h.requests.length - 1); await warming;
  const controller = new AbortController();
  const synthesis = h.client.synthesizeStream(profile, 'A reply that is waiting.', {signal: controller.signal, onPcm: () => {}});
  const rejected = assert.rejects(synthesis, {name: 'AbortError'}); await tick();
  const prepare = h.requests.at(-1);
  assert.equal(prepare.op, 'prepare'); assert.equal(prepare.urgent, true, 'the preparation of a reply is urgent');
  h.prepared(h.requests.length - 1); await tick();
  const stream = h.requests.at(-1); assert.equal(stream.op, 'stream');
  controller.abort(); await rejected;
  h.send({op: 'cancelled', id: stream.id, profile, ...h.profiles()}); await tick(); await h.close();
});

test('a Pocket worker that dies says why: its exit code in words and the last error line of its stderr', async () => {
  const h = harness({autoReady: false});
  const starting = h.client.start(), failed = assert.rejects(starting, /^Error: Pocket worker exited \(3221225477 = access violation \(0xC0000005\)\): Windows fatal exception: access violation$/); await tick();
  h.child.stderr.write('Windows fatal exception: access violation\n\nThread 0x0000 (most recent call first):\n  File "a.py", line 3 in run\n'); await tick();
  h.finish(3221225477); await failed;
  const plain = harness({autoReady: false}), plainFailed = assert.rejects(plain.client.start(), error => error.message === 'Pocket worker exited (1)'); await tick();
  plain.finish(1); await plainFailed;
});

// 2026-10-22 review (W12): a reply was cut at 120 s of wall time even while the worker kept producing audio (a long reply on a slow computer).
test('a reply is cut for standing still, not for its length: every chunk starts the time limit over', async () => {
  const timers = clock(), h = harness({timers}), packets = [];
  const synthesis = h.client.synthesizeStream(profile, 'A long reply on a slow computer.', {onPcm: packet => { packets.push(packet); }});
  await tick(); h.prepared(); await tick(); const request = h.requests[1];
  let offset = 0;
  for (let index = 1; index <= 5; index++) {            // five chunks, each 40 s after the last: 200 s of wall time, more than the 120 s the old limit allowed
    timers.advance(40_000); await tick(); h.pcm(request, index, offset); offset += 4; await tick();
  }
  assert.equal(h.client.failure, undefined); assert.equal(packets.length, 5);
  h.done(request, 20, 5, {generationMs: 300}); const result = await synthesis; assert.equal(result.frames, 20);
  // The same worker that then stands still for the idle limit is cut.
  const stalled = h.client.synthesizeStream(profile, 'Another.', {onPcm: () => {}}), rejected = assert.rejects(stalled, /Pocket speech timed out/);
  await tick(); h.prepared(h.requests.length - 1); await tick(); const next = h.requests.at(-1); assert.equal(next.op, 'stream');
  h.pcm(next, 1, 0); await tick();
  timers.advance(POCKET_LIMITS.renderIdleMs - 1); await tick(); assert.equal(h.client.pending.size, 1, 'still within the limit');
  timers.advance(1); await tick(); assert.equal(h.requests.at(-1).op, 'cancel', 'the worker is told to stop it');
  h.send({op: 'cancelled', id: next.id, profile, ...h.profiles()}); await tick(); await rejected;
  await h.close();
});
