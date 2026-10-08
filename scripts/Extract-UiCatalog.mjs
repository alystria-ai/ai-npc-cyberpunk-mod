/**
 * Deterministic developer UI catalogue. This is not a source-code translator.
 * Only reviewed UI call arguments and explicit literals below are admitted.
 * Run: node scripts/Extract-UiCatalog.mjs [--check] [--summary]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'mod/mcm.lua', 'mod/manager.lua', 'mod/manager-party.lua', 'mod/init.lua', 'mod/auto-connect.lua',
  'mod/companions.lua', 'mod/companion-vehicles.lua', 'mod/companion-vehicle-native.lua', 'mod/companion-chauffeur.lua',
  'mod/companion-chauffeur-native.lua', 'mod/gameplay-actions.lua', 'mod/companion-adoption.lua',
  'mod/companion-clearance.lua', 'mod/companion-placement.lua',
  'mod/phone-chat.lua', 'mod/phone-chat-style.lua', 'mod/phone-input.lua',
  'mod/composer-input.lua', 'mod/microphone.lua', 'mod/service-status.lua', 'mod/support-report.lua',
  'r6/scripts/CyberpunkConvai/Composer.reds',
  'r6/scripts/CyberpunkConvai/PhoneContacts.reds',
  'r6/scripts/CyberpunkConvai/PhoneChat.reds',
  'r6/scripts/CyberpunkConvai/PhoneChatTabs.reds',
  'r6/scripts/CyberpunkConvai/Manager.reds',
];

// Small, non-evaluating Lua/redscript lexer. Comments and native resource/name
// literals never become UI candidates. Locations refer to the original file.
export function lex(source, file) {
  const tokens = [];
  let offset = 0, line = 1;
  const consume = end => {
    line += (source.slice(offset, end).match(/\n/g) || []).length;
    offset = end;
  };
  const longBracket = start => {
    const open = /^\[(=*)\[/.exec(source.slice(start));
    if (!open) return null;
    const close = `]${open[1]}]`;
    const end = source.indexOf(close, start + open[0].length);
    if (end < 0) throw new Error(`${file}:${line}: unterminated long string/comment`);
    return { value: source.slice(start + open[0].length, end).replace(/^\r?\n/, ''), end: end + close.length };
  };
  while (offset < source.length) {
    const char = source[offset];
    if (/\s/.test(char)) { consume(offset + 1); continue; }
    const lua = file.endsWith('.lua');
    if ((lua && source.startsWith('--', offset)) || (!lua && source.startsWith('//', offset))) {
      const block = lua && longBracket(offset + 2);
      consume(block ? block.end : (source.indexOf('\n', offset) < 0 ? source.length : source.indexOf('\n', offset)));
      continue;
    }
    if (!lua && source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw new Error(`${file}:${line}: unterminated block comment`);
      consume(end + 2); continue;
    }
    if (lua && char === '[') {
      const long = longBracket(offset);
      if (long) { tokens.push({ kind: 'string', value: long.value, line }); consume(long.end); continue; }
    }
    if (char === '"' || (lua && char === "'")) {
      const quote = char, startLine = line;
      let end = offset + 1, value = '';
      while (end < source.length && source[end] !== quote) {
        if (source[end] !== '\\') { value += source[end++]; continue; }
        const escaped = source[++end];
        const basic = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', "'": "'", '"': '"' };
        if (Object.hasOwn(basic, escaped)) { value += basic[escaped]; end++; }
        else if (/\d/.test(escaped)) {
          const digits = /^\d{1,3}/.exec(source.slice(end))[0]; value += String.fromCharCode(Number(digits)); end += digits.length;
        } else if (escaped === 'x' && /^[\da-f]{2}/i.test(source.slice(end + 1))) {
          value += String.fromCharCode(parseInt(source.slice(end + 1, end + 3), 16)); end += 3;
        } else if (escaped === '\n') { value += '\n'; end++; }
        else if (escaped === 'z' && lua) { end++; while (/\s/.test(source[end] || '') && end < source.length) end++; }
        else { value += escaped; end++; }
      }
      if (end >= source.length) throw new Error(`${file}:${startLine}: unterminated string`);
      const previous = tokens[tokens.length - 1];
      const native = !lua && previous?.kind === 'identifier' && ['n', 'r', 't', 's'].includes(previous.value)
        && source[offset - 1] === previous.value;
      tokens.push({ kind: native ? 'native' : 'string', value, line: startLine });
      consume(end + 1); continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(offset));
    if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0], line }); consume(offset + identifier[0].length); continue; }
    const symbol = source.startsWith('..', offset) ? '..' : char;
    tokens.push({ kind: 'symbol', value: symbol, line }); consume(offset + symbol.length);
  }
  return tokens;
}

function argumentsAt(tokens, start) {
  const args = [[]], stack = [];
  const close = { '(': ')', '[': ']', '{': '}' };
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index], value = token.value;
    if (token.kind === 'symbol') {
      if (!stack.length && value === ')') return args;
      if (!stack.length && value === ',') { args.push([]); continue; }
      if (close[value]) stack.push(close[value]);
      else if (value === stack.at(-1)) stack.pop();
    }
    args.at(-1).push(token);
  }
  return [];
}

function staticText(tokens) {
  if (!tokens?.length) return null;
  if (tokens.length === 1 && tokens[0].kind === 'string') return tokens[0].value;
  // Known UI translators are transparent to extraction. Only the source key
  // is catalogued; placeholder values never become strings to translate.
  const qualified = tokens[0]?.value === 'ui' && tokens[1]?.value === '.' && tokens[2]?.value === 't' && tokens[3]?.value === '(';
  const phoneAlias = tokens[0]?.value === 'text' && tokens[1]?.value === '(';
  if (qualified || phoneAlias) {
    const args = argumentsAt(tokens, qualified ? 3 : 1);
    if (args[0]?.length === 1 && args[0][0].kind === 'string') return args[0][0].value;
  }
  if (tokens.every((token, index) => index % 2 === 0 ? token.kind === 'string' : token.value === '..')) {
    return tokens.filter(token => token.kind === 'string').map(token => token.value).join('');
  }
  return null;
}

// These allowlists cover alternative labels and stored feedback whose final
// sink is indirect. Each item must still exist as an exact source literal.
const reviewed = {
  'mcm.navigation': [
    'Companion Manager', 'Characters', 'Current party', 'Model browser', 'Settings', 'Selected', 'Open',
    'Your companions, character models and conversation settings.',
    'Invite characters, manage your group, browse game models and configure conversations.',
  ],
  'mcm.voice-status': [
    'Convai voice', 'On', 'Off', 'Ready', 'Loading', 'Preparing voices', 'Preparing a reply',
    'Unavailable', 'Waiting for voice service', 'Not configured', 'Stopped',
    'Releasing local voice memory', 'Convai voices · Local model unloaded',
    'Changing after the current reply', 'Ready · Unsaved selection',
    'OmniVoice · Balanced', 'OmniVoice · Quality', 'OmniVoice · High Quality', 'OmniVoice · Ultra Quality',
    'Installed', 'Not installed',
  ],
  'mcm.memory': [
    'Choose a character', 'Unavailable', 'Memories can be managed here.',
    'Reopen this page after the memory service reconnects. A pending clear keeps waiting for its own result.',
    'Choose a character before clearing their memories about you.',
    'Your player identity stays the same. Matching Phone Chat messages and drafts are also cleared.',
  ],
  'mcm.relationships': [
    'Auto', 'Romantic', 'Casual', 'Ordinary',
    'Auto follows the completed encounter in this save. Casual uses the casual profile; Ordinary uses the ordinary profile. This does not imply an ongoing relationship.',
    'Auto follows the relationship in this save. Romantic uses the romantic profile; Ordinary uses the ordinary profile. This changes conversations without changing game choices.',
  ],
  'mcm.party': [
    'Invite', 'Profile only', 'Dismiss', 'Cancel invitation',
    'Remove only this copy from your group.',
  ],
  'mcm.models': [
    'Reading installed models…',
    'No conversation profile. This model joins as a follower without AI conversations.',
    'Some game models have special rigs or roles and may not behave as ordinary companions.',
  ],
  'mcm.validation': [
    'Reopen the manager; that action is no longer available.', 'Choose one of the listed subtitle displays.',
    'Choose one of the listed companion voices.', 'Requires the optional OmniVoice pack (GPU)', 'Choose 16 or 32 voice steps.',
    'Choose a short or a long voice reference.', 'Choose an eye contact option.', 'That setting is read-only.',
  ],
  'memory.feedback': [
    'all characters you have talked to', 'the selected character',
    'A previous memory request could not be read. The memory service must reconcile it before another clear.',
    'Review the memory clear below, then choose Confirm or Cancel.', 'Memory clear cancelled. Nothing was deleted.',
    'Character picker closed. Your selection is unchanged. Closing it deleted nothing.',
    'The memory clear request could not be sent. Check the memory service before trying again.',
    'Memory clear requested. Waiting for the memory service to confirm it.',
  ],
  'party.feedback': [
    'Companion preparation is unavailable.', 'Companion preparation returned an invalid state.',
    'The character died before joining.', 'The character was removed before joining.',
    'This copy could not join.', 'The installed character models could not be read.', 'Some model records could not be read.',
  ],
  'party.placement-feedback': [
    'Scenery or a vehicle is blocking the companion position.',
    'The game could not verify companion body clearance.',
    'The game placed this copy too close to someone. Invitation cancelled.',
    'The game placed this copy away from the verified ground. Invitation cancelled.',
    'The game could not verify a safe companion position.',
    'Move onto open, walkable ground to invite a companion here.',
    'No clear, reachable companion space on this floor. Move to a wider spot and try again.',
  ],
  'chauffeur.status': [
    'Preparing to drive', 'Driver boarding', 'Waiting for you to board', 'Waiting for party to board', 'Starting trip', 'Driving',
    'Stopping', 'Waiting for you to step out', 'Driver leaving the car',
    'Stop requested', 'Stop trip',
  ],
  // These exact returned/stored reasons reach manager-party's ui.t feedback
  // or init's localized gameplay-action feedback. Keep native wording intact;
  // raw exceptions, shutdown receipts and offer metadata are not UI copy.
  'chauffeur.feedback': [
    'Your companion is preparing to drive.', 'The driving request could not be queued.',
    'The driving request could not be cancelled.', 'Trip cancelled from Companion Manager.',
    'Choose a ready companion from your party.', 'That companion is no longer ready to drive.', 'Vehicle information is not ready.',
    'Step out of the driver seat before asking your companion to drive.',
    'Step out before starting a new companion trip.', 'Wait for the current vehicle activity to finish.',
    'This managed companion is unavailable.', 'Your companion must step out before taking the driver seat.',
    'Finish combat before asking for a ride.', 'An AutoDrive journey is already active.',
    'Stand near one of your owned cars, or summon one.', 'More than one owned car is nearby. Select or summon the car you want to use.',
    'Wait for your summoned car to arrive.', 'Wait for your car to stop.', 'Stand near your owned car.',
    'Select a destination on the map first.',
    'The driver seat is occupied or reserved.', 'Your car has no free passenger seat for V.',
    'The companion, car, seat or selected destination changed. Ask again.', 'Trip cancelled.',
    'The companion binding changed.', 'The trip stopped for combat.', 'The borrowed car is unavailable.',
    'A scene has taken control of the car.', 'A new vehicle summon interrupted the trip.',
    'V changed seats or vehicles.', 'V left the passenger seat.', 'The selected companion is leaving.',
    'Vehicle information became unavailable.', 'Waiting for current vehicle information.',
    'Destination reached. Step out when ready.',
    'The companion left the driver seat.', 'Walking commands did not release in time.',
    'The companion could not finish entering the driver seat.',
    'The party could not finish boarding. The trip was cancelled.', 'Another AutoDrive activity took control.',
    'You moved away from the car. The trip was cancelled.',
    'You did not board the car, so the trip was cancelled.',
    'Waiting for your passenger seat to be released.',
    'You are driving. The companion trip was cancelled.',
    'Waiting for the companion to release the driver seat.',
    'The route is blocked. Step out or try a new trip.',
    'The trip exceeded its time limit.', 'The borrowed car is in use.',
    'Companion ownership changed; waiting for the companion owner to resolve it.',
    'Another AutoDrive journey has control.',
    'Pending departure lost its vehicle binding.', 'V or a scene has taken vehicle control.',
    'Fast travel cancelled the companion trip.', 'The selected companion is unavailable.',
    'Step out of the driver seat so your companion can get in.',
    'The driver seat was not released, so the trip was cancelled.',
    'The car is now in use. The companion trip was cancelled.',
    'Waiting for your companion to settle before boarding.',
    'Waiting for the native vehicle transition to finish.',
    'Step out and wait for the previous driver cleanup to finish.',
  ],
  'party.vehicle-transition-feedback': [
    'Waiting for the existing companion after vehicle exit.',
    'Waiting for the native vehicle mount to release.',
    'Waiting for the native vehicle exit animation to finish.',
    'Vehicle exit workspot state is unavailable.',
    'Waiting for the native occupant slot to release.',
    'Waiting for the native vehicle exit to finish.',
    'Waiting for walking ownership to resume.',
  ],
  'phone.chat': [
    'Conversation interrupted. Your message is in the draft.', 'Waiting for the conversation service.',
    'Saved Chat cleanup could not be verified. Please wait for the memory service.',
    'Memory clearing is in progress. Your draft has been kept.',
    'Type a message first.', 'Conversations are disabled for this contact.',
    'Wait for your previous reply before sending another message.', 'Unable to send the message. Your draft has been kept.',
    'No reply received. Your message is in the draft; press Enter to retry.',
    'Message sent. Waiting for reply.', 'Waiting for your previous message to finish.',
    'Conversations are disabled in Companion Manager.', 'Conversation is unavailable for this contact.',
    'Opening chat. Waiting for the conversation service.',
    'Write a message...  /  Enter to send  /  Esc to stop typing',
    'Press Enter to write  /  Esc to stop typing',
  ],
  'world.conversation': ['Player unavailable', 'Face a nearby character to talk.', 'Type your message to the character.'],
  'phone.native-feedback': [
    'INVITE QUEUED - CLOSE PHONE', 'DISMISS QUEUED - CLOSE PHONE', 'CLOSE PHONE TO CONTINUE', 'COMPANION UNAVAILABLE',
    'ENTER  Write / Send   /   ESC  Stop typing',
  ],
  'legacy.manager': [
    'Keep this copy without a conversation identity', 'Use this conversation profile', 'Chat on', 'Chat off',
    'Conversation profile not assigned', 'Joining...', 'Choose the personality this copy should use in conversations. Its model stays the same.',
    'This copy can still follow you, but will not join conversations.', 'Clear profile', 'Use profile', 'Back to party',
    'Models', 'Your party', 'Discovering installed character models. Results appear as they are read.',
    'Your party is empty. Add a character or model to create a companion copy.',
    'No matches. Try another name or clear the search.', 'No entries are available.', 'Add a copy',
    'Turn chat off', 'Turn chat on', 'Choose a model in Models, then assign this profile in Party.',
    'Conversation profile not assigned.', 'Add a copy, then use Party to choose its conversation profile.',
    'Dismiss copy', 'Choose profile', 'Play spoken replies through the supported voice output. This does not change microphone capture.',
    'Show companion reply subtitles during conversations.', 'Turn off', 'Turn on',
    'Stopping',
    '0 results',
    'This copy could not be created.', 'The copy could not be dismissed.', 'The profile could not be assigned.', 'The profile could not be cleared.',
    'Request queued...', 'Updating selection', 'The list will refresh in a moment.',
    'Browse your characters, discover a game model, or manage your current party.', 'Loading...',
  ],
};

// Full sentences are proposed here instead of translating prefixes/suffixes.
// Tokens are values only: names, numbers, state labels or sanitized errors.
// No arbitrary runtime dialogue, biography or provider response is eligible.
const templates = [
  ['mcm.voice-status', 'Voice: {voice}', 'mod/mcm.lua', '\n\nVoice: '],
  ['mcm.voice-status', 'Conversation: {state}', 'mod/mcm.lua', '\nConversation: '],
  ['mcm.voice-status', '{status} · After current reply', 'mod/mcm.lua', ' · After current reply'],
  ['mcm.memory', '{count} · Last reported', 'mod/mcm.lua', ' · Last reported'],
  ['mcm.memory', 'Clear memories about you for all {count} characters you have talked to?', 'mod/mcm.lua', 'Clear memories about you for all ', ' characters you have talked to?'],
  ['mcm.memory', 'Clear {name}’s memories about conversations with you?', 'mod/mcm.lua', 'Clear ', '’s memories about conversations with you?'],
  ['mcm.memory', 'Clear {name}’s memories about conversations with you. Review an inline confirmation first.', 'mod/mcm.lua', '’s memories about conversations with you. Review an inline confirmation first.'],
  ['mcm.memory', 'Forget ({count} characters)', 'mod/mcm.lua', 'Forget (', ' characters)'],
  ['mcm.navigation', 'Browse {section}. {query}', 'mod/mcm.lua', 'Browse '],
  ['mcm.party', 'Add copy ({count})', 'mod/mcm.lua', 'Add copy ('],
  ['mcm.party', '{name} · invited copy', 'mod/mcm.lua', 'invited copy'],
  ['mcm.models', '{count} matching models', 'mod/mcm.lua', ' matching models'],
  ['mcm.models', 'Page {page} / {pages}', 'mod/mcm.lua', 'Page ', ' / '],
  ['mcm.models', 'Search by character name or model record using Search settings. {query}', 'mod/mcm.lua', 'Search by character name or model record using Search settings. '],
  ['mcm.memory', 'Search by character name using Search settings. {query}\nThe character can be outside your current party.', 'mod/mcm.lua', 'Search by character name using Search settings. ', '\nThe character can be outside your current party.'],
  ['mcm.memory', 'Select {name} for memory controls. This does not invite them or change their conversation settings.', 'mod/mcm.lua', 'Select ', ' for memory controls. This does not invite them or change their conversation settings.'],
  ['mcm.permissions', 'Allow {name} in private and group conversations. Existing copies can still follow you when this is off.', 'mod/mcm.lua', 'Allow ', ' in private and group conversations. Existing copies can still follow you when this is off.'],
  ['memory.feedback', 'Clearing memories for {target}…', 'mod/manager.lua', 'Clearing memories for '],
  ['memory.feedback', 'Waiting for the result of clearing memories for {target}. Reopen this page after the memory service reconnects.', 'mod/manager.lua', 'Waiting for the result of clearing memories for ', '. Reopen this page after the memory service reconnects.'],
  ['memory.feedback', 'Memory clear confirmed for {target}.', 'mod/manager.lua', 'Memory clear confirmed for '],
  ['memory.feedback', 'The memory service could not confirm the clear for {target}. Review the service before choosing Forget again.', 'mod/manager.lua', 'The memory service could not confirm the clear for ', '. Review the service before choosing Forget again.'],
  ['memory.feedback', '{name} selected for memory controls.', 'mod/manager.lua', ' selected for memory controls.'],
  ['party.feedback', '{name} could not prepare: {reason}', 'mod/manager-party.lua', ' could not prepare: '],
  ['party.feedback', 'Preparing {name}…', 'mod/manager-party.lua', 'Preparing '],
  ['party.feedback', '{name} is ready to join when you return to the game.', 'mod/manager-party.lua', ' is ready to join when you return to the game.'],
  ['party.feedback', '{name} will join when you return to the game.', 'mod/manager-party.lua', ' will join when you return to the game.'],
  ['party.feedback', '{name} will leave when you return to the game.', 'mod/manager-party.lua', ' will leave when you return to the game.'],
  ['party.feedback', '{name}: invitation cancelled.', 'mod/manager-party.lua', ': invitation cancelled.'],
  ['party.feedback', '{name} will stay in the party.', 'mod/manager-party.lua', ' will stay in the party.'],
  ['party.feedback', '{name}: conversation set to {profile}.', 'mod/manager-party.lua', 'conversation set to '],
  ['party.feedback', '{name}: conversation profile cleared.', 'mod/manager-party.lua', 'conversation profile cleared.'],
  ['party.feedback', '{name} joined your group.', 'mod/manager-party.lua', ' joined your group.'],
  ['party.feedback', '{name} could not join: {reason}', 'mod/manager-party.lua', ' could not join: '],
  ['party.feedback', '{name} dismissed.', 'mod/manager-party.lua', ' dismissed.'],
  ['party.feedback', '{name} is joining your party.', 'mod/manager-party.lua', ' is joining your party.'],
  ['party.feedback', '{name} joined your party.', 'mod/manager.lua', ' joined your party.'],
  ['party.feedback', '{name} is no longer attached to the world. Dismiss this copy to free its place.', 'mod/manager.lua', ' is no longer attached to the world. Dismiss this copy to free its place.'],
  ['phone.feedback', '{name} is not in your group.', 'mod/init.lua', ' is not in your group.'],
  ['phone.feedback', 'Connecting {name}…', 'mod/manager-party.lua', 'Connecting '],
  ['phone.feedback', '{name} is ready. Close the phone to join.', 'mod/manager-party.lua', ' is ready. Close the phone to join.'],
  ['phone.feedback', '{name}: preparation failed. Cancel and invite again.', 'mod/manager-party.lua', ': preparation failed. Cancel and invite again.'],
  ['world.conversation', '{name} does not have a conversation profile configured yet.', 'mod/init.lua', ' does not have a conversation profile configured yet.'],
  ['world.conversation', 'Group chat needs two characters nearby. Use {key} for one person.', 'mod/init.lua', 'Group chat needs two characters nearby. Use ', ' for one person.'],
  ['world.microphone', 'Use {key} to finish this recording.', 'mod/init.lua', 'Use ', ' to finish this recording.'],
  ['world.microphone', 'Listening - press {key} again to finish', 'mod/microphone.lua', 'Listening - press ', ' again to finish'],
  ['world.composer.native', 'TALK TO {character}', 'r6/scripts/CyberpunkConvai/Composer.reds', 'TALK TO '],
  ['phone.native-feedback', '{name}: invite queued.', 'r6/scripts/CyberpunkConvai/PhoneContacts.reds', ': invite queued.'],
  ['phone.native-feedback', '{name}: dismiss queued.', 'r6/scripts/CyberpunkConvai/PhoneContacts.reds', ': dismiss queued.'],
  ['legacy.manager', 'Unnamed model {index}', 'mod/manager.lua', 'Unnamed model '],
  ['legacy.manager', 'Copies in party: {count}', 'mod/manager.lua', '\nCopies in party: '],
  ['legacy.manager', 'State: {state}', 'mod/manager.lua', 'State: '],
  ['legacy.manager', 'Currently {state}.', 'mod/manager.lua', '\n\nCurrently '],
  ['legacy.manager', 'Page {page} of {pages}  |  {count} results', 'mod/manager.lua', ' of ', ' results'],
  ['legacy.manager', 'Reading models {read}/{total}', 'mod/manager.lua', '  |  Reading models '],
  ['legacy.manager', 'Party: {count}', 'mod/manager.lua', 'Party: '],
  ['legacy.manager', 'Creating a copy of {name}. Check Party for its status.', 'mod/manager.lua', 'Creating a copy of ', '. Check Party for its status.'],
  ['legacy.manager', '{name}: chat {state}.', 'mod/manager.lua', ': chat '],
  ['legacy.manager', 'Conversation profile set to {name}.', 'mod/manager.lua', 'Conversation profile set to '],
  ['settings.feedback', '{message} The change is active, but could not be saved for next time.', 'mod/manager.lua', ' The change is active, but could not be saved for next time.'],
  ['settings.feedback', 'Unknown setting: {setting}', 'mod/manager.lua', 'Unknown setting: '],
  ['legacy.manager', 'The manager could not be prepared: {reason}', 'mod/manager.lua', 'The manager could not be prepared: '],
  ['legacy.manager', 'The action could not finish: {reason}', 'mod/manager.lua', 'The action could not finish: '],
  ['legacy.manager', 'The manager could not refresh: {reason}', 'mod/manager.lua', 'The manager could not refresh: '],
  ['legacy.manager.native', 'DETAILS  {page} / {pages}', 'r6/scripts/CyberpunkConvai/Manager.reds', 'DETAILS  '],
];

const reserved = {
  'settings.language': [
    'Interface', 'Interface language', 'Automatic (game interface language)', 'Choose an interface language.',
    'Choose the mod interface language independently of character voices and conversation language.',
  ],
};

const nativeHandling = [
  { surface: 'world.composer', files: ['r6/scripts/CyberpunkConvai/Composer.reds', 'mod/composer-input.lua'],
    note: 'The title prefix TALK TO and exact English message currently identify this mod’s composer. Replace that ownership test with a language-independent marker before translating either. Do not identify every generic input by its translated text.' },
  { surface: 'phone.chat', files: ['r6/scripts/CyberpunkConvai/PhoneChat.reds', 'r6/scripts/CyberpunkConvai/PhoneChatTabs.reds', 'mod/phone-chat-style.lua'],
    note: 'Native creation sets CHAT/Chat and fallback Enter/Esc hints. Refresh existing widgets on locale change, and translate only mod-owned Chat widgets. The current ^ENTER status filter is English-specific. Native Messages/Contacts and game SMS stay game-localized.' },
  { surface: 'phone.contacts', files: ['r6/scripts/CyberpunkConvai/PhoneContacts.reds'],
    note: 'Immediate queued/unavailable feedback is created in redscript before Lua replies. It needs the same dictionary through a native bridge or a scoped Lua hook. J/L key textures and button codes are not translation strings.' },
  { surface: 'manager.legacy', files: ['r6/scripts/CyberpunkConvai/Manager.reds', 'mod/manager.lua'],
    note: 'Legacy native manager strings are inventoried for completeness; MCM is the active manager. Do not expose or revive this retired screen just to prove localization. Its F5 footer is historical.' },
  { surface: 'mcm.framework', files: ['mod/mcm.lua'],
    note: 'MCM owns Apply/Revert, search placeholders and framework status such as Completed. Provider-owned schema strings can be localized here; framework strings require MCM localization. Do not match a translated Completed prefix to decide success.' },
  { surface: 'characters', files: ['mod/manager.lua', 'mod/init.lua'],
    note: 'Catalogue names, summaries, model records, AI replies, provider errors, and game-localized character names are not blindly translated. Translate a curated UI error at its origin; preserve arbitrary inserted content as data.' },
];

const textByFile = new Map();
const tokenByFile = new Map();
const entries = new Map();
function add(text, context, refs = [], planned = false) {
  if (!text || !text.trim() || !/[A-Za-z]/.test(text)) return;
  const entry = entries.get(text) || { contexts: new Set(), references: new Set(), planned: false };
  entry.contexts.add(context);
  for (const ref of refs) entry.references.add(ref);
  entry.planned ||= planned;
  entries.set(text, entry);
}
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  textByFile.set(file, source);
  tokenByFile.set(file, lex(source, file));
}

function references(text, onlyFile, trim = false) {
  const refs = [];
  for (const [file, tokens] of tokenByFile) {
    if (onlyFile && file !== onlyFile) continue;
    for (const token of tokens) {
      if (token.kind === 'string' && (trim ? token.value.trim() : token.value) === text) refs.push(`${file}:${token.line}`);
    }
  }
  return [...new Set(refs)].sort();
}

for (const [file, tokens] of tokenByFile) {
  const native = file.endsWith('.reds');
  const mcm = file === 'mod/mcm.lua';
  const calls = mcm ? { readonly: [1, 2, 3], setting: [1, 5], action: [1, 2, 3], category: [1, 3] } : {};
  Object.assign(calls, { ConvaiPhoneFeedback: [0], SetDefaultText: [0] });
  if (file === 'mod/manager.lua') Object.assign(calls, { say: [0], savedFeedback: [0] });
  if (native) Object.assign(calls, {
    SetText: [0, 1], SetTitle: [0], SetFluffLeft: [0], SetFluffRight: [0], SetFluffText: [0],
    MakeControl: [2, 3], MakeText: [2], ConvaiManagerSetFeedback: [0],
  });
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'identifier') continue;
    const rootTranslation = token.value === 't' && tokens[index - 1]?.value === '.' && tokens[index - 2]?.value === 'ui';
    const phoneTranslation = token.value === 'text' && ['mod/composer-input.lua', 'mod/phone-chat-style.lua'].includes(file);
    if ((rootTranslation || phoneTranslation) && tokens[index + 1]?.value === '(') {
      const args = argumentsAt(tokens, index + 1);
      const source = staticText(args[0]);
      if (source !== null) add(source, phoneTranslation ? 'phone.localized' : 'ui.localized', [`${file}:${token.line}`]);
    }
    // convaiNotices.send(player, id, text) is the gate in front of ConvaiPhoneFeedback (mod/notices.lua):
    // its text argument is catalogued exactly like the direct call it replaced.
    const noticeSend = token.value === 'send' && tokens[index - 1]?.value === '.' && tokens[index - 2]?.value === 'convaiNotices';
    const positions = noticeSend ? [2] : calls[token.value];
    if (positions && tokens[index + 1]?.value === '(') {
      const args = argumentsAt(tokens, index + 1);
      const context = mcm ? `mcm.${token.value}` : file === 'mod/manager.lua' ? 'manager.feedback'
        : file.includes('Manager.reds') ? 'legacy.manager.native' : file.includes('Phone') || file.includes('phone') ? 'phone.native' : 'world.conversation';
      for (const position of positions) {
        const text = staticText(args[position]);
        if (text !== null) add(text, context, [`${file}:${args[position][0].line}`]);
      }
      if (mcm && token.value === 'setting') {
        const options = args[6];
        if (options?.[0]?.value === '{' && options.at(-1)?.value === '}'
          && options.slice(1, -1).every(item => item.kind === 'string' || item.value === ',')) {
          for (const option of options.filter(item => item.kind === 'string')) add(option.value, 'mcm.options', [`${file}:${option.line}`]);
        }
      }
    }
    if (file === 'mod/init.lua' && token.value === 'registerHotkey' && tokens[index + 1]?.value === '(') {
      const args = argumentsAt(tokens, index + 1), key = staticText(args[0]), label = staticText(args[1]);
      if (key && !key.includes('diagnostic') && label) add(label, 'cet.bindings', [`${file}:${token.line}`]);
    }
    if ((file === 'mod/manager.lua' || file === 'mod/manager-party.lua')
      && token.value === 'return' && ['true', 'false'].includes(tokens[index + 1]?.value)
      && tokens[index + 2]?.value === ',' && tokens[index + 3]?.kind === 'string'
      && tokens[index + 4]?.value !== '..') {
      add(tokens[index + 3].value, file === 'mod/manager.lua' ? 'manager.validation' : 'party.validation', [`${file}:${token.line}`]);
    }
  }
}

for (const [context, texts] of Object.entries(reviewed)) {
  for (const text of texts) {
    const refs = references(text, undefined, true);
    if (!refs.length) throw new Error(`Reviewed UI literal disappeared (${context}): ${JSON.stringify(text)}`);
    add(text, context, refs);
  }
}

const dynamicTemplates = {};
for (const [context, text, file, ...anchors] of templates) {
  // Once integration replaces the concatenation, the complete source key is
  // authoritative and historical fragment anchors are no longer required.
  const refs = references(text, file);
  if (!refs.length) {
    for (const anchor of anchors) {
      const found = references(anchor, file);
      if (!found.length) throw new Error(`Dynamic template anchor disappeared (${file}): ${JSON.stringify(anchor)}`);
      refs.push(...found);
    }
  }
  const tokens = [...new Set([...text.matchAll(/\{([a-z][A-Za-z0-9]*)\}/g)].map(match => match[1]))].sort();
  if (!tokens.length) throw new Error(`Template has no named tokens: ${text}`);
  dynamicTemplates[text] = { tokens, contexts: [context], references: [...new Set(refs)].sort(), integration: 'Replace reviewed concatenation at its origin; never match arbitrary formatted text.' };
  add(text, context, refs);
}
for (const [context, texts] of Object.entries(reserved)) for (const text of texts) add(text, context, references(text), true);

const sort = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const strings = {}, metadata = {}, contexts = {};
for (const text of sort(entries.keys())) {
  const entry = entries.get(text);
  strings[text] = text;
  metadata[text] = { contexts: sort(entry.contexts), references: sort(entry.references) };
  if (entry.planned && !entry.references.size) metadata[text].planned = true;
  for (const context of sort(entry.contexts)) (contexts[context] ||= []).push(text);
}
const catalogue = {
  version: 1, locale: 'en', sourceLanguage: 'en',
  description: 'Developer-only canonical UI source catalogue. Runtime dictionaries are Lua. Keys are exact English UI source strings or explicit named-token templates.',
  scope: { files, excludes: ['character names and biographies', 'AI dialogue and prompts', 'API keys and IDs', 'raw provider errors', 'diagnostic-only text', 'native game Messages/Contacts translations'] },
  counts: { strings: entries.size, dynamicTemplates: Object.keys(dynamicTemplates).length, contexts: Object.keys(contexts).length },
  strings, contexts: Object.fromEntries(sort(Object.keys(contexts)).map(key => [key, contexts[key]])),
  metadata, dynamicTemplates: Object.fromEntries(sort(Object.keys(dynamicTemplates)).map(key => [key, dynamicTemplates[key]])),
  nativeHandling,
};
const output = `${JSON.stringify(catalogue, null, 2)}\n`;
const target = path.join(root, 'localization/en.json');
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8');
  if (current !== output) throw new Error('localization/en.json is stale. Run node scripts/Extract-UiCatalog.mjs.');
} else {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, output, 'utf8');
}
console.log(JSON.stringify({ file: 'localization/en.json', ...catalogue.counts, checked: process.argv.includes('--check') }));
if (process.argv.includes('--summary')) console.log(JSON.stringify(Object.fromEntries(Object.entries(contexts).map(([key, values]) => [key, values.length])), null, 2));
