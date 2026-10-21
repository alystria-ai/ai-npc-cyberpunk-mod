// Graphics card vendors, from the card names the bridge already reads (bridge/setup-check.mjs cachedGraphicsCards: [{name, memoryMiB}]).
// Names only: the vendor word of each card, never a name, a memory size or anything else of the PC. Pure.
const VENDORS = [
  ['nvidia', /nvidia|geforce|quadro|tesla|titan|\b(?:rtx|gtx)\b/i],
  ['amd', /\bamd\b|radeon|\bati\b|\brx\s?\d/i],
  ['intel', /\bintel\b|\buhd\b|\biris\b|\barc\b/i],
];
// Display adapters that are not graphics cards (a headset's virtual monitor, a remote-desktop or streaming display, Windows' basic renderer):
// they say nothing about the PC's card and must not hide an AMD or Intel one from the check below.
const VIRTUAL = /virtual|remote display|basic (?:render|display)|parsec|displaylink|indirect display|idd/i;
/** The vendors of the cards, each once, in card order: 'nvidia', 'amd', 'intel' or 'other'. [] when the list is missing or empty. */
export function gpuVendors(cards) {
  const found = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const name = String(card?.name ?? '');
    if (!name.trim() || VIRTUAL.test(name)) continue;
    const vendor = VENDORS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other';
    if (!found.includes(vendor)) found.push(vendor);
  }
  return found;
}
/**
 * True only when the PC is known to have no NVIDIA card (OmniVoice needs CUDA): at least one card, and every one is a known other vendor. An empty
 * list (not read yet, or nothing found) and a card of an unrecognised name claim nothing.
 */
export const lacksNvidia = vendors => Array.isArray(vendors) && vendors.length > 0 && vendors.every(vendor => vendor === 'amd' || vendor === 'intel');
