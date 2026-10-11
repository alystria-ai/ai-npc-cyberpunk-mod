// The text of app/defaults/service.txt: the project's Convai key, scrambled by the source tree's own codec
// (bridge/key-codec.mjs) so the runtime that ships decodes exactly what was packed. Never printed or logged.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function packagedKeyText(sourceRoot, key) {
  const codec = await import(pathToFileURL(resolve(sourceRoot, 'bridge/key-codec.mjs')).href);
  const packed = codec.packKey(key);
  // A bad pack must never ship: it has to decode to the same key and hold no plain copy of it.
  if (codec.readKeyFileText(packed)?.key !== key || packed.includes(key) || /api-key/i.test(packed)) {
    throw Error('The packaged Convai key did not round-trip (value not shown).');
  }
  return packed;
}
