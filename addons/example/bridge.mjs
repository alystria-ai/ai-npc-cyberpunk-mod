// Bridge side of the example add-on (docs/ADDON_API.md, "Bridge module"). Optional: without it the add-on still works, with
// the main mod's default trigger and a plain facts block. Every hook is synchronous, quick and side-effect free.
export const apiVersion = '1.0';

let log = () => {};

/** Called once when the bridge starts. `api` is frozen: {version, addon, log, settings(), state()}. */
export function activate(api) {
  log = api.log;
  log('Echo bridge module active');
}

/** Extra prompt blocks for Echo's own turns. `event` is set for a remark, null for a conversation. */
export function speakerBlocks({event, facts}) {
  if (event === 'combat-start') return [{key: 'combat', tier: 'volatile', text: 'A fight has just started. You hear it through V\'s audio; you cannot see it.'}];
  if (event === 'fight-end') return [{key: 'combat', tier: 'volatile', text: `The fight is over. It lasted about ${facts?.seconds ?? '?'} seconds.`}];
  return [];
}

/** Extra prompt blocks for every companion's turns. Echo adds none. */
export function companionBlocks() {
  return [];
}

/** A line Echo just said: return a memory to keep (a callback for later fights), or nothing. */
export function remember({event, line}) {
  return event === 'fight-end' ? `After a fight Echo said: "${line}"` : null;
}
