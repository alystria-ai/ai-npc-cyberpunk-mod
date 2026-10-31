// Is the Runtime base older than the Scripts need? (0.4.0 report 1478846d, 22c04416, 814af683: Scripts 0.4.0 were put over a Runtime base 0.3.2 and the Pocket worker, which
// runs the base's own Python and torch with the new code, died three times with an access violation.)
//
// The Scripts' release.json names the oldest base they run on (`runtimeBase`, packaging/build-release.mjs); the Runtime's release.json is the base's version. This reads both
// once, with no process and no network, and answers {runtime, required, scripts} when the base is older, else null. A Runtime or Scripts without the numbers (a development
// checkout, a release.json from before 0.3.4) claims nothing. The same comparison as the setup check's `base-old` row (bridge/setup-check.mjs), so the Help page and the voice agree.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {versionOrder} from './setup-check.mjs';

const read = path => { try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const word = value => (typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,39}$/.test(value.trim()) ? value.trim() : null);

/** `project` is the Runtime's app/ folder, `modRoot` the CET mod folder of the Scripts. Never throws. */
export function runtimeBaseOld({project, modRoot} = {}) {
  try {
    if (!project || !modRoot) return null;
    const scripts = read(join(modRoot, 'release.json')), runtime = read(join(project, 'release.json'));
    const required = word(scripts?.runtimeBase), have = word(runtime?.version);
    if (!required || !have) return null;
    return versionOrder(have, required) < 0 ? {runtime: have, required, scripts: word(scripts?.version)} : null;
  } catch { return null; }
}
