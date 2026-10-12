// The lip-sync model's convolution: the WebAssembly SIMD kernel (layers whose width is a multiple of 8) against the scalar loop.
// The repo's fixture models have no such layer, so this test is what exercises the SIMD path in the suite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conv, scalarConv} from './jali-face-model.mjs';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1; }
function randomLayer(random, out, inp, k) {
  return {weights: Float32Array.from({length: k * out * inp}, random), bias: Float32Array.from({length: out}, random), out, inp, k};
}

test('conv matches the scalar loop on layers the SIMD kernel takes (width a multiple of 8), with and without ReLU', () => {
  const random = rng(7);
  const cases = [
    {out: 8, inp: 3, k: 1, dilation: 1, rows: 1},
    {out: 16, inp: 23, k: 3, dilation: 1, rows: 9},
    {out: 32, inp: 80, k: 3, dilation: 4, rows: 30},
    {out: 160, inp: 160, k: 3, dilation: 8, rows: 61},
    {out: 160, inp: 80, k: 5, dilation: 2, rows: 18},
  ];
  for (const {out, inp, k, dilation, rows} of cases) {
    const layer = randomLayer(random, out, inp, k), input = Float32Array.from({length: rows * inp}, random);
    for (const relu of [false, true]) {
      const T = Math.max(0, rows - (k - 1) * dilation);
      const fast = new Float32Array(T * out).fill(NaN), slow = new Float32Array(T * out).fill(NaN);
      assert.equal(conv(input, rows, layer, dilation, fast, relu), T);
      assert.equal(scalarConv(input, rows, layer, dilation, slow, relu), T);
      let worst = 0;
      for (let i = 0; i < T * out; i++) worst = Math.max(worst, Math.abs(fast[i] - slow[i]));
      assert.ok(worst < 1e-3 * Math.sqrt(inp * k), `out ${out} inp ${inp} k ${k} relu ${relu}: max difference ${worst}`);
      if (relu) assert.ok(fast.every(value => value >= 0));
    }
  }
});

test('conv gives nothing for too few rows, and odd widths use the scalar loop exactly', () => {
  const random = rng(11);
  const wide = randomLayer(random, 16, 4, 3);
  assert.equal(conv(new Float32Array(2 * 4), 2, wide, 1, new Float32Array(0), false), 0);
  const odd = randomLayer(random, 23, 10, 3), input = Float32Array.from({length: 12 * 10}, random);
  const a = new Float32Array(10 * 23), b = new Float32Array(10 * 23);
  conv(input, 12, odd, 1, a, true); scalarConv(input, 12, odd, 1, b, true);
  assert.deepEqual(a, b);
});

test('a layer used again (the streaming face pushes 100 ms at a time) gives the same rows', () => {
  const random = rng(3);
  const layer = randomLayer(random, 24, 12, 3), input = Float32Array.from({length: 20 * 12}, random);
  const first = new Float32Array(18 * 24), second = new Float32Array(18 * 24);
  conv(input, 20, layer, 1, first, false);
  conv(input, 20, layer, 1, second, false);
  assert.deepEqual(first, second);
});
