import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TEXT_PICTURE, VISION_NOTE, isImageRefusal, pictureForTurn, usableImages, withImages} from './vision-message.mjs';
import {LOCAL_VISION, imageReserveTokens, projectorNeedMiB} from './local-vision.mjs';
import {streamChat, VISION_MODELS, DEFAULT_MODELS} from './mistral-client.mjs';

const PICTURE = {mime: 'image/jpeg', base64: Buffer.from('street').toString('base64')};
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const conversation = [{role: 'system', content: 'You are Judy.'}, {role: 'user', content: 'earlier'}, {role: 'assistant', content: 'reply'}, {role: 'user', content: 'V says: what is that?'}];

test('withImages: the picture goes into the last user message only, ahead of its text, and the other messages are the very same objects', () => {
  const out = withImages(conversation, [PICTURE]);
  assert.notEqual(out, conversation, 'a copy');
  assert.deepEqual(out.slice(0, 3), conversation.slice(0, 3));
  for (let index = 0; index < 3; index++) assert.equal(out[index], conversation[index]);
  assert.equal(out[3].role, 'user');
  assert.deepEqual(out[3].content.map(part => part.type), ['image_url', 'text']);
  assert.equal(out[3].content[0].image_url.url, `data:image/jpeg;base64,${PICTURE.base64}`);
  assert.equal(out[3].content[1].text, `${VISION_NOTE}\n\nV says: what is that?`);
  assert.equal(conversation[3].content, 'V says: what is that?', 'the input is not changed');
});

test('withImages: nothing to send, or nowhere to put it, returns the messages as they were', () => {
  assert.equal(withImages(conversation, undefined), conversation);
  assert.equal(withImages(conversation, []), conversation);
  assert.equal(withImages(conversation, [{mime: 'text/plain', base64: 'AA=='}, {mime: 'image/jpeg', base64: ''}, null]), conversation, 'unusable pictures are not sent');
  const noUser = [{role: 'system', content: 'x'}];
  assert.equal(withImages(noUser, [PICTURE]), noUser);
  const parts = [{role: 'user', content: [{type: 'text', text: 'already parts'}]}];
  assert.equal(withImages(parts, [PICTURE]), parts, 'a message that is not plain text is left alone');
  assert.deepEqual(usableImages([PICTURE, PICTURE, PICTURE, PICTURE, PICTURE]).length, 4);
});

test('the note frames the picture as her own view, to use only when it matters, never as a screen, an image or an interface, and has no semicolon or dash', () => {
  assert.match(VISION_NOTE, /What you see around you right now, with your own eyes/);
  assert.match(VISION_NOTE, /only when V asks about it or it truly matters/);
  assert.match(VISION_NOTE, /floating over the view are not part of the place/);
  assert.match(VISION_NOTE, /indoors or outdoors/);
  assert.doesNotMatch(VISION_NOTE, /screen|image|picture|interface|game window|screenshot/i, 'no word that makes the view a thing V is looking at');
  assert.doesNotMatch(VISION_NOTE, /[;–—]|--/);
});

test('pictureForTurn: the view goes with a turn whose words are about the surroundings, and with no other', () => {
  for (const text of ['what do you think of this place', 'what do you see around here', 'look at that car', 'check this out', 'where are we', 'is it raining',
    "what's that over there", 'who is that guy', '¿qué ves aquí?', 'schau mal', 'ここはどこ']) assert.equal(pictureForTurn({text}), true, text);
  for (const text of ['hey there', 'like what you see', 'so hows life', 'how is biz', 'see you later', 'hey river, long time no see', 'you look really good today',
    'thanks', 'perhaps', 'i wouldnt mind coffe', 'how do i look', 'wakako sent me something, think i should take the job?', '', undefined]) assert.equal(pictureForTurn({text}), false, String(text));
  assert.equal(pictureForTurn(), false);
});

test('a refusal is a 400, 404, 413, 415 or 422 whose words are about images, vision, multimodal input or a content that must be a string', () => {
  for (const text of ['Image inputs are not supported by this model', 'this model does not support vision', 'multimodal content is not supported', 'messages.3.content: Input should be a valid string',
    'unknown variant `image_url`, expected `text`', 'content must be a string', 'Unsupported content type: image_url', 'expected a string']) {
    assert.equal(isImageRefusal(400, text), true, text);
  }
  assert.equal(isImageRefusal(422, 'image_url is not allowed'), true);
  assert.equal(isImageRefusal(415, 'unsupported media'), false, 'the words must say it');
  assert.equal(isImageRefusal(500, 'image input is not supported'), false, 'a server fault is not a refusal');
  assert.equal(isImageRefusal(429, 'image'), false);
  assert.equal(isImageRefusal(400, "Unsupported parameter: 'max_tokens'"), false);
  assert.equal(isImageRefusal(400, 'Invalid API key'), false);
  assert.equal(isImageRefusal(400, undefined), false);
});

test('the numbers the providers share: 768 px at quality 80, three Ministral models with vision, a projector costs its file and a compute buffer, and a picture keeps room in the prompt', () => {
  assert.deepEqual({...TEXT_PICTURE}, {maxWidth: 768, quality: 80});
  assert.equal(LOCAL_VISION.maxWidth, TEXT_PICTURE.maxWidth);
  assert.equal(LOCAL_VISION.quality, TEXT_PICTURE.quality);
  assert.deepEqual([...VISION_MODELS].sort(), [...DEFAULT_MODELS].sort(), 'every model the Mistral route asks is on the vision list: no model is swapped for a picture');
  assert.equal(projectorNeedMiB(560), 560 + LOCAL_VISION.computeHeadroomMiB);
  assert.equal(projectorNeedMiB(0), 0);
  assert.equal(imageReserveTokens(1), LOCAL_VISION.imageReserveTokens);
  assert.equal(imageReserveTokens(0), 0);
});

test('streamChat: images are sent as parts of the last user message, and a request without them is the request it always was', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Hi.'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`)); controller.close(); }})};
  };
  await streamChat({apiKey: KEY, messages: conversation, images: [PICTURE], fetchImpl});
  await streamChat({apiKey: KEY, messages: conversation, fetchImpl});
  assert.ok(Array.isArray(bodies[0].messages.at(-1).content));
  assert.deepEqual(bodies[0].messages.slice(0, 3), conversation.slice(0, 3));
  assert.deepEqual(bodies[1].messages, conversation);
});

test('streamChat: a 400 about images is sent again at once without them, once, and the caller is told; a 400 about something else is an error', async () => {
  const sent = [];
  const answer = (status, message) => ({ok: false, status, headers: new Headers(), json: async () => ({object: 'error', code: status, message})});
  const ok = () => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Fine.'}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`)); controller.close(); }})});
  const told = [];
  const result = await streamChat({apiKey: KEY, messages: conversation, images: [PICTURE], onImagesRejected: error => told.push(error.status), sleepImpl: async () => {},
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); sent.push(body.messages.some(message => Array.isArray(message.content))); return sent.length === 1 ? answer(400, 'Image inputs are not supported') : ok(); }});
  assert.equal(result.text, 'Fine.');
  assert.deepEqual(sent, [true, false]);
  assert.deepEqual(told, [400]);
  // A 400 that is about something else is not taken for a refusal of the picture.
  const other = [];
  await assert.rejects(streamChat({apiKey: KEY, messages: conversation, images: [PICTURE], onImagesRejected: () => other.push('told'), retries: 0, sleepImpl: async () => {},
    fetchImpl: async () => answer(400, 'This request is not valid')}), /request/i);
  assert.deepEqual(other, []);
});
