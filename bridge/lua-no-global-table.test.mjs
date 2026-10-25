// CET runs this mod's Lua in an environment that has no _G: rawget(_G, ...) and rawset(_G, ...) throw there ("table expected, got nil").
// Live 2026-10-25: that stopped housemates on every tick and left the immersive-invitation phone hooks unset. Globals of the mod are read
// and written bare; the one tolerated form guards the table first (`type(_G)=='table' and rawget(_G, ...)`). Not run in the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const dir = new URL('../mod/', import.meta.url);
// diagnostics.lua is a developer-only probe that is never installed.
const files = readdirSync(dir).filter(name => name.endsWith('.lua') && name !== 'diagnostics.lua');

test('no mod Lua file indexes _G without checking that it exists', () => {
  const hits = [];
  for (const name of files) {
    readFileSync(new URL(name, dir), 'utf8').split(/\r?\n/).forEach((line, index) => {
      const code = line.replace(/--.*$/, '');
      if (/raw(?:get|set)\s*\(\s*_G\b/.test(code) && !/type\(\s*_G\s*\)\s*==\s*'table'\s*and\s+rawget\(/.test(code)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
