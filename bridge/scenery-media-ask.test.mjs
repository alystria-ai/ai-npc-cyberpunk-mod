// The music and TV line comes again when V's words ask about it (live 2026-10-25: told once, gone on the next turn, so "what song is this?" got nothing).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SceneryMemory} from './scenery-memory.mjs';

test('the media line is told on the first turn and a change, and again when V asks about the song, the radio or the TV', () => {
  const memory = new SceneryMemory();
  const media = (id, text, signal = 'r:car|Growl FM|Rebel Path') => memory.decide({key: 'talk|alex', id, weather: 'clear', part: 'day', text, signals: {media: signal}}).media;
  assert.equal(media('1', 'hello'), true);
  assert.equal(media('2', 'how are you'), false);
  assert.equal(media('3', 'what song is this?'), true);
  assert.equal(media('4', 'nice'), false);
  assert.equal(media('5', 'who sings it', 'r:car|Growl FM|Rebel Path'), true);
  assert.equal(media('6', 'ok', 'r:car|Growl FM|Another Song'), true, 'a new song is new');
  assert.equal(media('7', 'что за музыка'), true);
});
