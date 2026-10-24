// Memory namespaces of the text providers (Local AI, Mistral, Custom): a content pack (add-on API 1.1, bridge/addon-content.mjs) whose manifest says
// `content.memory: "separate"` gives the characters a memory of their own while it is on. A character's memory key is then `<profileKey>@<pack id>`
// ("judy@medieval") instead of "judy", in every per-character store the text providers keep (bridge/memory-store.mjs, bridge/vendor-memory.mjs).
// Switching the pack off goes back to the normal keys, which were never touched; switching it on again finds the pack's memory where it was left.
// Nothing is migrated, copied or deleted by a switch. Convai's own memory (bridge/player-memory.mjs) is not part of this: a pack's Convai twins have ids of their own.
//
// The one place that maps a key is `memoryScopes(content).keyFor`. A turn (or a summary) takes its key once, when it starts, and uses it to the end,
// so a switch in the middle of one never lets it write into the other memory.
// An add-on's speaker ("addon-...") and a character the player made ("custom-...") are never namespaced: a pack changes the mod's own characters.

/** A pack id as the add-on manifest allows it (bridge/addons.mjs ADDON_ID). */
export const SCOPE_ID = /^[a-z][a-z0-9-]{1,23}$/;
/** A memory key: a profile key, then optionally `@<pack id>`. '@' is safe in a Windows file name, and the pattern allows no dot, slash or other separator. */
export const MEMORY_KEY = /^[a-z0-9][a-z0-9-]{0,79}(?:@[a-z][a-z0-9-]{1,23})?$/;
/** A character file of the memory store: `<key>.json`. */
export const MEMORY_FILE_NAME = /^([a-z0-9][a-z0-9-]{0,79}(?:@[a-z][a-z0-9-]{1,23})?)\.json$/;
const FILE_SCOPE = /^[a-z0-9][a-z0-9-]{0,79}@([a-z][a-z0-9-]{1,23})\.json(?:\.corrupt)?$/;
const AMBIENT_MARK = '\u0000';

/** The pack a memory key belongs to, or '' for the normal memory. */
export const scopeOf = key => {
  const at = typeof key === 'string' ? key.indexOf('@') : -1;
  return at < 0 ? '' : key.slice(at + 1);
};
/** The profile key inside a memory key ("judy@medieval" -> "judy"). */
export const baseOf = key => {
  const at = typeof key === 'string' ? key.indexOf('@') : -1;
  return at < 0 ? key : key.slice(0, at);
};
/** The pack a character file in the store's folder belongs to ('' for the normal memory and for any file that is not a pack's). */
export const fileScope = name => FILE_SCOPE.exec(String(name))?.[1] ?? '';

/** The key an ordinary NPC's in-memory conversation is kept under, so a pack's conversations and the normal ones stay apart (and Forget can tell them apart). */
export const ambientId = (profileKey, ambientKey) => {
  const scope = scopeOf(profileKey);
  return scope ? `${ambientKey}${AMBIENT_MARK}${scope}` : ambientKey;
};
/** Does this in-memory conversation key belong to the pack ('' = the normal memory)? */
export const ambientIn = (id, scope) => {
  const at = String(id).lastIndexOf(AMBIENT_MARK);
  return (at < 0 ? '' : id.slice(at + 1)) === (scope || '');
};

/**
 * The keys to drop so that no memory (the normal one, or one pack's) holds more than `limit` characters: the least recently updated of a memory that is over.
 * Each memory has its own limit, so a pack's talks never push the normal ones out. `rows` is a Map of key -> {updated}.
 */
export function overflowing(rows, limit) {
  if (rows.size <= limit) return [];   // the common case: nothing is over, whatever the groups
  const groups = new Map();
  for (const entry of rows) {
    const scope = scopeOf(entry[0]);
    if (groups.has(scope)) groups.get(scope).push(entry); else groups.set(scope, [entry]);
  }
  const drop = [];
  for (const list of groups.values()) {
    if (list.length <= limit) continue;
    list.sort((a, b) => a[1].updated - b[1].updated);
    for (const [key] of list.slice(0, list.length - limit)) drop.push(key);
  }
  return drop;
}

/** May a profile key be namespaced? Add-on speakers and the player's own characters never are. */
export const namespacable = profileKey => typeof profileKey === 'string' && !profileKey.startsWith('addon-') && !profileKey.startsWith('custom-');

/**
 * The mapping for one AddonContent (bridge/addon-content.mjs):
 *   scope()          the id of the pack whose separate memory is in use, or null (a plain value after the first call until a pack is switched)
 *   keyFor(key)      the memory key of a character now: `key`, or `<key>@<id>`
 *   packName()       the display name of that pack, or null
 */
export function memoryScopes(content) {
  let seen = NaN, scope = null;
  const current = () => {
    if (!content || typeof content.memoryScope !== 'function' || content.installed === false) return null;
    const version = content.version;
    if (Number.isFinite(version) && version === seen) return scope;
    seen = Number.isFinite(version) ? version : NaN;
    scope = content.memoryScope() ?? null;
    return scope;
  };
  return {
    scope: current,
    keyFor: profileKey => {
      const id = current();
      return id && namespacable(profileKey) && typeof profileKey === 'string' && !profileKey.includes('@') ? `${profileKey}@${id}` : profileKey;
    },
    packName: () => {
      const id = current();
      return id ? (content.list?.().find(pack => pack.id === id)?.name ?? id) : null;
    },
  };
}

const VIEW_METHODS = ['recall', 'record', 'retrieve', 'pendingSummary', 'beginSummary', 'applySummary', 'failSummary', 'listRecords', 'deleteRecord', 'editRecord', 'setSummary', 'pinRecord'];
/**
 * The memory store as one operation sees it: every call that names a character is mapped through `keyFor` as it is made. The character editor reads the memory this way
 * (it shows and edits the memory in use), and Forget from the editor acts on the same one. A turn does not use this: it takes its key once (TextProviderHost memoryKeyFor).
 */
export function scopedMemory(memory, keyFor) {
  if (!memory) return memory;
  const map = args => args.length && args[0] !== null && typeof args[0] === 'object' ? [{...args[0], profileKey: keyFor(args[0].profileKey)}, ...args.slice(1)]
    : args.length ? [keyFor(args[0]), ...args.slice(1)] : args;
  const view = {};
  for (const name of VIEW_METHODS) if (typeof memory[name] === 'function') view[name] = (...args) => memory[name](...map(args));
  Object.defineProperty(view, 'learns', {get: () => memory.learns, enumerable: true});
  view.forget = (scope = {}) => memory.forget({...scope, ...(Array.isArray(scope.profileKeys) ? {profileKeys: scope.profileKeys.map(keyFor)} : {})});
  return view;
}
