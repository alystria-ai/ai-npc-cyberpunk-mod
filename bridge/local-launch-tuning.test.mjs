import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TUNING, TUNING_VARIABLE, parseTuning, resolveLaunchTuning} from './local-launch-tuning.mjs';
import {buildServerArgs} from './local-llm-server.mjs';

const env = text => ({[TUNING_VARIABLE]: text});

test('nothing is on by default: no variable, no extra arguments', () => {
  assert.deepEqual(DEFAULT_TUNING, {});
  assert.deepEqual(resolveLaunchTuning({environment: {}}), {args: [], applied: {}, text: ''});
  assert.deepEqual(resolveLaunchTuning({environment: env('')}).args, []);
});

test('parseTuning keeps known names with in-range whole numbers and drops everything else', () => {
  assert.deepEqual(parseTuning('checkpoint-step=256, cache-reuse=256 poll=0 ubatch=1024 threads=4 backend-sampling'),
    {'checkpoint-step': 256, 'cache-reuse': 256, poll: 0, ubatch: 1024, threads: 4, 'backend-sampling': true});
  assert.deepEqual(parseTuning('CHECKPOINT-STEP=0'), {'checkpoint-step': 0});
  for (const bad of ['threads=0', 'threads=33', 'threads=-1', 'threads=4.5', 'threads=x', 'threads=', 'poll=101', 'ubatch=32', 'cache-reuse=8', 'checkpoint-step=2000000',
    'unknown=3', 'threads', 'backend-sampling=1', '=4', '--kv-offload', 'poll=0x10'])
    assert.deepEqual(parseTuning(bad), {}, bad);
  assert.deepEqual(parseTuning(undefined), {});
  assert.deepEqual(parseTuning(42), {});
});

test('each knob becomes its own flags, in a fixed order', () => {
  const result = resolveLaunchTuning({environment: env('backend-sampling,ubatch=1024,threads=4,poll=0,cache-reuse=256,checkpoint-step=512')});
  assert.deepEqual(result.args, ['-cms', '512', '--cache-reuse', '256', '-t', '4', '-tb', '4', '--poll', '0', '-ub', '1024', '-bs']);
  assert.equal(result.text, 'checkpoint-step=512, cache-reuse=256, threads=4, poll=0, ubatch=1024, backend-sampling');
  assert.deepEqual(result.applied, {'checkpoint-step': 512, 'cache-reuse': 256, threads: 4, poll: 0, ubatch: 1024, 'backend-sampling': true});
});

test('an offloaded load keeps its own thread cap, and a flag the command line already has is not repeated', () => {
  assert.deepEqual(resolveLaunchTuning({environment: env('threads=4,poll=0'), offload: true}).args, ['--poll', '0']);
  assert.deepEqual(resolveLaunchTuning({environment: env('threads=4'), offload: false}).args, ['-t', '4', '-tb', '4']);
  assert.deepEqual(resolveLaunchTuning({environment: env('threads=4,poll=0'), taken: ['-t']}).args, ['--poll', '0']);
});

test('the defaults are applied first and the player\'s variable overrides them', () => {
  const defaults = {poll: 0, 'checkpoint-step': 256};
  assert.deepEqual(resolveLaunchTuning({environment: {}, defaults}).args, ['-cms', '256', '--poll', '0']);
  assert.deepEqual(resolveLaunchTuning({environment: env('poll=25'), defaults}).args, ['-cms', '256', '--poll', '25']);
  assert.deepEqual(resolveLaunchTuning({environment: env('garbage'), defaults}).args, ['-cms', '256', '--poll', '0']);
});

test('buildServerArgs: extra arguments sit before the host and port, and without them the command line is byte for byte what it was', () => {
  const base = {model: 'M.gguf', port: 5123, keyFile: 'K', device: 'Vulkan1', contextSize: 4096};
  const plain = buildServerArgs(base);
  assert.deepEqual(buildServerArgs({...base, extraArgs: []}), plain);
  const tuned = buildServerArgs({...base, extraArgs: ['-cms', '256']});
  assert.deepEqual(tuned, [...plain.slice(0, plain.indexOf('--host')), '-cms', '256', ...plain.slice(plain.indexOf('--host'))]);
  assert.equal(tuned.at(-1), 'K', 'the key file stays last');
});
