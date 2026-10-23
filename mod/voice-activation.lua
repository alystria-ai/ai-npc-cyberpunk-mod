-- Voice activation (Settings > Voices, off by default): talk with no key. The bridge's microphone tap listens and its voice activity detector
-- (bridge/voice-activity.mjs) says when V starts and stops speaking; this module only decides WHEN the microphone may be open and starts and
-- ends the turn the detector reports. Nothing here runs per frame: the game calls update() from its 10 Hz tick, the "can a conversation happen"
-- test runs twice a second at most, and the detector's state is one small file read a few times a second, only while listening.
--
-- The microphone is open (microphone-live.json "listen") only while ALL of these hold:
--   the setting is on, the world is playable, no menu or text box is open,
--   a character with a profile is faced, or a companion is near (the same candidates the talk key uses),
--   the game is not running its own scene, a dialogue with choices, or a phone call (never during the game's own conversations),
--   no turn is in flight, and no AI line is playing or has only just ended (the character's own voice must not be heard as V's).
-- Anything else closes the microphone at once. When the setting goes off, the bridge releases the device and the detector.
local M = {}
M.clock = os.clock

local CHECK_S = 0.5            -- how often the "a conversation is possible" test runs
local POLL_S = 0.25            -- how often the detector's state is read while listening
local VOICE_COOLDOWN_S = 0.9   -- after an AI line ends: its room echo and tail must be gone before the microphone opens again
local MISS_COOLDOWN_S = 3      -- after a start that found nobody to talk to (a sound that was not for anyone)
local MIN_START_GAP_S = 2      -- two turns by voice activation are never started closer than this

local state = {
    listening = false, checkedAt = -100, polledAt = -100, possible = false,
    seen = nil,            -- the detector id last handled
    quietUntil = 0, wasVoiced = false, startedAt = -100, errorNoted = nil,
}

-- The game's own scenes, dialogue with choices and phone calls: read-only, the same flags mod/battle-observer.lua reads. Anything unreadable
-- counts as busy (the microphone never opens on doubt).
function M.sceneBusy(player)
    local ok, busy = pcall(function()
        if PlayerPuppet.GetSceneTier(player) >= 3 then return true end
        local scene = Game.GetSceneSystem():GetScriptInterface()
        if scene:IsEntityInDialogue(player:GetEntityID()) then return true end
        local defs = Game.GetAllBlackboardDefs()
        local choices = FromVariant(Game.GetBlackboardSystem():Get(defs.UIInteractions):GetVariant(defs.UIInteractions.DialogChoiceHubs))
        if choices ~= nil and #choices.choiceHubs > 0 then return true end
        local call = FromVariant(Game.GetBlackboardSystem():Get(defs.UI_ComDevice):GetVariant(defs.UI_ComDevice.PhoneCallInformation))
        if call ~= nil and (call.callPhase == Enum.new('questPhoneCallPhase', 'IncomingCall')
            or call.callPhase == Enum.new('questPhoneCallPhase', 'StartCall')) then return true end
        return false
    end)
    return not ok or busy == true
end

-- Closes the microphone (the bridge releases the device and drops the detector). Idempotent; one file write on the change only.
function M.off()
    if state.listening then state.listening = false end
    if M.deps then M.deps.listen(false) end
    state.possible = false
end

-- deps (set by init.lua once):
--   enabled()                  the setting
--   listen(on)                 open or close the bridge's microphone (mod/microphone.lua, runtime/microphone-live.json)
--   gameplay(player)           false in a menu or with the text box open
--   conversation(player)       true when a profiled character is faced or a companion is near (the talk key's candidates)
--   voiceReady()               false when voice input is not possible with the chosen provider
--   busy()                     a turn is in flight (microphone, reply, group round, text turn)
--   speaking()                 an AI line is playing (or about to)
--   begin(vadId)               start V's turn (quietly: no notice for a sound that was not for anyone); returns true when a recording began
--   errorNotice()              the one notice: the microphone could not be opened
M.deps = nil

local function clockNow() return M.clock() end

-- Called every 0.1 s tick by the game. `elapsed` is the tick's length, `ready` the world is playable.
function M.update(player, elapsed, ready)
    local deps = M.deps
    if not deps then return end
    local now = clockNow()
    -- The AI's voice: the microphone is closed while it plays and for a moment after (checked every tick: two field reads).
    local speaking = deps.speaking() == true
    if speaking then state.wasVoiced = true; state.quietUntil = math.max(state.quietUntil, now + VOICE_COOLDOWN_S)
    elseif state.wasVoiced then state.wasVoiced = false; state.quietUntil = math.max(state.quietUntil, now + VOICE_COOLDOWN_S) end
    local busy = deps.busy() == true
    local want = false
    if ready and player and not speaking and not busy and now >= state.quietUntil then
        if now - state.checkedAt >= CHECK_S then
            state.checkedAt = now
            local ok, possible = pcall(function()
                return deps.gameplay(player) and deps.voiceReady() and deps.conversation(player) and not M.sceneBusy(player)
            end)
            state.possible = ok and possible == true
        end
        want = state.possible
    else
        state.possible = false
        state.checkedAt = -100     -- the next chance asks again at once
    end
    if want ~= state.listening then
        state.listening = want
        deps.listen(want)
        if want then
            state.polledAt = -100
            -- What the detector said before this listening began is old: only what comes after counts.
            state.seen = M.peek()
        end
    end
    if not state.listening then return end
    if now - state.polledAt < POLL_S then return end
    state.polledAt = now
    local vad = M.peek()
    if not vad or vad.id == state.seen then return end
    state.seen = vad.id
    if vad.phase == 'error' then
        if state.errorNoted ~= vad.id then
            state.errorNoted = vad.id
            deps.errorNotice()
        end
        M.off()
        return
    end
    if vad.phase ~= 'speech' then return end
    -- A start: begin V's turn if somebody can be talked to. The detector ends it itself (microphone.lua reads the end from the same file).
    if now - state.startedAt < MIN_START_GAP_S then return end
    state.startedAt = now
    local began = deps.begin(vad.id)
    if not began then state.quietUntil = math.max(state.quietUntil, now + MISS_COOLDOWN_S) end
end

-- The detector's latest status in runtime/microphone-state.json: {id, phase = 'speech' | 'ended' | 'error', at}, or nil.
function M.peek()
    local f = io.open('runtime/microphone-state.json', 'rb')
    if not f then return nil end
    local raw = f:read('*a'); f:close()
    local ok, value = pcall(json.decode, raw)
    if not ok or type(value) ~= 'table' or type(value.vad) ~= 'table' or type(value.vad.id) ~= 'string' then return nil end
    return value.vad
end

function M.listening() return state.listening end

return M
