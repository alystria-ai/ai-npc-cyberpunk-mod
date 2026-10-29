// The file list of a zip worked out from the zip itself: [{path, bytes, sha256}], the rows of the build's <name>.files.json. Used by
// packaging/test-release-install.mjs when a package folder holds a zip without its list (packaging/lib/install-test-plan.mjs, listingSource).
// Every entry is read and checked against its CRC-32 on the way (entryChunks), so a damaged zip fails here and not silently.
import {createHash} from 'node:crypto';
import {listZip} from './zip.mjs';
import {entryChunks} from './zip-entry.mjs';

export async function zipListing(zip) {
  const rows = [];
  for (const entry of await listZip(zip)) {
    if (entry.name.endsWith('/')) continue;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of entryChunks(zip, entry)) { hash.update(chunk); bytes += chunk.length; }
    rows.push({path: entry.name, bytes, sha256: hash.digest('hex')});
  }
  return rows;
}
