// Read-only route for the "Natural speech test" listening page (built by scripts/natural-speech/build-page.py).
// GET /natural-speech/ serves <root>/index.html and /natural-speech/audio/<engine>/<file>.wav the renders next to it.
// Nothing here writes, and only index.html and .wav files inside <root> can be read.
import {createReadStream, existsSync, statSync} from 'node:fs';
import {resolve, sep} from 'node:path';

export const NATURAL_SPEECH_ROOT = process.env.NATURAL_SPEECH_PAGE ?? 'E:\\CyberpunkConvai-offload\\work\\natural-speech\\page';
const PREFIX = '/natural-speech';
const TYPES = {'.html': 'text/html; charset=utf-8', '.wav': 'audio/wav'};

export const isNaturalSpeechPath = path => path === PREFIX || path.startsWith(`${PREFIX}/`);

// Returns true when it handled the request (including a 404), so the caller can simply return.
export function serveNaturalSpeech(request, response, path, root = NATURAL_SPEECH_ROOT) {
  const notFound = () => { response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'}); response.end('Not found'); return true; };
  if (path === PREFIX) { response.writeHead(302, {location: `${PREFIX}/`}); response.end(); return true; }
  const relative = path.slice(PREFIX.length + 1) || 'index.html';
  if (relative.includes('\0') || relative.includes('\\')) return notFound();
  const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
  if (!TYPES[extension]) return notFound();
  const base = resolve(root), file = resolve(base, relative);
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound();
  response.writeHead(200, {'content-type': TYPES[extension], 'content-length': statSync(file).size, 'cache-control': 'no-store'});
  if (request.method === 'HEAD') { response.end(); return true; }
  createReadStream(file).pipe(response);
  return true;
}
