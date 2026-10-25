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

// A discrete-looking AMD card: a model name of the RX/Pro/Instinct families, or a memory size no integrated Radeon reports (those take 0.5 to 4 GB of shared memory, and the
// 32-bit registry value stops at 4 GiB). 'AMD Radeon(TM) Graphics' with a small or unknown size is an integrated one.
const AMD_DISCRETE_NAME = /\brx\s?\d{3,4}|radeon\s+pro|radeon\s+vii|instinct|\bpro\s+w\d/i;
const AMD_DISCRETE_MIB = 6_000;
/**
 * True when OmniVoice's AMD route (docs/OMNIVOICE_AMD.md, the player's own Python with ROCm PyTorch) applies: a discrete-looking AMD Radeon card and no NVIDIA card at all.
 * Mixed NVIDIA + AMD stays on the NVIDIA route; an Intel or AMD integrated-only PC, an unrecognised name or an empty list claim nothing. Pure.
 */
export function amdRoute(cards) {
  const list = Array.isArray(cards) ? cards : [];
  if (gpuVendors(list).includes('nvidia')) return false;
  return list.some(card => {
    if (!gpuVendors([card]).includes('amd')) return false;
    const memory = Number(card?.memoryMiB);
    return AMD_DISCRETE_NAME.test(String(card?.name ?? '')) || (Number.isFinite(memory) && memory >= AMD_DISCRETE_MIB);
  });
}

// OmniVoice beside the game and Local AI needs about 12 GB of graphics memory (docs: an 8 GB card times out, 2026-10-22 reports of an RTX 4060 Ti 8 GB: the voice worker held
// 2,036 MiB on the card and 518 MiB in shared system memory when its preparation ran out of time). Cards report a little under their nominal size (8,188 MiB for 8 GB, 12,282 for 12 GB).
export const OMNI_CARD_MIB = Object.freeze({
  small: 9_000,    // a card under this ("8 GB or less") cannot hold OmniVoice beside the game: a timeout is read as too little graphics memory
  needed: 11_000,  // a card under this is shown the "needs 12 GB" hint
});
/** The memory (MiB) of the largest NVIDIA card in the list (the one OmniVoice's CUDA uses), or null when there is none or its size is not known. Pure. */
export function nvidiaCardMiB(cards) {
  let best = null;
  for (const card of Array.isArray(cards) ? cards : []) {
    const memory = Number(card?.memoryMiB);
    if (!Number.isFinite(memory) || memory <= 0 || !gpuVendors([card]).includes('nvidia')) continue;
    if (best === null || memory > best) best = Math.round(memory);
  }
  return best;
}
/** True only for a known card size under what OmniVoice needs. Unknown (null) claims nothing. */
export const underNeeded = miB => Number.isFinite(miB) && miB > 0 && miB < OMNI_CARD_MIB.needed;
/** True only for a known card of 8 GB or less. */
export const isSmallCard = miB => Number.isFinite(miB) && miB > 0 && miB < OMNI_CARD_MIB.small;
