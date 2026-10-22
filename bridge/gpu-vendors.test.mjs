import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gpuVendors, isSmallCard, lacksNvidia, nvidiaCardMiB, underNeeded} from './gpu-vendors.mjs';

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

test('nvidiaCardMiB: the memory of the largest NVIDIA card, no other vendor, no virtual display, null when unknown', () => {
  assert.equal(nvidiaCardMiB([{name: 'NVIDIA GeForce RTX 4060 Ti', memoryMiB: 8188}]), 8188);
  assert.equal(nvidiaCardMiB([{name: 'Intel(R) UHD Graphics', memoryMiB: 128}, {name: 'NVIDIA GeForce RTX 4070 Laptop GPU', memoryMiB: 8188}]), 8188, 'a hybrid laptop: the NVIDIA card');
  assert.equal(nvidiaCardMiB([{name: 'NVIDIA GeForce RTX 3060', memoryMiB: 12288}, {name: 'NVIDIA GeForce GTX 1050', memoryMiB: 4096}]), 12288);
  assert.equal(nvidiaCardMiB([{name: 'AMD Radeon RX 7800 XT', memoryMiB: 16368}]), null, 'not NVIDIA: OmniVoice does not use it');
  assert.equal(nvidiaCardMiB([{name: 'NVIDIA GeForce RTX 4060 Ti', memoryMiB: null}]), null, 'a size that was not read');
  assert.equal(nvidiaCardMiB([{name: 'Virtual Display NVIDIA', memoryMiB: 16000}]), null);
  assert.equal(nvidiaCardMiB(null), null); assert.equal(nvidiaCardMiB([]), null);
});

test('isSmallCard (8 GB or less) and underNeeded (under 12 GB) read only a known size; the usual reported sizes fall on the right side', () => {
  for (const size of [4096, 6144, 8188, 8192]) assert.equal(isSmallCard(size), true, String(size));
  for (const size of [10240, 11264, 12282, 12288, 16384, 24576]) assert.equal(isSmallCard(size), false, String(size));
  for (const size of [8188, 10240]) assert.equal(underNeeded(size), true, String(size));
  for (const size of [11264, 12282, 12288, 16384]) assert.equal(underNeeded(size), false, String(size));
  for (const unknown of [null, undefined, 0, NaN]) assert.deepEqual([isSmallCard(unknown), underNeeded(unknown)], [false, false]);
});
