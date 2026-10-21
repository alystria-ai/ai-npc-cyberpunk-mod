import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gpuVendors, lacksNvidia} from './gpu-vendors.mjs';

const card = name => ({name, memoryMiB: 8192});

test('gpuVendors names the vendor of each card once, in card order, and nothing else', () => {
  assert.deepEqual(gpuVendors([card('NVIDIA GeForce RTX 4070 Laptop GPU'), card('Intel(R) UHD Graphics')]), ['nvidia', 'intel']);
  assert.deepEqual(gpuVendors([card('AMD Radeon RX 7600'), card('AMD Radeon(TM) Graphics')]), ['amd']);
  assert.deepEqual(gpuVendors([card('Intel(R) Arc(TM) A770 Graphics')]), ['intel']);
  assert.deepEqual(gpuVendors([card('Radeon RX 6700 XT'), card('GeForce GTX 1060 6GB')]), ['amd', 'nvidia']);
  assert.deepEqual(gpuVendors([card('Quadro P2200'), card('NVIDIA T400')]), ['nvidia']);
  assert.deepEqual(gpuVendors([card('Microsoft Basic Display Adapter'), card('Parallels Display Adapter')]), ['other']);
  const result = gpuVendors([card('AMD Radeon RX 7600')]);
  assert.ok(result.every(item => ['nvidia', 'amd', 'intel', 'other'].includes(item)), 'only vendor words, never a card name');
});

test('gpuVendors reads nothing usable as an empty list and never throws', () => {
  for (const value of [undefined, null, 'x', 7, {}, [], [null], [{}], [{name: ''}], [{name: '  '}], [{name: 5}]]) {
    assert.doesNotThrow(() => gpuVendors(value));
  }
  assert.deepEqual(gpuVendors(undefined), []);
  assert.deepEqual(gpuVendors([null, {name: ''}]), []);
});

test('a virtual display adapter is not a card', () => {
  assert.deepEqual(gpuVendors([{name: 'AMD Radeon RX 7600'}, {name: 'Meta Virtual Monitor'}, {name: 'Microsoft Basic Render Driver'}]), ['amd']);
  assert.equal(lacksNvidia(gpuVendors([{name: 'AMD Radeon RX 7600'}, {name: 'Meta Virtual Monitor'}])), true);
});

test('lacksNvidia claims it only for a known list of AMD or Intel cards', () => {
  assert.equal(lacksNvidia(['amd']), true);
  assert.equal(lacksNvidia(['intel', 'amd']), true);
  assert.equal(lacksNvidia(['amd', 'nvidia']), false);
  assert.equal(lacksNvidia(['nvidia']), false);
  assert.equal(lacksNvidia(['other']), false, 'a card of an unknown name claims nothing');
  assert.equal(lacksNvidia(['intel', 'other']), false);
  assert.equal(lacksNvidia([]), false, 'an empty or unread list claims nothing');
  assert.equal(lacksNvidia(null), false);
  assert.equal(lacksNvidia(undefined), false);
});
