-- Pure gesture selection policy (docs/COMPANION_GESTURES.md). No native calls,
-- no world handles: the controller supplies the clock, mode, rig, emotion,
-- remaining speech time and phrase timing, and plays whatever clip this
-- returns. Called per tick but does work only when a gesture may start (a
-- phrase start after the calm hold), never per frame.
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
M.filler = {'neutral', 'shrug', 'question'}
-- Categories that never colour a reply of the opposite mood (a sad line never
-- gets a happy or emphatic clip, a happy line never a sad one).
M.clash = {
    sadness = {happy = true, emphatic = true, angry = true, surprise = true},
    fear = {happy = true, emphatic = true, angry = true},
    trust = {angry = true, disgust = true},
    joy = {sad = true, fear = true, angry = true, disgust = true},
    anger = {happy = true, sad = true, fear = true},
}
-- How much arm a mood allows: largest measured hand reach (cm) at intensity 1;
-- each intensity step above 1 allows M.energyStep more. Sad and afraid lines
-- keep the hands small and close; joy, anger and surprise may open up.
M.energy = {sadness = 30, fear = 34, disgust = 42, trust = 45, neutral = 48, unknown = 48,
    anticipation = 54, surprise = 56, joy = 58, anger = 58}
M.energyStep = 6
-- Never played, whatever a catalog contains (user decision: no rude/strong gestures).
M.banned = {'threaten', 'fuck_you', 'clap', 'thumb_up', 'middle_finger', 'cheer', 'dance', 'step', 'turn',
    -- Symbolic or strong gestures, excluded by default (user decision, Oct 7):
    'fist', 'salute', 'go_away', 'come_closer', 'taunt', 'shoot', 'draw_gun', 'aim', 'kill', 'slit',
    'crack_knuckles', 'cracking_knuckles', 'be_quiet', 'shush', 'stop__angry', 'me__angry', 'talk_to_hand',
    -- Oct 7 capture: arms-overhead sweeps that read as cheering, not talking.
    'demonstrate', 'excercise', 'exercise', 'stretch', 'pull_up',
    -- Verified in the Oct 7 capture: a raised thumbs-up shape while Judy talks.
    'judy__stand_2h_arms_crossed__01__gesture__02'}
-- Directional by name (Oct 9, Judy feedback: pointing that made no sense):
-- pointing, indicating off to a side or behind, head flicks to a side and
-- looking away. The generated catalog marks these and every measured
-- directional clip with clip.exclude; the names guard catalogs without it.
M.directional = {'point', 'describe_left', 'describe_right', 'describe_back', 'head_flick_left', 'head_flick_right',
    'look_around', 'look_left', 'look_right', 'over_there', 'wave', 'indicate', 'beckon', 'show_way'}
-- Clips found to contain symbolic hand shapes by measurement (thumbs-up,
-- middle finger), generated into the catalog as clip.symbolic=true.
function M.symbolic(clip) return clip.symbolic == true end
-- Per character pacing: rate > 1 gestures more often.
M.profiles = {
    takemura = {rate = .7}, johnny = {rate = 1.2}, panam = {rate = 1.15}, kerry = {rate = 1.15},
    jackie = {rate = 1.1}, viktor = {rate = .85}, judy = {rate = 1}, river = {rate = .9},
    rogue = {rate = .85}, misty = {rate = .8}, hanako = {rate = .7}, saul = {rate = .75}, reed = {rate = .85},
}
-- Calm hold (seconds in the stance loop) after a clip, by intensity 1..3,
-- before the next clip may start; it then waits for a phrase start. The
-- stance loop (hands at sides, or Judy's folded arms) is the default between
-- gestures, never back-to-back clips (Oct 9 feedback).
M.holds = {{1.6, 3.2}, {1.2, 2.6}, {.9, 2.0}}
-- A clip starts only this soon after a phrase starts (when phrase timing is
-- known), so gestures land with the words rather than mid-phrase.
M.phraseWindow = .7
-- Now and then a phrase start is left calm, unless the hands rested a while.
M.restChance, M.restLongest = .2, 7
-- Expressive hand/arm gestures read from a distance; head flicks and nods
-- barely register, so they are mostly left for listening.
local subtle = {'head_flick', 'nod', 'yes__head', 'no__head', 'look_', 'shuffle', 'scratch', 'weight_shift', 'breathe'}
local expressive = {'explain', 'describe', 'demonstrate', 'gesture', 'shrug', 'calm_down', 'this_or_that',
    'confident', 'what', 'whatever', 'talk', '2h_', 'flick', 'rub_hands', 'me__'}
-- Measured hand reach (cm, scripts/Measure-GestureMotion.py) when known:
-- clips under 15 cm read as no gesture and are only used when nothing else
-- fits; above that the weight grows with reach. Name heuristics otherwise.
M.minimumReach = 15
function M.motionWeight(item)
    local reach = item.reach
    if type(reach) ~= 'number' then return M.expressiveness(item.clip.name) end
    if reach < M.minimumReach or reach > M.maximumReach then return .02 end
    -- Square root (Oct 10): a 45 cm clip no longer weighs three times an 18 cm one,
    -- so the few biggest clips do not take most of the picks.
    return math.min(2.2, math.sqrt(reach / 15))
end
function M.expressiveness(name)
    for _, word in ipairs(subtle) do if name:find(word, 1, true) then return .2 end end
    for _, word in ipairs(expressive) do if name:find(word, 1, true) then return 2.5 end end
    return 1
end
-- Measured share of a clip's moving frames with the hands in front of the
-- body between hips and chest (scripts/Measure-GestureShape.py): centred
-- clips are preferred (Oct 9: the good moments kept the hands in the centre).
function M.centreWeight(item)
    local centre = item.centre
    if type(centre) ~= 'number' then return 1 end
    return .35 + 1.3 * centre
end
M.minimumSpeech = 5 -- seconds of reply audio before talk gestures are used at all
-- Repetition window (Oct 10: "she did the same gesture twice"). The memory
-- belongs to the companion, not to a reply, so it carries across replies:
-- avoid the last HISTORY clips, the last two look-alike groups, the previous
-- clip's kind and anything used in the last COOLDOWN seconds, relaxing step by
-- step only when nothing else fits (and widening the mood's reach cap a little
-- before the last two steps, so a small emotional pool never forces a repeat).
M.history, M.cooldown, M.memory = 12, 75, 24
M.widen = 12 -- cm of extra reach allowed when the strict levels find nothing
M.openWeight = .6 -- clips that hold one hand out to a side (fit "open") weigh less
-- Above about 90 cm the hands go overhead (cheering, stretching): not talk.
M.maximumReach = 90
-- A clip whose feet start or end more than this far (cm, hip space) from the
-- stance loop's is blended at the hips and twists or crosses the legs (Oct 8).
M.maximumLegGap = 8

function M.allowed(name)
    for _, word in ipairs(M.banned) do
        if name:find(word, 1, true) then return false end
    end
    return true
end
-- True for a clip that must never play in conversation: catalog exclusion
-- (measured or named directional, sweeps, turns) or a directional name.
function M.excluded(clip)
    if clip.exclude then return true end
    local name = clip.name
    for _, word in ipairs(M.directional) do
        if name:find(word, 1, true) then return true end
    end
    return false
end
-- Gesture kind: the move without stance, emotion or variant, so two "yes"
-- nods, two "what" shrugs or Judy's two arm-crossed gestures count as the same
-- kind. Generated into the catalog as clip.kind; derived here otherwise.
function M.kind(clip)
    if clip.kind then return clip.kind end
    local rest = clip.name:match('__%d%d__(.+)$') or clip.name
    local kind = rest:match('^(.-)__') or rest
    clip.kind = kind
    return kind
end
-- Look-alike groups: moves that read as the same gesture from a few metres
-- (a right-hand flick, a describe-down and a describe-circle are all "one hand
-- sketches something small"). Recent groups weigh less and are skipped first.
local groups = {
    ['2h_flick'] = 'flick', rh_flick = 'flick', lh_flick = 'flick', describe_down = 'describe', describe_up = 'describe',
    describe_circle = 'describe', describe_front = 'describe', talk = 'talk', gesture = 'talk', gesture_hold = 'talk',
    what = 'what', what_is_this = 'what', cant_hear_you = 'what', shrug = 'shrug', whatever = 'shrug', yes = 'yes',
    nod = 'yes', head_flick_up = 'head', head_flick_down = 'head', calm_down = 'calm', stop = 'calm', me = 'self',
    this_or_that = 'weigh',
}
function M.group(clip)
    if clip.group then return clip.group end
    local kind = M.kind(clip)
    local group = groups[kind] or kind
    clip.group = group
    return group
end
-- Which hand a clip uses, from its name (rh_ / lh_ / 2h_), else nil.
function M.hand(clip)
    local name = clip.name
    if name:find('__rh_', 1, true) then return 'r' end
    if name:find('__lh_', 1, true) then return 'l' end
    if name:find('__2h_', 1, true) then return 'b' end
    return nil
end

function M.new(random)
    return {random = random or math.random, history = {}, kinds = {}, groups = {}, hands = {}, used = {}, mode = nil, nextAt = 0}
end

local function between(s, low, high) return low + (high - low) * s.random() end
local function rate(character) return (M.profiles[character] or {}).rate or 1 end
local function clampScale(scale) return math.max(1, math.min(3, math.floor(tonumber(scale) or 1))) end

-- Clips this rig/character may play, by category, within the mood's energy.
local function candidates(clips, rig, character, category, energy, into)
    local list = into or {}
    for _, clip in ipairs(clips or {}) do
        local onRig = clip.perRig and clip.perRig[rig]
        if onRig and clip.category == category then
            local reach = onRig.reach
            local overhead = type(reach) == 'number' and reach > M.maximumReach
            local legs = onRig.legs
            if type(legs) == 'number' and legs > M.maximumLegGap then overhead = true end
            local tooBig = energy and type(reach) == 'number' and reach > energy
            if not overhead and not tooBig and M.allowed(clip.name) and not M.symbolic(clip) and not M.excluded(clip)
                and (clip.character == nil or clip.character == character) then
                list[#list + 1] = {clip = clip, duration = onRig.duration, reach = reach, centre = onRig.centre,
                    open = clip.fit == 'open'}
            end
        end
    end
    return list
end

local function inHistory(s, name, depth)
    local count = #s.history
    for i = count, math.max(1, count - depth + 1), -1 do if s.history[i] == name then return true end end
    return false
end
local function countIn(list, value, depth)
    local n, count = 0, #list
    for i = count, math.max(1, count - depth + 1), -1 do if list[i] == value then n = n + 1 end end
    return n
end

-- Weighted pick with repetition control, over a list whose items may carry a
-- boost (emotion-coloured clips). Levels, strictest first:
--   4: not in the last HISTORY clips, group not in the last two picks, not the
--      previous kind, not used within COOLDOWN s;
--   3: not in the last 8 clips, not the previous group or kind, kind not twice
--      in the last 4;
--   2: not in the last 4 clips, not the previous kind;
--   1: not in the last 2 clips, not the previous kind;
--   0: not the previous clip (only a one-clip pool may repeat it).
-- Kinds and groups used recently, and the previous hand, weigh less (variety).
-- Returns the item and the level it was found at.
local function pick(s, list, now, remaining, sameKind, floor)
    local previous, previousKind = s.history[#s.history], s.kinds[#s.kinds]
    local previousGroup, previousHand = s.groups[#s.groups], s.hands[#s.hands]
    local function eligible(item, level)
        if remaining and item.duration * .7 > remaining then return false end
        local clip = item.clip
        local name, kind = clip.name, M.kind(clip)
        if name == previous and #list > 1 then return false end
        if level >= 1 and not sameKind and kind == previousKind then return false end
        if level == 1 and inHistory(s, name, 2) then return false end
        if level == 2 and inHistory(s, name, 4) then return false end
        if level == 3 and inHistory(s, name, 8) then return false end
        if level >= 4 and inHistory(s, name, M.history) then return false end
        if level >= 3 and not sameKind then
            if M.group(clip) == previousGroup then return false end
            if level == 3 and countIn(s.kinds, kind, 4) >= 2 then return false end
        end
        if level >= 4 then
            if now - (s.used[name] or -math.huge) < M.cooldown then return false end
            if not sameKind and countIn(s.groups, M.group(clip), 2) > 0 then return false end
        end
        return true
    end
    for level = 4, floor or 0, -1 do
        local total, pool = 0, {}
        for _, item in ipairs(list) do
            if eligible(item, level) then
                local weight = (item.clip.character and 1.5 or 1) * (item.boost or 1)
                if not sameKind then
                    weight = weight * M.motionWeight(item) * M.centreWeight(item)
                        / (1 + countIn(s.kinds, M.kind(item.clip), 6) + .5 * countIn(s.groups, M.group(item.clip), 4))
                    if item.open then weight = weight * M.openWeight end
                    local hand = M.hand(item.clip)
                    if hand and hand == previousHand then weight = weight * .5 end
                end
                total = total + weight
                pool[#pool + 1] = {item = item, weight = weight}
            end
        end
        if total > 0 then
            local roll = s.random() * total
            for _, entry in ipairs(pool) do
                roll = roll - entry.weight
                if roll <= 0 then return entry.item, level end
            end
            return pool[#pool].item, level
        end
    end
    return nil, -1
end

local function remember(s, item, now)
    local clip = item.clip
    s.history[#s.history + 1] = clip.name
    s.kinds[#s.kinds + 1] = M.kind(clip)
    s.groups[#s.groups + 1] = M.group(clip)
    s.hands[#s.hands + 1] = M.hand(clip) or false
    while #s.history > M.memory do table.remove(s.history, 1) end
    while #s.kinds > 8 do table.remove(s.kinds, 1) end
    while #s.groups > 8 do table.remove(s.groups, 1) end
    while #s.hands > 4 do table.remove(s.hands, 1) end
    s.used[clip.name] = now
end

-- One speaking pool at one energy. Emotion-coloured clips (when this pick is
-- coloured) are boosted inside the calm pool instead of replacing it, so a
-- mood with two or three clips of its own is exhausted into calm talk, not
-- repeated (Oct 10).
local function speakingPool(input, order, clash, energy, colour)
    local pool = {}
    for _, category in ipairs(M.filler) do
        if not clash[category] then candidates(input.clips, input.rig, input.character, category, energy, pool) end
    end
    if colour then
        local seen = {}
        for _, item in ipairs(pool) do seen[item.clip.name] = true end
        local own = {}
        for _, item in ipairs(candidates(input.clips, input.rig, input.character, order[1], energy)) do
            if not seen[item.clip.name] then own[#own + 1] = item end
        end
        if #own > 0 then
            -- Aim for about 60 % of fresh picks to be the emotion's own clips.
            local boost = math.max(1, math.min(8, 1.5 * #pool / #own))
            for _, item in ipairs(own) do item.boost = boost; pool[#pool + 1] = item end
        end
    end
    return pool
end

-- Speaking: emotion-weighted clips within the mood's energy, fitted to the speech.
local function speaking(s, input)
    local family = M.families[input.family or 'neutral'] and input.family or 'unknown'
    local order, clash = M.families[family], M.clash[family] or {}
    local energy = (M.energy[family] or M.energy.neutral) + (clampScale(input.scale) - 1) * M.energyStep
    local colour = family ~= 'neutral' and family ~= 'unknown' and s.random() < .6
    local item = pick(s, speakingPool(input, order, clash, energy, colour), input.now, input.remaining, false, 2)
    if item then return item end
    -- Nothing fresh within the mood's reach: allow a little more arm before
    -- relaxing the repetition rules any further.
    item = pick(s, speakingPool(input, order, clash, energy + M.widen, colour), input.now, input.remaining, false, 2)
    if item then return item end
    item = pick(s, speakingPool(input, order, clash, energy, colour), input.now, input.remaining, false, 0)
    if item then return item end
    -- Calm and emotional pools did not fit or were exhausted: fall back across
    -- the emotion's own categories, still within its energy.
    for _, category in ipairs(order) do
        if not clash[category] then
            item = pick(s, candidates(input.clips, input.rig, input.character, category, energy), input.now, input.remaining, false, 0)
            if item then return item end
        end
    end
    return nil
end

-- Returns {clip=..., duration=...} to start now, or nil. The controller calls
-- this every tick; a mode or reply change resets pacing for the new turn.
-- input.phraseAge (seconds since the latest phrase start, nil when unknown)
-- gates speaking clips to phrase starts.
function M.next(s, input)
    local now = input.now or 0
    if input.mode ~= s.mode or (input.reply ~= nil and input.reply ~= s.reply) then
        s.mode, s.reply, s.restedAt = input.mode, input.reply, now
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
        local age = input.phraseAge
        if age ~= nil then
            if age > M.phraseWindow then return nil end
            -- One decision per phrase start: rest or gesture.
            if s.phraseDecided == input.phraseAt then return nil end
            s.phraseDecided = input.phraseAt
            if (s.history[1] ~= nil) and now - (s.restedAt or now) < M.restLongest and s.random() < M.restChance then
                return nil
            end
        end
        item = speaking(s, input)
    elseif input.mode == 'listening' then
        -- Nods: the same kind by nature, but never the same clip twice running.
        item = (pick(s, candidates(input.clips, input.rig, input.character, 'nod'), now, nil, true))
    else
        return nil
    end
    if not item then s.nextAt = now + 1; return nil end
    remember(s, item, now)
    local finish = now + item.duration
    if input.mode == 'speaking' then
        local hold = M.holds[clampScale(input.scale)]
        s.nextAt = finish + between(s, hold[1], hold[2]) / rate(input.character)
        s.restedAt = s.nextAt
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
