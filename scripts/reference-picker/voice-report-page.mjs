// Read-only route for the "Voice report v3" (built by scripts/clip-search/build_page.py), the picker's front page.
//   GET /  and  GET /v3/   serve <root>/index.html          (/v3 redirects to /v3/)
//   GET /audio/<column>/<file>.wav  and  /v3/audio/<column>/<file>.wav   serve the renders next to it
// The root comes from the environment variable V3_REPORT_ROOT (default below). Nothing here writes, and only index.html and
// .wav files inside the root can be read. While the report has not been built, "/" shows a short notice instead.
import {createReadStream, existsSync, statSync} from 'node:fs';
import {resolve, sep} from 'node:path';

export const V3_REPORT_ROOT = process.env.V3_REPORT_ROOT ?? 'E:\CyberpunkConvai-offload\work\voice-report-v3';
const PREFIX = '/v3';
const TYPES = {'.html': 'text/html; charset=utf-8', '.wav': 'audio/wav'};
const NOTICE = '<!doctype html><meta charset="utf-8"><title>Voice report</title><body style="font:16px system-ui;margin:2em">'
  + '<h1>Voice report v3 has not been built yet</h1><p>Build it with <code>scripts/clip-search/build_page.py</code>; this page then shows it.</p>'
  + '<p>A character\'s own page is at <code>/voice/&lt;key&gt;</code>.</p></body>';

// The picker's own audio routes have three or more segments after /audio (clip, line, live, sample), so a two-segment
// /audio/<column>/<file>.wav can only be the report's audio (the report is served at "/", so its relative links land here).
const reportAudio = path => /^\/audio\/[^/]+\/[^/]+\.wav$/i.test(path);
export const isV3Path = path => path === '/' || path === PREFIX || path.startsWith(`${PREFIX}/`) || reportAudio(path);

// Returns true when it handled the request (including a 404), so the caller can simply return.
export function serveV3(request, response, path, root = V3_REPORT_ROOT) {
  const notFound = () => { response.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'}); response.end('Not found'); return true; };
  if (path === PREFIX) { response.writeHead(302, {location: `${PREFIX}/`}); response.end(); return true; }
  const relative = path === '/' || path === `${PREFIX}/` ? 'index.html' : path.startsWith(`${PREFIX}/`) ? path.slice(PREFIX.length + 1) : path.slice(1);
  if (relative.includes('\0') || relative.includes('\\') || relative.split('/').includes('..')) return notFound();
  const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
  if (!TYPES[extension] || (extension === '.html' && relative !== 'index.html')) return notFound();
  const base = resolve(root), file = resolve(base, relative);
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) {
    if (relative !== 'index.html') return notFound();
    response.writeHead(200, {'content-type': TYPES['.html'], 'cache-control': 'no-store'});
    response.end(request.method === 'HEAD' ? undefined : NOTICE);
    return true;
  }
  response.writeHead(200, {'content-type': TYPES[extension], 'content-length': statSync(file).size, 'cache-control': 'no-store'});
  if (request.method === 'HEAD') { response.end(); return true; }
  createReadStream(file).pipe(response);
  return true;
}
