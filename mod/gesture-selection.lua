-- Pure gesture selection policy (docs/COMPANION_GESTURES.md). No native calls,
-- no world handles: the controller supplies the clock, mode, rig, emotion and
-- remaining speech time, and plays whatever clip this returns.
local M = {}

-- Emotion family (facial-playback families) -> clip categories, strongest first.
M.families = {
    joy = {'happy', 'emphatic', 'neutral'}, trust = {'neutral', 'happy'},
    sadness = {'sad', 'neutral'}, anger = {'angry', 'neutral'}, fear = {'fear', 'neutral'},
    disgust = {'disgust', 'neutral'}, surprise = {'surprise', 'question', 'neutral'},
    anticipation = {'emphatic', 'question', 'neutral'}, neutral = {'neutral', 'question'},
    unknown = {'neutral'},
}
-- Calm filler mixed into emotional speech so emotion colours, not dominates.
M.filler = {'neutral', 'shrug', 'emphatic', 'question'}
-- Never played, whatever a catalog contains (user decision: no rude/strong gestures).
M.banned = {'threaten', 'fuck_you', 'clap', 'thumb_up', 'middle_finger', 'cheer', 'dance', 'step', 'turn',
    -- Symbolic or strong gestures, excluded by default (user decision, Oct 7):
    'fist', 'salute', 'go_away', 'come_closer', 'taunt', 'shoot', 'draw_gun', 'aim', 'kill', 'slit',
    'crack_knuckles', 'cracking_knuckles', 'be_quiet', 'shush', 'stop__angry', 'me__angry', 'talk_to_hand',
    -- Verified in the Oct 7 capture: a raised thumbs-up shape while Judy talks.
    'judy__stand_2h_arms_crossed__01__gesture__02'}
-- Clips found to contain symbolic hand shapes by measurement (thumbs-up,
-- middle finger), generated into the catalog as clip.symbolic=true.
function M.symbolic(clip) return clip.symbolic == true end
-- Per character pacing: rate > 1 gestures more often.
M.profiles = {
    takemura = {rate = .7}, johnny = {rate = 1.2}, panam = {rate = 1.15}, kerry = {rate = 1.15},
    jackie = {rate = 1.1}, viktor = {rate = .85}, judy = {rate = 1}, river = {rate = .9},
    rogue = {rate = .85}, misty = {rate = .8},
}
-- Seconds between clips by intensity 1..3. Live feedback (Oct 7): two clips
-- in ten seconds read as no gestures at all; keep hands busy while speaking.
local gaps = {{.6, 1.6}, {.4, 1.2}, {.3, .9}}
-- Expressive hand/arm gestures read from a distance; head flicks and nods
-- barely register, so they are mostly left for listening.
local subtle = {'head_flick', 'nod', 'yes__head', 'no__head', 'look_', 'shuffle', 'scratch', 'weight_shift', 'breathe'}
local expressive = {'explain', 'describe', 'demonstrate', 'gesture', 'point', 'shrug', 'calm_down', 'this_or_that',
    'confident', 'what', 'whatever', 'talk', '2h_', 'flick', 'rub_hands', 'me__'}
-- Measured hand reach (cm, scripts/Measure-GestureMotion.py) when known:
-- clips under 15 cm read as no gesture and are only used when nothing else
-- fits; above that the weight grows with reach. Name heuristics otherwise.
M.minimumReach = 15
function M.motionWeight(item)
    local reach = item.reach
    if type(reach) ~= 'number' then return M.expressiveness(item.clip.name) end
    if reach < M.minimumReach then return .05 end
    return math.min(4, reach / 15)
end
function M.expressiveness(name)
    for _, word in ipairs(subtle) do if name:find(word, 1, true) then return .2 end end
    for _, word in ipairs(expressive) do if name:find(word, 1, true) then return 2.5 end end
    return 1
end
M.minimumSpeech = 5 -- seconds of reply audio before talk gestures are used at all
local HISTORY, COOLDOWN = 4, 30

function M.allowed(name)
    for _, word in ipairs(M.banned) do
        if name:find(word, 1, true) then return false end
    end
    return true
end

function M.new(random)
    return {random = random or math.random, history = {}, used = {}, mode = nil, nextAt = 0}
end

local function between(s, low, high) return low + (high - low) * s.random() end
local function rate(character) return (M.profiles[character] or {}).rate or 1 end

-- Clips this rig/character may play, by category.
local function candidates(clips, rig, character, category)
    local list = {}
    for _, clip in ipairs(clips or {}) do
        local onRig = clip.perRig and clip.perRig[rig]
        if onRig and clip.category == category and M.allowed(clip.name) and not M.symbolic(clip)
            and (clip.character == nil or clip.character == character) then
            list[#list + 1] = {clip = clip, duration = onRig.duration, reach = onRig.reach}
        end
    end
    return list
end

local function recent(s, name)
    for _, previous in ipairs(s.history) do if previous == name then return true end end
    return false
end

-- Weighted pick with repetition control. Relax cooldown, then history, only
-- when nothing else fits; never repeat the immediately previous clip.
local function pick(s, list, now, remaining, repeatable)
    local function eligible(item, strict)
        if remaining and item.duration * .7 > remaining then return false end
        if not repeatable and s.history[#s.history] == item.clip.name then return false end
        if strict >= 1 and recent(s, item.clip.name) then return false end
        if strict >= 2 and now - (s.used[item.clip.name] or -math.huge) < COOLDOWN then return false end
        return true
    end
    for strict = 2, 0, -1 do
        local total, pool = 0, {}
        for _, item in ipairs(list) do
            if eligible(item, strict) then
                local weight = (item.clip.character and 3 or 1) * (repeatable and 1 or M.motionWeight(item))
                total = total + weight
                pool[#pool + 1] = {item = item, weight = weight}
            end
        end
        if total > 0 then
            local roll = s.random() * total
            for _, entry in ipairs(pool) do
                roll = roll - entry.weight
                if roll <= 0 then return entry.item end
            end
            return pool[#pool].item
        end
    end
    return nil
end

local function remember(s, item, now)
    s.history[#s.history + 1] = item.clip.name
    if #s.history > HISTORY then table.remove(s.history, 1) end
    s.used[item.clip.name] = now
end

-- Speaking: emotion-weighted clips paced by intensity, fitted to the speech.
local function speaking(s, input)
    local family = M.families[input.family or 'neutral'] and input.family or 'unknown'
    local order = M.families[family]
    local useEmotion = family ~= 'neutral' and family ~= 'unknown' and s.random() < .6
    if useEmotion then
        local item = pick(s, candidates(input.clips, input.rig, input.character, order[1]), input.now, input.remaining)
        if item then return item end
    end
    -- Calm talk: one weighted pool across the filler categories, so shrugs,
    -- questions and emphatic hands mix with ordinary talking gestures.
    local pool = {}
    for _, category in ipairs(M.filler) do
        for _, item in ipairs(candidates(input.clips, input.rig, input.character, category)) do pool[#pool + 1] = item end
    end
    local item = pick(s, pool, input.now, input.remaining)
    if item then return item end
    -- Emotion clips did not fit or were exhausted: fall back across all.
    for _, category in ipairs(order) do
        local item = pick(s, candidates(input.clips, input.rig, input.character, category), input.now, input.remaining)
        if item then return item end
    end
    return nil
end

-- Returns {clip=..., duration=...} to start now, or nil. The controller calls
-- this every tick; mode changes reset pacing for the new turn.
function M.next(s, input)
    local now = input.now or 0
    if input.mode ~= s.mode then
        s.mode = input.mode
        if input.mode == 'speaking' then s.nextAt = now + between(s, .1, .4)
        elseif input.mode == 'listening' then s.nextAt = now + between(s, 2, 4)
        else s.nextAt = math.huge end
    end
    if input.busyUntil and now < input.busyUntil then return nil end
    if now < s.nextAt then return nil end
    local item
    if input.mode == 'speaking' then
        -- User decision: talk gestures only for fairly long replies.
        if input.total and input.total < M.minimumSpeech then return nil end
        if input.remaining and input.remaining < 1.2 then return nil end
        item = speaking(s, input)
    elseif input.mode == 'listening' then
        -- Nods may repeat: a listener nodding the same way twice reads naturally.
        item = pick(s, candidates(input.clips, input.rig, input.character, 'nod'), now, nil, true)
    else
        return nil
    end
    if not item then s.nextAt = now + 1; return nil end
    remember(s, item, now)
    local finish = now + item.duration
    if input.mode == 'speaking' then
        local scale = math.max(1, math.min(3, math.floor(tonumber(input.scale) or 1)))
        local low, high = gaps[scale][1], gaps[scale][2]
        s.nextAt = finish + between(s, low, high) / rate(input.character)
    else
        s.nextAt = finish + between(s, 5, 10)
    end
    return {clip = item.clip, duration = item.duration, ends = finish}
end

-- Signature idle component for a character key, else the generic stand-around.
function M.idleComponent(catalog, character)
    return catalog.idleComponents[character] or catalog.idleComponents.generic
end

return M
