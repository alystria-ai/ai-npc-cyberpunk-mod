import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoicePreviewLease,VOICE_PREVIEW_MAX_AGE_MS} from './voice-preview.mjs';
const lease=(extra={})=>JSON.stringify({version:1,owner:'mcm-session-one',sequence:1,active:true,
  provider:'pocket',updated:100000,...extra});

test('fresh draft survives a partial read only until its original lease expires',()=>{
  const state=new VoicePreviewLease();
  assert.deepEqual(state.observe(lease(),100900),{provider:'pocket'});
  for(const raw of ['',undefined,'{','x'.repeat(4097)])
    assert.deepEqual(state.observe(raw,103000),{provider:'pocket'});
  assert.equal(state.observe('',100000+VOICE_PREVIEW_MAX_AGE_MS+1),null);
});

test('same-second sequence orders selector, revert and reselect without accepting an old duplicate',()=>{
  const state=new VoicePreviewLease();state.observe(lease(),100000);
  assert.equal(state.observe(lease({active:false,sequence:2}),100000),null);
  assert.equal(state.observe(lease({sequence:1}),100000),null);
  assert.equal(state.observe(lease({sequence:2}),100000),null);
  assert.deepEqual(state.observe(lease({sequence:3,steps:16}),100000),{provider:'pocket'});
});

test('foreign or retired menu owners cannot cancel or revive a newer preview',()=>{
  const state=new VoicePreviewLease();state.observe(lease(),100000);
  const newer={owner:'mcm-session-two',updated:100001};
  assert.deepEqual(state.observe(lease(newer),100010),{provider:'pocket'});
  assert.deepEqual(state.observe(lease({active:false,sequence:4,updated:100002}),100010),{provider:'pocket'});
  assert.deepEqual(state.observe(lease({provider:'convai',sequence:5,updated:100003}),100010),{provider:'pocket'});
  assert.equal(state.observe(lease({...newer,sequence:2,active:false}),100020),null);
});

test('malformed, stale and excessively future settings never authorize model loading',()=>{
  for(const extra of [{version:2},{active:1},{owner:'x'},{sequence:0},{sequence:1.5},
    {provider:'other'},{updated:NaN},{updated:95000},{updated:102000}])
    assert.equal(new VoicePreviewLease().observe(lease(extra),100000),null);
  const state=new VoicePreviewLease();state.observe(lease(),100000);
  assert.equal(state.observe(lease({sequence:2,updated:99000,active:false}),100020)?.provider,'pocket');
  assert.equal(state.observe('',95000),null,'clock rollback cannot preserve a future lease');
});
