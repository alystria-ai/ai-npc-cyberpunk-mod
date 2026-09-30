import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const localeSource = read('../mod/ui-locale.lua');
const partySource = read('../mod/manager-party.lua');
const microphoneSource = read('../mod/microphone.lua');
const catalog = JSON.parse(read('../localization/en.json')).strings;
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// A small independent dictionary exercises word order and literal replacement.
// The player names and provider errors intentionally look like translatable UI.
const translations = {
  'Load a save before inviting a companion.': 'Chargez une sauvegarde avant une invitation.',
  'That character model is unavailable.': 'Ce modèle est indisponible.',
  'Your party has eight copies. Dismiss one first.': 'Huit copies présentes. Renvoyez-en une.',
  'That copy is no longer in your party.': 'Cette copie a quitté le groupe.',
  'That dismissal is no longer pending.': 'Ce renvoi n’est plus en attente.',
  'Cancel an invitation first; the party is full.': 'Annulez une invitation ; le groupe est complet.',
  'Choose an active or invited copy.': 'Choisissez une copie active ou invitée.',
  'Companion preparation is unavailable.': 'La préparation est indisponible.',
  'Companion preparation returned an invalid state.': 'État de préparation invalide.',
  'The character died before joining.': 'Le personnage est mort avant son arrivée.',
  'The character was removed before joining.': 'Le personnage a disparu avant son arrivée.',
  '{name} is preparing memory and conversation.': 'Préparation de la mémoire et de la conversation de {name}.',
  '{name} is ready to join when you return to the game.': '{name} est prêt à vous rejoindre en jeu.',
  '{name} will join when you return to the game.': '{name} vous rejoindra en jeu.',
  '{name} will leave when you return to the game.': '{name} partira à votre retour en jeu.',
  '{name} will stay in the party.': '{name} restera dans le groupe.',
  '{name}: invitation cancelled.': 'Invitation annulée : {name}.',
  '{name}: conversation set to {profile}.': 'Profil {profile} choisi pour {name}.',
  '{name}: conversation profile cleared.': 'Profil de conversation effacé pour {name}.',
  '{name} is joining your party.': '{name} rejoint votre groupe.',
  '{name} joined your group.': '{name} a rejoint votre groupe.',
  '{name} dismissed.': '{name} renvoyé.',
  '{name} could not prepare: {reason}': 'Préparation impossible pour {name} : {reason}',
  '{name} could not join: {reason}': 'Arrivée impossible pour {name} : {reason}',
  'Listening - press {key} again to finish': 'Écoute — appuyez encore sur {key} pour terminer',
  'Microphone unavailable. Check your Windows input device.': 'Microphone indisponible. Vérifiez votre entrée Windows.',
  'Microphone connection timed out. Please try again.': 'Délai de connexion du microphone dépassé. Réessayez.',
};
const dictionary = '{' + Object.entries(translations).map(([key, value]) =>
  `[${JSON.stringify(key)}]=${JSON.stringify(value)}`).join(',\n') + '}';

function run(body, language = 'en') {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = fixture + `\nassert(ui.configure('${language}')); ui.update(0)\n` + body + `
      assert(nativeLocaleReads == 0, 'feedback queried native locale/settings')
      assert(catalogReads == ${language === 'en' ? 0 : 1}, 'feedback reloaded a dictionary')
    `;
    const status = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(state); }
}

const fixture = `
local nativeLocaleReads, catalogReads, now = 0, 0, 100
os.time = function() return now end
local files, encoded, commands, feedback = {}, {}, {}, {}
local function copy(value)
    if type(value) ~= 'table' then return value end
    local out = {}; for key, item in pairs(value) do out[key] = copy(item) end; return out
end
local serial = 0
json = {encode = function(value)
    serial = serial + 1; local key = tostring(serial); encoded[key] = copy(value); return key
end, decode = function(raw) return copy(assert(encoded[raw])) end}
io = {open = function(path, mode)
    assert(path == 'runtime/microphone-command.json' or path == 'runtime/microphone-state.json',
        'feedback attempted unrelated filesystem work: ' .. path)
    if mode == 'rb' then
        if not files[path] then return nil end
        return {read = function() return files[path] end, close = function() end}
    end
    return {write = function(_, raw)
        files[path] = raw; commands[#commands + 1] = json.decode(raw)
    end, close = function() end}
end}
Game = {GetSettingsSystem = function()
    nativeLocaleReads = nativeLocaleReads + 1; error('feedback cannot detect locale')
end, GetAllBlackboardDefs = function() return {UI_System = {IsInMenu = 'menu'}} end,
GetBlackboardSystem = function() return {Get = function()
    return {GetBool = function() return false end}
end} end}
local ui = (function() ${localeSource} end)()
dofile = function(path)
    if path == 'ui-locale.lua' then return ui end
    assert(path == 'locales/fr.lua', 'unexpected dependency: ' .. path)
    catalogReads = catalogReads + 1; return ${dictionary}
end
local party = (function() ${partySource} end)()
local mic = (function() ${microphoneSource} end)()
local player = {ConvaiPhoneFeedback = function(_, text) feedback[#feedback + 1] = text end}
local actorName, profileName = 'Judy 100% {profile}', 'パナム {name} 50%'
local function makeParty(prepared)
    local env = {members = {}, status = {state = 'ready'}, serial = 0}
    local definitions = {
        known = {name = actorName, id = 'Character.Judy', profileKey = 'judy', profileName = actorName},
        model = {name = actorName, id = 'Character.Model'}}
    local companions = {
        list = function() return env.members end,
        definition = function(key) return definitions[key] end,
        setProfile = function() return not env.assignmentError, env.assignmentError end,
        dismiss = function(id)
            if env.dismissError then return false, env.dismissError end
            for index, member in ipairs(env.members) do
                if member.serial == id then table.remove(env.members, index); return true end
            end
        end,
        spawn = function(key)
            if env.spawnError then return nil, env.spawnError end
            env.serial = env.serial + 1
            env.members[#env.members + 1] = {serial = env.serial, key = key,
                name = definitions[key].name, state = 'spawning'}
            return env.serial
        end}
    local readiness = prepared and {
        bind = function() return false end,
        prepare = function() return not env.prepareError, env.prepareError end,
        status = function() return env.status end,
        cancel = function() end, spawned = function() end, finish = function() end} or nil
    env.readiness = readiness
    env.queue = party.new(companions, readiness); env.queue.bind('world')
    return env
end
local function microphoneState(value, id)
    files['runtime/microphone-state.json'] = json.encode({requestId = id or 'voice-1', state = value})
end
local function microphoneInput(group)
    return {requestId = 'voice-1', name = actorName, text = 'Do not translate: Settings 100% {name}',
        group = group and {index = 1, total = 2} or nil}
end
`;

test('all feedback translations use existing exact English catalog keys and named tokens', () => {
  const tokens = text => [...new Set([...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(match => match[1]))].sort();
  for (const [source, translated] of Object.entries(translations)) {
    assert.equal(catalog[source], source, `uncataloged source: ${source}`);
    assert.deepEqual(tokens(translated), tokens(source), `token mismatch: ${source}`);
  }
});

test('English invitations, assignments and deferred dismissals retain their exact feedback', () => run(`
  local env = makeParty(false); local q = env.queue
  q.bind(nil); local ok, message = q.invite('known')
  assert(not ok and message == 'Load a save before inviting a companion.')
  q.bind('world'); ok, message = q.invite('missing')
  assert(not ok and message == 'That character model is unavailable.')
  ok, message = q.invite('known')
  assert(ok and message == actorName .. ' will join when you return to the game.')
  ok, message = q.assign('queued:1', 'panam', profileName)
  assert(ok and message == actorName .. ': conversation set to ' .. profileName .. '.')
  ok, message = q.assign('queued:1', nil)
  assert(ok and message == actorName .. ': conversation profile cleared.')
  ok, message = q.dismiss('queued:1')
  assert(ok and message == actorName .. ': invitation cancelled.')
  assert(q.invite('known')); q.flush()
  assert(q.message() == actorName .. ' is joining your party.')
  assert(#q.takeNotices() == 0)
  env.members[1].state = 'ready'; q.flush()
  local notices = q.takeNotices()
  assert(#notices == 1 and notices[1].message == actorName .. ' joined your group.' and not notices[1].failed)
  ok, message = q.dismiss('live:1')
  assert(ok and message == actorName .. ' will leave when you return to the game.')
  assert(#env.members == 1, 'localization changed deferred world mutation')
  ok, message = q.undoDismiss('live:1')
  assert(ok and message == actorName .. ' will stay in the party.')
  assert(q.dismiss('live:1')); q.flush()
  notices = q.takeNotices()
  assert(#env.members == 0 and #notices == 1 and notices[1].message == actorName .. ' dismissed.')
`));

test('English readiness, failures and microphone notices preserve original wording', () => run(`
  local env = makeParty(true); local q = env.queue
  local ok, message = q.invite('known')
  assert(ok and message == actorName .. ' is preparing memory and conversation.')
  ok, message = q.invite('model')
  assert(ok and message == actorName .. ' is ready to join when you return to the game.')
  q.flush(); env.members[1].state = 'dead'; table.remove(env.members, 2); q.flush()
  local notices = q.takeNotices()
  assert(#notices == 2)
  local foundDead, foundRemoved = false, false
  for _, notice in ipairs(notices) do
    assert(notice.failed)
    foundDead = foundDead or notice.message == actorName .. ' could not join: The character died before joining.'
    foundRemoved = foundRemoved or notice.message == actorName .. ' could not join: The character was removed before joining.'
  end
  assert(foundDead and foundRemoved)
  local failing = makeParty(true); failing.prepareError = 'raw preparation failure'
  ok, message = failing.queue.invite('known')
  assert(not ok and message == actorName .. ' could not prepare: raw preparation failure')
  local spawning = makeParty(true); spawning.spawnError = 'raw spawn failure'
  assert(spawning.queue.invite('known')); spawning.queue.flush()
  assert(spawning.queue.message() == actorName .. ' could not join: raw spawn failure')
  for _, group in ipairs({false, true}) do
    local context = microphoneInput(group); assert(mic.begin(context))
    microphoneState('recording'); mic.update(player)
    assert(feedback[#feedback] == 'Listening - press ' .. (group and 'F9' or 'F7') .. ' again to finish')
    mic.cancel()
  end
  assert(mic.begin(microphoneInput(false))); microphoneState('error'); mic.update(player)
  assert(feedback[#feedback] == 'Microphone unavailable. Check your Windows input device.')
  files['runtime/microphone-state.json'] = nil
  assert(mic.begin(microphoneInput(false))); now = now + 36; mic.update(player)
  assert(feedback[#feedback] == 'Microphone connection timed out. Please try again.')
`));

test('French party events translate templates while preserving names, profile names and queue identity', () => run(`
  local env = makeParty(true); local q = env.queue
  local ok, message = q.invite('known')
  assert(ok and message == 'Préparation de la mémoire et de la conversation de ' .. actorName .. '.')
  assert(q.list()[1].name == actorName and q.list()[1].id == 'queued:1')
  ok, message = q.assign('queued:1', 'panam', profileName)
  assert(ok and message == 'Profil ' .. profileName .. ' choisi pour ' .. actorName .. '.')
  assert(q.list()[1].profileName == profileName and q.list()[1].profileKey == 'panam')
  ok, message = q.assign('queued:1', nil)
  assert(ok and message == 'Profil de conversation effacé pour ' .. actorName .. '.')
  ok, message = q.dismiss('queued:1')
  assert(ok and message == 'Invitation annulée : ' .. actorName .. '.')
  ok, message = q.invite('model')
  assert(ok and message == actorName .. ' est prêt à vous rejoindre en jeu.')
  q.flush(); assert(q.message() == actorName .. ' rejoint votre groupe.')
  env.members[1].state = 'ready'; q.flush()
  assert(q.takeNotices()[1].message == actorName .. ' a rejoint votre groupe.')
  ok, message = q.dismiss('live:1')
  assert(ok and message == actorName .. ' partira à votre retour en jeu.')
  ok, message = q.undoDismiss('live:1')
  assert(ok and message == actorName .. ' restera dans le groupe.')
  assert(q.dismiss('live:1')); q.flush()
  assert(q.takeNotices()[1].message == actorName .. ' renvoyé.')
  local legacy = makeParty(false)
  ok, message = legacy.queue.invite('known')
  assert(ok and message == actorName .. ' vous rejoindra en jeu.')
`, 'fr'));

test('French local validation errors remain separate from opaque provider errors', () => run(`
  local env = makeParty(true); local q = env.queue
  q.bind(nil); local ok, message = q.invite('known')
  assert(not ok and message == 'Chargez une sauvegarde avant une invitation.')
  q.bind('world'); ok, message = q.invite('missing')
  assert(not ok and message == 'Ce modèle est indisponible.')
  ok, message = q.dismiss('missing')
  assert(not ok and message == 'Cette copie a quitté le groupe.')
  ok, message = q.undoDismiss('missing')
  assert(not ok and message == 'Ce renvoi n’est plus en attente.')
  ok, message = q.assign('missing', 'panam', profileName)
  assert(not ok and message == 'Choisissez une copie active ou invitée.')
  for i = 1, 8 do assert(q.invite('known')) end
  ok, message = q.invite('known')
  assert(not ok and message == 'Huit copies présentes. Renvoyez-en une.')
  env.members[1] = {serial = 99, name = actorName, state = 'ready'}
  assert(q.dismiss('live:99')); ok, message = q.undoDismiss('live:99')
  assert(not ok and message == 'Annulez une invitation ; le groupe est complet.')
  local raw = 'Microphone unavailable. Check your Windows input device.'
  local failed = makeParty(true); failed.prepareError = raw
  ok, message = failed.queue.invite('known')
  assert(not ok and message == 'Préparation impossible pour ' .. actorName .. ' : ' .. raw)
  local status = makeParty(true); assert(status.queue.invite('known'))
  status.status = nil
  assert(status.queue.list()[1].error == 'La préparation est indisponible.')
  status.status = {state = 'invalid'}
  assert(status.queue.list()[1].error == 'État de préparation invalide.')
  status.status = {state = 'error', error = raw}; status.queue.flush()
  assert(status.queue.takeNotices()[1].message == 'Préparation impossible pour ' .. actorName .. ' : ' .. raw)
`, 'fr'));

test('French attachment failures translate only owned fallback reasons and preserve warnings', () => run(`
  local env = makeParty(true); local q = env.queue
  assert(q.invite('known')); assert(q.invite('known')); q.flush()
  env.members[1].state = 'dead'; table.remove(env.members, 2); q.flush()
  local dead, removed = false, false
  for _, notice in ipairs(q.takeNotices()) do
    dead = dead or notice.message == 'Arrivée impossible pour ' .. actorName .. ' : Le personnage est mort avant son arrivée.'
    removed = removed or notice.message == 'Arrivée impossible pour ' .. actorName .. ' : Le personnage a disparu avant son arrivée.'
  end
  assert(dead and removed)
  local raw = 'That character model is unavailable.'
  local failed = makeParty(true); failed.spawnError = raw
  assert(failed.queue.invite('known')); failed.queue.flush()
  assert(failed.queue.takeNotices()[1].message == 'Arrivée impossible pour ' .. actorName .. ' : ' .. raw)
  local warned = makeParty(true); warned.assignmentError = raw
  assert(warned.queue.invite('known')); warned.queue.flush()
  assert(warned.queue.message() == actorName .. ': ' .. raw)
  warned.members[1].state = 'ready'; warned.queue.flush()
  assert(warned.queue.takeNotices()[1].message == actorName .. ' a rejoint votre groupe. ' .. raw)
  warned.dismissError = raw; assert(warned.queue.dismiss('live:1')); warned.queue.flush()
  assert(warned.queue.takeNotices()[1].message == actorName .. ': ' .. raw)
`, 'fr'));

test('French microphone prompts preserve shortcut codes, input text and request ownership', () => run(`
  for _, group in ipairs({false, true}) do
    local context = microphoneInput(group); assert(mic.begin(context))
    microphoneState('recording', 'stale'); mic.update(player)
    assert(mic.state == 'starting')
    microphoneState('recording'); mic.update(player)
    assert(feedback[#feedback] == 'Écoute — appuyez encore sur ' .. (group and 'F9' or 'F7') .. ' pour terminer')
    assert(mic.finish(group and 'group' or 'private') == context)
    local command = commands[#commands]
    assert(command.action == 'finish' and command.input.name == actorName)
    assert(command.input.text == 'Do not translate: Settings 100% {name}')
    assert(command.input.requestId == 'voice-1' and mic.received('voice-1'))
  end
  assert(mic.begin(microphoneInput(false))); microphoneState('error'); mic.update(player)
  assert(feedback[#feedback] == 'Microphone indisponible. Vérifiez votre entrée Windows.')
  assert(not mic.context and commands[#commands].action == 'cancel')
  files['runtime/microphone-state.json'] = nil
  assert(mic.begin(microphoneInput(false))); now = now + 36; mic.update(player)
  assert(feedback[#feedback] == 'Délai de connexion du microphone dépassé. Réessayez.')
  assert(not mic.context and commands[#commands].action == 'cancel')
`, 'fr'));
