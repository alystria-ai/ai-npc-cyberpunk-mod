-- The speech owner supplies its actor only for the current tick. Retain no
-- world entity/component handles, and make no native calls during abandon.
local M = convaiFacialPlayback or {}
local allowed = {
    jaw_mid_open = true, lips_apart_up = true, lips_apart_dn = true,
    lips_together_up = true, lips_together_dn = true,
    lips_l_funnel = true, lips_r_funnel = true, lips_l_purse = true,
    lips_r_purse = true, lips_l_stretch = true, lips_r_stretch = true,
    lips_l_lower_raise = true, lips_r_lower_raise = true,
    lips_tighten_up = true, lips_tighten_dn = true, lips_suck_dn = true, tongue_mid_tip_up = true,
    lips_l_upper_raise = true, lips_r_upper_raise = true,
    lips_l_corner_stretch = true, lips_r_corner_stretch = true, lips_suck_up = true,
    -- Used by the game-trained (JALI) model, all present in the 50-control graph.
    lips_puff_up = true, lips_puff_dn = true, cheek_l_puff = true, cheek_r_puff = true, tongue_mid_fwd = true,
}
local function finite(value)
    return type(value) == 'number' and value == value and value > -math.huge and value < math.huge
end
-- Validation bounds, not gains. They cover the ranges Cyberpunk's own
-- dialogue lipsync writes to these LipsyncPoseOutput tracks (measured over the
-- extracted JALI corpus; docs/GAME_LIPSYNC_MODEL.md): jaw ~.66, lip contact
-- 1.1 (the solver clamps at 1), lower roll ~.72, upper roll ~.29, puff ~.38.
local limits = {jaw_mid_open = .7, lips_together_up = 1, lips_together_dn = 1, lips_suck_dn = .8,
    lips_suck_up = .3, lips_puff_up = .45, lips_puff_dn = .45, cheek_l_puff = .35, cheek_r_puff = .35}
local function trackLimit(track)
    return limits[track] or .5
end
-- Native core, system "faces" (native/core/src/systems/faces, docs/NATIVE_PORT_BRIEF.md). When the plugin is
-- loaded and the switch is on (no line "faces" in runtime/native-off.txt), the per-frame
-- writer runs in C++: one call computes the pose block of a slot (pose, droop, flicks, mouth budget, ducks,
-- voice brows, written and applied poses) and writes the ConvaiFaceFeature and applies it, instead of about 100
-- CET property and method calls per actor and frame. The slot lifecycle, blinkWeight, ownerLevel and the speech
-- track interpolation stay here. Lua stays the fallback: any fault, a missing class or the switch returns every
-- function below to its own path for the rest of the session. `native` is chosen once per frame in
-- beginExpressionFrame; a flip restarts every slot's pose block from neutral on both sides.
local native=false
local nativeFaces
local nativeSeq=0
-- slot id of the turn record in lastSpeechExpression (kept off the record, which is published as JSON)
local turnNid=setmetatable({},{__mode='k'})
-- ConvaiFaceFeature fields in declaration order (r6/scripts/CyberpunkConvai/FaceFeature.reds), 1-based; the
-- dense speech vector handed to the plugin is indexed by them. bridge/facial-playback-native.test.mjs checks it.
local FIELD={jaw_mid_open=1,jaw_mid_shift_fwd=2,jaw_mid_shift_l=3,jaw_mid_shift_r=4,lips_apart_up=5,lips_apart_dn=6,lips_together_up=7,lips_together_dn=8,lips_l_funnel=9,lips_r_funnel=10,lips_l_purse=11,lips_r_purse=12,lips_l_stretch=13,lips_r_stretch=14,lips_l_corner_stretch=15,lips_r_corner_stretch=16,lips_l_corner_up=17,lips_r_corner_up=18,lips_l_corner_dn=19,lips_r_corner_dn=20,lips_l_upper_raise=21,lips_r_upper_raise=22,lips_l_lower_raise=23,lips_r_lower_raise=24,lips_tighten_up=25,lips_tighten_dn=26,lips_puff_up=27,lips_puff_dn=28,lips_suck_up=29,lips_suck_dn=30,lips_mid_shift_l=31,lips_mid_shift_r=32,cheek_l_puff=33,cheek_r_puff=34,cheek_l_suck=35,cheek_r_suck=36,eye_l_blink=37,eye_r_blink=38,eye_l_widen=39,eye_r_widen=40,eye_l_brows_raise_in=41,eye_r_brows_raise_in=42,eye_l_brows_raise_out=43,eye_r_brows_raise_out=44,eye_l_brows_lower=45,eye_r_brows_lower=46,eye_l_oculi_squint_outer_lower=47,eye_r_oculi_squint_outer_lower=48,tongue_mid_fwd=49,tongue_mid_tip_up=50,eye_l_brows_lateral=51,eye_r_brows_lateral=52,eye_l_oculi_squint_outer_upper=53,eye_r_oculi_squint_outer_upper=54,eye_l_oculi_squint_inner=55,eye_r_oculi_squint_inner=56,nose_l_snear=57,nose_r_snear=58,lips_chin_raise=59,speech_owner=60}
local function nativeFailed(err)
    native=false
    local api=convaiNative
    if type(api)=='table' and type(api.fail)=='function' then pcall(api.fail,'faces',err) end
end
-- Status code returned by ConvaiNativeFaces.Frame: 1 applied, 2 settled, 4 pose inner brows < .2,
-- 8 inner brows > .35, 16 corner-down > .15 (negative: -1 the game rejected the frame, -2 plugin fault).
local function has(code,flag) return code%(flag*2)>=flag end
local function newSpeechVec()
    local vec={};for i=1,60 do vec[i]=0 end;return vec
end
-- The control array handed to Frame (layout: native/core/src/systems/faces/core/FacesCore.hpp, namespace ctl,
-- 1-based here) and the empty speech vector of idle frames. Reused: no table is built per frame. Both cross as
-- array:Float (CET converts a Lua table of numbers straight to the array; this game has no array:Double, so a Double
-- array would keep the whole system on Lua). Every entry is a number, never nil.
local ctl={};for i=1,31 do ctl[i]=0 end
local EMPTY={}
local FAMILY={joy=1,trust=2,sadness=3,anger=4,fear=5,disgust=6,surprise=7,anticipation=8,neutral=9,unknown=10}
local slotsNative=false
-- The speaker: whoever speech.lua is voicing right now, a managed companion or
-- a world NPC (ambient resident, archetype, named character met in the world).
-- ConvaiFaceReady() is the native ownership proof: a tagged companion copy or a
-- world NPC whose face_rig ConvaiFaceService prepared (Face.reds). Speech hands
-- only its own target here, matched to the reply's entity.
local function speaker(actor, entity)
    if native and actor then
        local ok,answer=pcall(native.Speaker,actor,entity or M.entity or '')
        if ok and answer==1 then return true elseif ok and answer==0 then return false end
        if not ok then nativeFailed(answer) end
    end
    return actor and tostring(actor:GetEntityID().hash) == (entity or M.entity)
        and actor:IsAttached() and not actor:IsDeadNoStatPool() and actor:ConvaiFaceReady()
end
-- Idle, thinking and listening faces stay on managed companions, and on a holocall's live-picture copy while its picture
-- is up (mod/holocall.lua ownsFace).
local function owns(actor, entity)
    return actor and ((convaiCompanions and convaiCompanions.owns(actor))
        or (convaiHolocall and convaiHolocall.ownsFace and convaiHolocall.ownsFace(actor))) and speaker(actor, entity)
end
-- Speech and expressions share this one native writer. These per-copy entries
-- retain primitives and feature values only, never actors or world components.
local expressionTracks = {'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn',
    'eye_l_brows_raise_in','eye_r_brows_raise_in','eye_l_brows_raise_out','eye_r_brows_raise_out',
    'eye_l_brows_lower','eye_r_brows_lower',
    -- Duchenne smile: the outer-eye / lower-lid squint that makes a smile read as genuine
    -- (since October 9 also the narrowed eyes of anger and disgust).
    'eye_l_oculi_squint_outer_lower','eye_r_oculi_squint_outer_lower',
    -- October 9: widened eyes for surprise and fear (no speech or gaze writer uses them).
    'eye_l_widen','eye_r_widen'}
-- October 9 (evening, user: "I can't tell the difference in angry"): nine more native rig controls joined the
-- graph layer (assets/facial/controls.json). On Judy's rig (reconstructed solver) the brows' lateral pull moves the
-- brows 7.2 mm at 1, the upper-lid squint 5.5 mm, against 4.4 mm for brows lower; the nose sneer 6 mm; the chin
-- raise 3.2 mm. They exist only with the new FaceFeature.reds and archive (a game restart), so they are appended
-- after the first write proves the feature has them; an older install keeps the base controls.
local extendedTracks = {'eye_l_brows_lateral','eye_r_brows_lateral','eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper',
    'eye_l_oculi_squint_inner','eye_r_oculi_squint_inner','nose_l_snear','nose_r_snear','lips_chin_raise'}
local extendedFace
local function detectExtended(feature)
    if extendedFace~=nil then return end
    extendedFace=pcall(function() local value=feature.eye_l_brows_lateral;feature.eye_l_brows_lateral=type(value)=='number' and value or 0 end)
    M.extendedFace=extendedFace
    if extendedFace then for _,track in ipairs(extendedTracks) do expressionTracks[#expressionTracks+1]=track end end
end
-- October 10 (the mouth that sometimes stays shut): the graph feeds the face solver a facial idle at all times (a looped
-- idle__<emotion> clip, a workspot's or a scene's), and the speech deltas are only ADDED to it, so an idle that holds
-- lips_together or jaw_mid_close at that moment seals a written jaw. speech_owner (assets/facial/controls.json "owner",
-- scripts/Build-FacialGraphs.mjs) makes the solver fade the idle's mouth, jaw and lip controls as the game's own dialogue
-- lipsync does: 0 leaves the native face untouched, 1 hands the whole mouth to this writer. It is 1 only while a reply
-- is being heard (eased in over ownRise, out with the release ease and over ownFall once the idle writer takes the
-- face back), never while blocked. Eyes, brows and blinks are not faded. An install without the field (an older reds
-- build) keeps the previous behavior; probed once like the extended controls.
local ownRise,ownFall=.10,.15
local ownerFace
local function detectOwner(feature)
    if ownerFace~=nil then return end
    ownerFace=pcall(function() local value=feature.speech_owner;feature.speech_owner=type(value)=='number' and value or 0 end)
    M.ownerFace=ownerFace
end
-- 1 while a reply is heard (eased in over ownRise, scaled by the release ease of a pause), easing back over ownFall
-- once the idle writer has the face (a gap between Omni phrases barely lets go), 0 at once while blocked.
local function ownerLevel(slot,phase,blocked)
    local dt=M.expressionDelta or 0
    local level=slot.ownLevel or 0
    if blocked then level=0
    elseif phase=='speaking' then level=math.min(1,level+dt/ownRise)
    else level=math.max(0,level-dt/ownFall) end
    slot.ownLevel=level
    local release=M.release
    if phase=='speaking' and release and release.level then return level*math.max(0,math.min(1,release.level)) end
    return level
end
local negative = {anger=true,sadness=true,fear=true,disgust=true}
local families = {
    joy='joy',happy='joy',happiness='joy',ecstasy='joy',serenity='joy',
    trust='trust',acceptance='trust',admiration='trust',love='trust',
    sadness='sadness',sad='sadness',grief='sadness',pensiveness='sadness',
    anger='anger',angry='anger',rage='anger',annoyance='anger',
    fear='fear',terror='fear',apprehension='fear',anxiety='fear',
    disgust='disgust',loathing='disgust',boredom='disgust',
    surprise='surprise',amazement='surprise',distraction='surprise',
    anticipation='anticipation',interest='anticipation',vigilance='anticipation',
    neutral='neutral',none='neutral'}
local function zeroExpression()
    local pose={};for _,track in ipairs(expressionTracks) do pose[track]=0 end;return pose
end
-- The native core keeps a speech turn's peak pose, peak jaw and open-jaw frames; they are read back here when the
-- record is published (and once more when the slot goes away), never per frame.
local function mergeTurn(turn)
    local nid=turn and turnNid[turn]
    if not (native and nid) then return end
    local ok,text=pcall(native.Turn,nid)
    if not ok or type(text)~='string' or text=='' then return end
    local index=0
    for number in text:gmatch('%S+') do
        index=index+1
        local value=tonumber(number)
        if index==1 then turn.jawPeak=value
        elseif index==2 then turn.openFrames=value
        else
            local track=expressionTracks[index-2]
            if track and value then turn.peak[track]=value end
        end
    end
end
local function clamp(value,maximum) return math.max(0,math.min(maximum or 1,value)) end
-- Cyberpunk's own dialogue lipsync (6938 extracted lines) holds ONE constant
-- mood offset per line on these controls: smile = corner up .10 + brows raise
-- .10 (39 % of lines), frown = corner down .20 + brows lower .324 (20 %).
-- The caps follow those authored offsets with headroom for the strongest
-- (scale 3) feelings. Mirrors EXPRESSION_POLICY in companion-expressions.mjs.
-- October 9, in-game captures of Judy at conversation distance (writer probe): every control
-- reaches the rig, but brows read only from about .5 (a crease, a lifted or lowered arch),
-- corners down stay subtle on her rig even at 1, corners up read from about .3, the squint and
-- the widened eyes from about .3. Caps raised: corners .8, brows .9, squint .5, widen .6.
local function expressionLimit(track)
    if track:find('squint_outer_upper',1,true) then return .8 end
    if track:find('squint_inner',1,true) then return .6 end
    if track:find('squint',1,true) then return .5 end
    if track:find('widen',1,true) then return .7 end
    if track:find('snear',1,true) then return .6 end
    if track=='lips_chin_raise' then return .5 end
    if track:find('corner_',1,true) then return .80 end
    return .90
end
local scaleStrength={.4,.67,1}
-- Resting warmth: a light smile while not speaking (idle, and since October 9 also
-- listening and thinking, until the reply is heard) (October 8, user: keep Judy's light
-- resting smile, just never on sad topics). While speaking, the face is exactly the
-- bridge's context selector (bridge/emotion-selector.mjs) with no smile layered
-- under it; after a sad, angry, scared or disgusted turn the idle face stays neutral
-- for a minute (see moodUntil), or 10 s after a later calm turn, then eases back.
-- Slightly below the October 7 levels: warm .18, default .12, dry .05, cold 0; Judy
-- .12 with her corner gain 1.6 (about .19 on her rig; full lips read weakly, the
-- face-test probe showed .35-.5 needed). The gain scales the corner caps by at most
-- 1.3. Keys are profile keys from the actor rows. Mirrors EXPRESSION_POLICY.restSmile.
local restSmile=.12
-- smile = a multiplier on the EMOTION's smile only (never the resting smile or the frowns). Measured in game on two
-- rigs (docs/COMPANION_EXPRESSIONS.md, October 9 "smile calibration"): Judy's own head stretched at joy .45 x gain 1.6
-- (.72), so she gets .7 (about .50 written); the shared *_average_sermo heads (Evelyn and the other named and crowd
-- women, the men) barely smiled at .45 and read as natural at about .6, so every other character gets 1.3.
local defaultSmile=1.65
-- squint = the cheek/lower-lid squint follows the emotion's smile times this (Duchenne). A smile that grew with the
-- multiplier needs a matching squint (.27 -> .35 at joy on the default heads, captures docs October 9); Judy keeps 1.
local defaultSquint=1.3
local traitTable={default={warmth=restSmile,gain=1,smile=defaultSmile,squint=defaultSquint}}
for _,key in ipairs({'panam-palmer','jackie-welles','kerry-eurodyne','misty-olszewski','mama-welles','river-ward',
    'claire-russell','dexter-deshawn','padre-ibarra','viktor-vektor'}) do traitTable[key]={warmth=.18,gain=1,smile=defaultSmile,squint=defaultSquint} end
-- Judy's brows rest high (her idle arch): the lowering controls get a quarter more (browDown).
traitTable['judy-alvarez']={warmth=.12,gain=1.6,browDown=1.25,smile=.7,squint=1,jawLift=false}
for _,key in ipairs({'johnny-silverhand','rogue-amendiares','takemura','saul-bright','meredith-stout','solomon-reed',
    'spider-murphy','r3n0','regina-jones'}) do traitTable[key]={warmth=.05,gain=1,smile=defaultSmile,squint=defaultSquint} end
for _,key in ipairs({'adam-smasher','yorinobu-arasaka','hanako-arasaka','alan-noel','mr-hands'}) do traitTable[key]={warmth=0,gain=1,smile=defaultSmile,squint=defaultSquint} end
-- Alt Cunningham (2026-10-14): a cold, level register, but her native rest face (brows low, corners flat) may read stern, so her
-- idle rests at the dry level (.05, as for Johnny and Rogue; the default is .12) instead of 0; her emotion smile keeps the default multiplier.
-- A conservative first value: needs a screenshot of her idle face in game before it is raised, or lowered back to 0 (cold).
traitTable['alt-cunningham']={warmth=.05,gain=1,smile=defaultSmile,squint=defaultSquint}
-- Mood hold after a negative turn: seconds of neutral rest, a shorter hold once a
-- later turn was calm, and the ease back to the resting smile.
local moodHoldSeconds,moodCalmSeconds,moodEaseSeconds,moodThreshold=60,10,5,.2
local function traitFor(profile) return traitTable[profile] or traitTable.default end
local speechMouthFactor=.85
-- The jaw weight (as written) from which a speaking, jaw-lifted head carries no chin raise / no corner depressors.
local chinDuckJaw,cornerDuckJaw=.10,.20
-- October 10 (user: "a bit of snapping when she speaks", "her mouth stays half open while the next line loads"):
-- the speech-mouth factors (the closure/rounding budget and the two ducks above) used to jump from one frame to the
-- next, so a smile or a frown pumped on and off at syllable rate (measured on a saved Pocket reply: the smile corner
-- dropped .35 to 0 in three frames at every rounded vowel). They now move with an attack and a release, fast enough
-- that a closing or rounding mouth never fights a corner pull, slow enough to read as a mouth, not a flicker.
local budgetFall,budgetRise=.07,.18
local duckFall,duckRise=.07,.18
-- A continuous (streamed) reply whose heard cursor stops while the renderer still says "playing" (an underrun the file
-- has not reported yet, a state read that keeps failing) used to hold the last written jaw, half open. After
-- stallSeconds without a new cursor, and on every pause of a heard reply, the speech tracks ease to zero over
-- releaseSeconds and the face is handed to the idle writer (the old pause closed the mouth in one frame).
local stallSeconds,releaseSeconds=.20,.12
-- October 9 (user: Evelyn and Johnny, with wider, thinner lips than Judy, "don't open the mouth on some words"):
-- every speech source is calibrated on Judy's rig, where a jaw weight of .06 already parts her lips. Measured in game
-- on 23 characters (docs/COMPANION_EXPRESSIONS.md, lip sync round): the shared woman_average heads (Evelyn, Alex, Claire,
-- Lizzy, Mama Welles, Meredith, Misty, Panam, Regina, Rogue, Songbird, Wakako) keep their lips sealed until about .20,
-- and the man_average / man_big / man_fat heads part them later and less than Judy. Typical speech sits at jaw .04-.15
-- (median .12), so many words never broke the seal. The jaw weight is lifted by a concave curve that is steepest at 0 and
-- exactly the identity at the validation ceiling, so the widest vowels are unchanged and silence stays closed:
--   jaw' = .7 * (1 - (1 - jaw / .7) ^ q)       q = 2: .06 -> .115, .12 -> .22, .20 -> .36, .37 -> .55
-- Same day, second round (user: Evelyn "sometimes does not open", e.g. "and fill it with exactly"): the curve alone is
-- not enough for the low-jaw sounds (f, th, l, w, short i). The model gives them a jaw of only .08-.11, which the curve
-- maps to .15-.20, right at the edge where Evelyn's lips part (measured in game, jaw written raw: sealed at .08-.10, a
-- thin line at .12-.14, teeth show from .16, clearly open from .20). So speech also gets a floor: once the model's jaw
-- says "speaking" (smoothstep from .02 to .07) the written jaw is at least `floor`, a per-head-type constant just above
-- the parting point; below .02 (silence, the breath between words) nothing changes, and closures stay with
-- lips_together. jaw' = max(curve, floor * smoothstep((jaw-.02)/.05)).
-- q and floor are constants per head type (the facial graph name, read once per reply, never per frame), or a
-- per-character override (traitTable[profile].jawLift = {q=,floor=}, false = none). Judy's graph
-- (player_woman_photomode) has no entry: unchanged.
-- October 15 (user: "not much variety in lipsync shapes ... just simple up and down"): the lift above is applied only
-- when the face graph has no speech_owner input (an archive older than October 10). Every sweep that measured the parting
-- points (October 9) predates speech_owner: the idle clip's own lips_together (.7-1.0) was still added under the speech
-- deltas, so the sealed lips the lift was fitted to were the idle's, not the head's. With the idle mouth handed over
-- (speech_owner 1) Alex's woman_average lips part at a jaw of .06 and show teeth at .12, like Judy's (captured
-- 2026-10-15, docs/LIPSYNC_APPLICATION_2026-10-15.md). The lift then doubled every low jaw (median .17 -> .30, 90 % of
-- speaking frames held at .21 or more), so the mouth never closed between syllables, rounded and spread vowels opened into
-- the same "ah", and the game's own curves (Rogue, same head type) looked as flat as the model's. The head's lift entry is
-- still read (M.jawLift): it marks the head types whose chin raise and corner depressors give way while speaking.
-- Same day: the game-trained model reaches only part of the game's own peaks on the shape controls (held-out corpus,
-- docs/LIPSYNC_V2_RESEARCH_2026-10-14.md: spread family 66-70 %, purse 75 %, jaw 85 %; upper-lip raise about 40 % on the
-- Rogue line), so rounded and spread vowels read as small variations of one opening. A model (local-jali) timeline is
-- scaled per control towards the game's reach, then clamped to the validation bounds; contacts, rolls, funnel (which
-- overshoots), puffs and tongue are left as they are. One multiply per written track, inside the existing loop.
local modelReach={jaw_mid_open=1.15,lips_l_purse=1.35,lips_r_purse=1.35,lips_l_corner_stretch=1.45,
    lips_r_corner_stretch=1.45,lips_l_stretch=1.45,lips_r_stretch=1.45,lips_l_lower_raise=1.3,lips_r_lower_raise=1.3,
    lips_l_upper_raise=1.4,lips_r_upper_raise=1.4}
M.modelReach=modelReach
local jawLimit=.7
local jawLiftByGraph={woman_average={q=2,floor=.21},man_average={q=1.5,floor=.17},man_big={q=1.5,floor=.17},
    man_fat={q=1.5,floor=.17}}
local function jawLiftFor(actor,entity)
    local slot=M.expressions[entity]
    local trait=slot and traitTable[slot.profile]
    if trait and trait.jawLift~=nil then return trait.jawLift or nil end
    local ok,status=pcall(function() return actor:ConvaiFaceStatus() end)
    local graph=ok and type(status)=='string' and status:match('^prepared:(.-)_sermo$') or nil
    return graph and jawLiftByGraph[graph] or nil
end
local function liftJaw(value,lift)
    local rest=1-value/jawLimit
    local lifted=rest>0 and jawLimit*(1-rest^lift.q) or jawLimit
    local x=(value-.02)/.05
    if x<=0 then return lifted end
    if x>1 then x=1 end
    local floor=lift.floor*x*x*(3-2*x)
    return lifted>floor and lifted or floor
end
M.expressions, M.expressionClock, M.expressionFrame = {}, 0, 0
-- Ordinary world NPCs (crowd, vendors, gangs, archetype characters) get the gated speech layer at their own spawn,
-- decided in Face.reds (OnWorldInitialize), never here. Gate: the layer sits behind one switch in the graph that
-- "speech_owner > 0" opens, and speech_owner is written only by the writer below while that NPC's reply is heard
-- (ownerLevel, applyFeature) and zeroed by reset(): the switch is open for the talking NPC from its first speaking
-- frame and closed again at the release, with no extra call. Everything else about the mouth (mapArkit, the retargeted
-- tracks, jawLiftFor) is the companions' own path.
-- The one thing configured here is a development switch for the FPS comparison (docs/FACIAL_ANIMATION.md, "Ordinary
-- NPCs"): runtime/crowd-face-mode.txt with one word: "off" (no ordinary NPC is touched), "ungated" (the layer is always
-- evaluated) or "gated" (shipping; also what a missing file means, and then nothing is sent). It is read once per load
-- (a CET reload reads it again) and handed to the redscript service once; no per-frame work. It applies to NPCs that
-- spawn afterwards, so reload the save.
local crowdModes={off=true,ungated=true,gated=true}
function M.crowdModeRequested()
    local opener=io and io.open
    local file=opener and opener('runtime/crowd-face-mode.txt','rb')
    if not file then return nil end
    local text=file:read('*a')
    file:close()
    -- PowerShell writes a byte-order mark with Set-Content/Out-File -Encoding utf8.
    if type(text)=='string' then text=text:gsub('^\239\187\191','') end
    local word=type(text)=='string' and text:match('^%s*(%a+)') or nil
    word=word and word:lower() or nil
    if crowdModes[word] then return word end
    return nil,'invalid'
end
-- The face service (Face.reds). Codeware provides the service container's entry; without Codeware there is none, and this says so
-- instead of failing on a nil. Callers hold it in a pcall.
local function faceService()
    local container=Game.GetScriptableServiceContainer and Game.GetScriptableServiceContainer()
    local service=container and container:GetService(CName.new('ConvaiFaceService'))
    if not service then error('the face service does not exist (Codeware is missing)',0) end
    return service
end
-- requested word (nil when there is no file), the mode the game reports (nil when it could not be set), error text.
function M.applyCrowdMode()
    local requested,problem=M.crowdModeRequested()
    M.crowdMode=nil
    if not requested then
        if problem then M.crowdMode='invalid-file' end
        return nil,nil,problem
    end
    local ok,result=pcall(function()
        local service=faceService()
        return service:SetCrowdMode(requested)
    end)
    local applied=ok and type(result)=='string' and result or nil
    -- The perf probe stamps this on every window: a switch that did not take must not read as the default.
    M.crowdMode=applied or ('failed:'..requested)
    if ok then return requested,applied,nil end
    return requested,applied,tostring(result)
end
-- Talk to story characters (docs/WORLD_CHARACTERS.md): the face service prepares a named game character's face when that character
-- spawns, so it must know the setting before the world loads. Called at start-up and each time a world is released; never per
-- frame. True when the service took it.
function M.applyStoryTalk(enabled)
    local ok,result=pcall(function()
        local service=faceService()
        return service:SetStoryTalk(enabled==true)
    end)
    M.storyTalk=ok and result==true
    if ok and type(result)=='boolean' and result==(enabled==true) then return true end
    return false,tostring(result)
end
-- Development-only visibility probe (mod/face-test.lua). It is absent from a
-- normal install, inert until a runtime request file appears, and errors in it
-- can never reach speech or the writer (every call below is pcall-wrapped).
local faceTest
do
    local opener=io and io.open
    local file=opener and opener('face-test.lua','rb')
    if file then
        file:close()
        local ok,module=pcall(dofile,'face-test.lua')
        if ok and type(module)=='table' then faceTest=module end
    end
end
M.faceTest=faceTest
-- The visibility probe (mod/face-test.lua) only touches the writer while a run, a trace or leftover fields exist; a
-- loaded but idle probe lets the face sleep like any other (its mailbox poll runs in beginExpressionFrame).
local function probeBusy()
    local probe=faceTest
    if not probe then return false end
    return probe.run~=nil or probe.trace~=nil
        or next(probe.policyTouched or EMPTY)~=nil or next(probe.touched or EMPTY)~=nil
end
local function expressionSlot(entity)
    if not M.expressions[entity] then
        nativeSeq=nativeSeq+1
        M.expressions[entity]={pose=zeroExpression(),sequence=-1,nid=nativeSeq}
    end
    return M.expressions[entity]
end
local function sameExpressionOwner(slot,context)
    return type(context)=='table' and slot.requestId==context.requestId and slot.generation==context.generation
end
function M.beginExpression(context,receipt)
    if type(context)~='table' or type(context.entity)~='string' then return end
    local slot=expressionSlot(context.entity)
    if not sameExpressionOwner(slot,context) or not slot.active then
        slot.requestId,slot.generation,slot.active=context.requestId,context.generation,true
        -- October 9 (user: her idle mood went bland before the lip sync started): the face keeps what it shows
        -- (the resting smile, a lingering reaction) until this reply is HEARD. The reset and the reply's own cue
        -- wait for its first speaking frame (startHeard), where the usual smoothing carries the change.
        slot.sequence,slot.awaitingAudio,slot.turnNegative=-1,true,0
        slot.cueEmotion,slot.cueFamily,slot.cueScale=nil,nil,nil
    end
    M.acceptExpression(context,receipt)
end
-- The reply's first audible frame: retire what the face showed before and take the reply's cue.
local function startHeard(slot)
    slot.awaitingAudio=false
    slot.emotion,slot.family,slot.scale,slot.expiry=slot.cueEmotion,slot.cueFamily,slot.cueScale,nil
    slot.cueEmotion,slot.cueFamily,slot.cueScale=nil,nil,nil
    slot.holdMix=nil;slot.browExpiry=nil;slot.flick={};slot.flickReset=true;slot.turnNegative=0
end
-- The reply is audible (the first speaking frame does this itself; callers without a speech timeline use it).
function M.expressionHeard(context)
    local slot=type(context)=='table' and M.expressions[context.entity]
    if slot and slot.active and slot.awaitingAudio and sameExpressionOwner(slot,context) then startHeard(slot) end
end
function M.acceptExpression(context,receipt)
    if type(context)~='table' or type(receipt)~='table' then return false end
    local slot=M.expressions[context.entity]
    if not slot or not slot.active or not sameExpressionOwner(slot,context) or receipt.version~=1
        or type(context.entity)~='string' or #context.entity==0 or #context.entity>128 or context.entity:find('%c')
        or type(context.requestId)~='string' or #context.requestId==0 or #context.requestId>256 or context.requestId:find('%c')
        or receipt.entity~=context.entity or receipt.requestId~=context.requestId
        or not finite(context.generation) or context.generation<0 or context.generation%1~=0
        or context.generation>2147483647
        or receipt.generation~=context.generation or not finite(receipt.sequence)
        or receipt.sequence<0 or receipt.sequence>9007199254740991 or receipt.sequence%1~=0 or receipt.sequence<=slot.sequence
        or type(receipt.emotion)~='string' or #receipt.emotion==0 or #receipt.emotion>80 or receipt.emotion:find('%c')
        or not finite(receipt.scale) or receipt.scale<1 or receipt.scale>3 or receipt.scale%1~=0 then return false end
    local label=receipt.emotion:match('^%s*(.-)%s*$')
    if label=='' then return false end
    if slot.awaitingAudio then
        slot.cueEmotion,slot.cueFamily,slot.cueScale,slot.sequence=label,families[label:lower()] or 'unknown',receipt.scale,receipt.sequence
    else
        slot.emotion,slot.family,slot.scale,slot.sequence=label,families[label:lower()] or 'unknown',receipt.scale,receipt.sequence
    end
    return true
end
function M.endExpression(context,finished)
    local slot=type(context)=='table' and M.expressions[context.entity]
    if not slot or not sameExpressionOwner(slot,context) then return end
    slot.active=false
    -- Never heard (cancelled, failed or replaced before its audio): the face simply keeps what it showed.
    if slot.awaitingAudio then slot.awaitingAudio=false;slot.cueEmotion,slot.cueFamily,slot.cueScale=nil,nil,nil;return end
    -- A negative turn keeps the idle face neutral for a while; a calm turn shortens it.
    if (slot.turnNegative or 0)>=moodThreshold then slot.moodUntil=M.expressionClock+moodHoldSeconds
    elseif slot.moodUntil and slot.moodUntil>M.expressionClock then
        slot.moodUntil=math.min(slot.moodUntil,M.expressionClock+moodCalmSeconds) end
    slot.turnNegative=0
    if finished and (slot.emotion or slot.holdMix) then slot.expiry=M.expressionClock+(negative[slot.family] and 8 or 4)
        slot.browExpiry=M.expressionClock+1.5
    else
        slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil;slot.pose=zeroExpression()
        if native then pcall(native.ZeroPose,slot.nid);slot.nativeGaze=4 end
    end
end
-- Drops a copy's slot (and its native pose block).
local function forget(entity)
    local slot=M.expressions[entity]
    if native and slot and slot.nid then
        local turn=M.lastSpeechExpression
        if turn and turnNid[turn]==slot.nid then mergeTurn(turn) end
        pcall(native.Release,slot.nid)
    end
    M.expressions[entity]=nil
end
function M.clearExpression(entity)
    forget(entity)
end
-- The native class for this frame, or nil: the plugin is loaded, the "faces" switch is on, the class is registered and
-- a test call proves the arrays cross intact. A failure here (or in any later call) puts "faces" on Lua for good. When
-- the plugin refused the system at registration (ConvaiNative.SystemEnabled('faces') false) api.use answers false and
-- ConvaiNativeFaces is never touched.
local function nativeFor()
    local api=convaiNative
    if (faceTest and probeBusy()) or type(api)~='table' or type(api.use)~='function' then return nil end
    local ok,on=pcall(api.use,'faces')
    if not (ok and on) then return nil end
    if not nativeFaces then
        local found,class=pcall(function() return ConvaiNativeFaces end)
        if not found or (type(class)~='table' and type(class)~='userdata') then
            pcall(api.fail,'faces','ConvaiNativeFaces is not registered')
            return nil
        end
        local good,count=pcall(class.Check,ctl,newSpeechVec())
        if not good or count~=#ctl*1000+60 then
            pcall(api.fail,'faces','array check failed: '..tostring(count))
            return nil
        end
        nativeFaces=class
    end
    return nativeFaces
end
-- native.Safe answers -1 when the plugin cannot read the combat flag (the game version has no function it can resolve), and the Lua check
-- then decides. Asking again only repeats the plugin's lookup on every face frame, so after a -1 it is asked again only every 30 s of
-- expression time (a flip of the switch asks again at once, restartPoseBlocks).
local SAFE_RETRY_S=30
local safeUnknownUntil=-math.huge
-- The first SAFE_VERIFY native Safe answers are compared with the Lua check (see safeExpressionActor).
local SAFE_VERIFY=40
local safeChecked=0
-- A switch flip restarts every face's pose block from neutral on both sides (the two paths keep the same numbers in
-- different places, and copying them across is not worth a path that runs only when a switch is thrown). The feature
-- objects are dropped too, so no blink or pose written by the other path stays on a reused object.
local function restartPoseBlocks()
    safeUnknownUntil=-math.huge
    if nativeFaces then pcall(nativeFaces.Clear) end
    for _,slot in pairs(M.expressions) do
        slot.pose=zeroExpression();slot.droop=nil;slot.flick=nil;slot.flickReset=nil
        slot.mouthBudget,slot.chinDuck,slot.cornerDuck=nil,nil,nil
        slot.writtenPose,slot.appliedPose,slot.settled,slot.sleepAt=nil,nil,false,nil
        slot.voiceBrowOn,slot.voiceBrowReady,slot.blinkWritten,slot.nativeGaze=nil,nil,nil,nil
        slot.feature=nil;slot.heldFeature,slot.held=nil,nil
    end
    if M.feature then pcall(function() M.feature.eye_l_blink=0;M.feature.eye_r_blink=0 end) end
    M.speechVec=nil
end
-- One player input (thinking or listening) names `entity`: when that input is new this frame, a reply of that copy
-- that was prepared but never heard loses its ownership.
local function dropUnheard(entity,thinking,listening,thinkingRequest)
    if not (M.active and M.entity==entity) and
        ((entity==thinking and (thinking~=M.thinkingEntity or thinkingRequest~=M.expressionThinkingRequest))
            or (entity==listening and listening~=M.listeningEntity)) then
        local slot=M.expressions[entity]
        if slot and slot.awaitingAudio then slot.active,slot.awaitingAudio=false,false;slot.cueEmotion,slot.cueFamily,slot.cueScale=nil,nil,nil end
    end
end
function M.beginExpressionFrame(delta,context)
    if faceTest then pcall(faceTest.poll,delta,context) end
    M.expressionFrame=M.expressionFrame+1
    local want=nativeFor()
    if (want~=nil)~=slotsNative then
        restartPoseBlocks()
        slotsNative=want~=nil
    end
    native=want or false
    local ctx=type(context)=='table' and context or nil
    M.expressionDelta=finite(delta) and clamp(delta,.1) or 0
    M.expressionPaused=ctx~=nil and ctx.paused==true
    M.expressionBlocked=ctx~=nil and ctx.blocked==true
    M.expressionManaged=ctx~=nil
    local thinking=ctx and ctx.thinkingEntity or nil
    local listening=ctx and ctx.listeningEntity or nil
    local thinkingRequest=ctx and ctx.thinkingRequestId or nil
    -- A new player input ends an earlier reply's ownership that was never heard. The face itself keeps its
    -- idle expression (the resting smile, a lingering reaction, a mood hold) through listening and thinking;
    -- only the next reply's first audible frame changes it (October 9; before, the input zeroed it at once).
    -- Thinking/listening never infer mood from the text or voice. (No table is built per frame: nothing
    -- here runs unless somebody is thinking or listening.)
    if thinking then dropUnheard(thinking,thinking,listening,thinkingRequest) end
    if listening then dropUnheard(listening,thinking,listening,thinkingRequest) end
    M.thinkingEntity,M.listeningEntity,M.expressionThinkingRequest=thinking,listening,thinkingRequest
    local actors=ctx and type(ctx.actors)=='table' and ctx.actors or nil
    if actors then
        for _,row in ipairs(actors) do
            local known=type(row)=='table' and M.expressions[row.entity]
            if known then known.profile=row.profileKey end
        end
    end
    if not M.expressionPaused and finite(delta) then M.expressionClock=M.expressionClock+math.max(0,delta) end
end
-- The five status tags as CNames, built on first use (a CName is a value; building five per check was per-frame work).
local injuryTags,injuryNames={'Injured','Defeated','Unconscious','Stunned','Ragdoll'}
-- sceneAllowed: the broad IsEntityInScene flag is not read (a named character of the game that V talks to: it stays true in
-- ordinary gameplay, so it would keep every such mouth shut; the dialogue, autonomy, combat and injury checks remain).
local function luaActorSafe(actor,sceneAllowed)
    if not actor:IsOnAutonomousAI() or NPCPuppet.IsInCombat(actor) then return false end
    local scene=Game.GetSceneSystem():GetScriptInterface()
    local id=actor:GetEntityID()
    if scene:IsEntityInDialogue(id) or (not sceneAllowed and scene:IsEntityInScene(id)) then return false end
    -- Status effects are the game's injury/incapacitation signal. Missing
    -- native APIs fail closed for the optional expression layer only.
    if not injuryNames then
        local names={}
        for index,tag in ipairs(injuryTags) do names[index]=CName.new(tag) end
        injuryNames=names
    end
    for index=1,#injuryNames do
        if StatusEffectSystem.ObjectHasStatusEffectWithTag(actor,injuryNames[index]) then return false end
    end
    return true
end
-- M.screenEntity: the add-on screen face speaking now (speech.lua sets it for the reply whose voice it follows; nil otherwise). That NPC
-- is a scene actor by nature (the Delamain cab's seat-back screen NPC is filmed inside the cab's scene), so the scene and autonomy
-- guards would keep its mouth shut; Face.reds prepared it for exactly this speaker, so for it alone they do not apply.
local function safeExpressionActor(actor,entity)
    if entity~=nil and entity==M.screenEntity then return true end
    if not M.expressionManaged then return true end
    -- M.storyEntity: the named game character V is talking to (init.lua sets it; docs/WORLD_CHARACTERS.md). The Lua checks without
    -- the broad scene flag; the native check reads it, so it is not used for this one speaker.
    if entity~=nil and entity==M.storyEntity then
        local ok,ready=pcall(luaActorSafe,actor,true)
        return ok and ready==true
    end
    if native and M.expressionClock>=safeUnknownUntil then
        local ok,answer=pcall(native.Safe,actor)
        if ok and (answer==1 or answer==0) then
            if safeChecked>=SAFE_VERIFY then return answer==1 end
            -- The plugin's Safe (combat, scene, dialogue and injury checks) answers for the first time when it can read the
            -- combat flag (it answered -1 until it could), so its first answers are compared with the Lua check, which is
            -- the answer used; a difference puts "faces" on Lua for the session.
            local good,lua=pcall(luaActorSafe,actor)
            if good and (lua==true)~=(answer==1) then
                nativeFailed('Safe answered '..answer..' where the Lua check says '..tostring(lua))
                return lua==true
            end
            if good then safeChecked=safeChecked+1 end
            return good and lua==true
        end
        if not ok then nativeFailed(answer) else safeUnknownUntil=M.expressionClock+SAFE_RETRY_S end
    end
    local ok,ready=pcall(luaActorSafe,actor)
    return ok and ready==true
end
local function mouthBudget(feature,phase)
    -- An idle copy's own feature never carries a mouth value (only speech writes them, on the speaker's feature), so
    -- its budget is 1 without six reads across into the game. The visibility probe may write any track: it reads.
    if phase~='speaking' and not faceTest then return 1 end
    local function read(track) local value=feature[track];return finite(value) and clamp(value) or 0 end
    local closure=clamp(math.max(read('lips_together_up'),read('lips_together_dn'))/.85)
    local rounding=clamp(math.max(read('lips_l_funnel'),read('lips_r_funnel'))/.32
        +math.max(read('lips_l_purse'),read('lips_r_purse'))/.28)
    return (phase=='speaking' and speechMouthFactor or 1)*(1-closure)*(1-rounding)
end
-- Blended emotion path (bridge/expression-timeline.mjs tracks). Mirrors
-- mixTarget() in bridge/companion-expressions.mjs: unit poses per family,
-- combined with a soft sum so mixed feelings (bittersweet: a slight smile with
-- sad brows) stay inside the caps; mouth priority is applied by the caller.
local mixFamilies={'joy','trust','sadness','anger','fear','disgust','surprise','anticipation'}
-- October 9 (in game: "I don't really see much facial movement"): frowns and brows nearly doubled, and
-- the eyes join in (anger and disgust narrow them, surprise and fear widen them). Smiles unchanged.
-- Evening: each feeling now uses the whole upper face (captures and rig measurements, docs/COMPANION_EXPRESSIONS.md):
-- lat = brows pulled together, lid = upper-lid lowering (outer upper squint), sqi = inner squint, snear = nose
-- wrinkle, chin = chin raise (extended controls), droop = a held partial lid close (the blink control, base rig).
local familyPoses={joy={up=.45,out=.30},trust={up=.35},
    sadness={dn=.75,['in']=.85,lat=.35,droop=.30,chin=.35},
    anger={dn=.40,low=.80,lat=.70,lid=.80,sq=.40,sqi=.60,snear=.35,chin=.35,droop=.25},
    fear={dn=.25,['in']=.80,out=.50,lat=.50,wide=.45},disgust={dn=.50,low=.60,snear=.60,sq=.25,chin=.20},
    surprise={['in']=.80,out=.90,wide=.70},anticipation={out=.15}}
-- October 9 (user: "the expression barely changes, even with Expressive emotions on"): a family weight w moves
-- the frowns and brows by w^.6 of its pose. Full feelings are unchanged (the caps hold); a subtle tag on a reserved
-- character (.36) now shows about half its pose instead of a third, and phrases of different strength still
-- differ. The smile (key 'up') stays linear: the selector's smile evidence gates were tuned for it, and a curved
-- smile made weak, misread joy visible on sad or calm replies. Mirrors EXPRESSION_POLICY.mixCurve.
local mixCurve=.6
-- Joy only (trust stays the gentle smile). The smile weight stays nearly linear (its evidence gates were tuned for that) but a typical tagged line (weight .5-.67)
-- reached only 40-57 % of the captured joy while speaking, so a mild lift: w x (1 + .5 x (1 - w)): .2 -> .28, .48 -> .61,
-- .67 -> .78, 1 -> 1. Mirrors EXPRESSION_POLICY.smileLift.
local smileLift=.5
-- Smile or frown is decided on the earlier corner balance (linear, joy .45 / trust .35 against sadness .40,
-- anger .25, fear .15, disgust .30), so the bigger frown poses do not tip a joyful bittersweet line into a
-- frown; the winner then shows at its own (bigger) pose. An even mix still leans sad.
local cornerVote={joy={up=.45},trust={up=.35},sadness={dn=.40},anger={dn=.25},fear={dn=.15},disgust={dn=.30},
    surprise={},anticipation={}}
local function mixChannel(weights,key,poses)
    local max,sum=0,0
    for index,family in ipairs(mixFamilies) do
        local unit=(poses or familyPoses)[family][key]
        if unit then
            local weight=clamp(weights[index] or 0)
            local value=unit*weight
            if not poses and weight>0 then
                if key~='up' then value=unit*weight^mixCurve
                elseif family=='joy' then value=unit*weight*(1+smileLift*(1-weight)) end
            end
            if value>max then max=value end
            sum=sum+value
        end
    end
    return max+.4*(sum-max)
end
local function mixTargets(weights,target,phase,warmth,smile,squint)
    local up,dn=mixChannel(weights,'up'),mixChannel(weights,'dn')
    local rin,rout,low=mixChannel(weights,'in'),mixChannel(weights,'out'),mixChannel(weights,'low')
    local narrow,wide=mixChannel(weights,'sq'),mixChannel(weights,'wide')
    if narrow>wide then narrow=narrow-.5*wide;wide=0 else wide=wide-.5*narrow;narrow=0 end
    local upVote,dnVote=mixChannel(weights,'up',cornerVote),mixChannel(weights,'dn',cornerVote)
    if upVote>dnVote then up=up*(1-.5*dnVote/upVote);dn=0
    elseif dnVote>0 then dn=dn*(1-.5*upVote/dnVote);up=0 else up,dn=0,0 end
    local clash=math.min(math.max(rin,rout),low)
    rin=math.max(0,rin-.5*clash);rout=math.max(0,rout-.5*clash);low=math.max(0,low-.5*clash)
    -- The character's smile multiplier scales the emotion's smile only; the squint follows the unscaled smile.
    smile=smile or 1
    target.smileRaw=up*(squint or 1)
    up=up*smile
    if phase~='speaking' and dn==0 then up=math.max(up,warmth);target.smileRaw=math.max(target.smileRaw,warmth) end
    target=target or {}
    target.lips_l_corner_up,target.lips_r_corner_up=up,up
    target.lips_l_corner_dn,target.lips_r_corner_dn=dn,dn
    target.eye_l_brows_raise_in,target.eye_r_brows_raise_in=rin,rin
    target.eye_l_brows_raise_out,target.eye_r_brows_raise_out=rout,rout
    target.eye_l_brows_lower,target.eye_r_brows_lower=low,low
    target.eye_l_oculi_squint_outer_lower,target.eye_r_oculi_squint_outer_lower=narrow,narrow
    target.eye_l_widen,target.eye_r_widen=wide,wide
    local lat,lid,inner=mixChannel(weights,'lat'),mixChannel(weights,'lid'),mixChannel(weights,'sqi')
    target.eye_l_brows_lateral,target.eye_r_brows_lateral=lat,lat
    target.eye_l_oculi_squint_outer_upper,target.eye_r_oculi_squint_outer_upper=lid,lid
    target.eye_l_oculi_squint_inner,target.eye_r_oculi_squint_inner=inner,inner
    local snear=mixChannel(weights,'snear');target.nose_l_snear,target.nose_r_snear=snear,snear
    target.lips_chin_raise=mixChannel(weights,'chin')
    target.droop=mixChannel(weights,'droop')
end
-- Track validation and sampling (mirrors sampleTrack() in expression-timeline.mjs).
local function expressionTrack(timeline)
    local value=timeline.expressionTrack
    if type(value)~='table' or value.version~=1 or value.format~='emotion-mix-v1'
        or type(value.families)~='table' or #value.families~=#mixFamilies
        or type(value.keys)~='table' or #value.keys<1 or #value.keys>160 then return nil end
    for index,family in ipairs(mixFamilies) do if value.families[index]~=family then return nil end end
    local previous=-1
    for _,key in ipairs(value.keys) do
        if type(key)~='table' or #key~=#mixFamilies+1 or not finite(key[1]) or key[1]<0 or key[1]>1000 or key[1]<=previous then return nil end
        previous=key[1]
        for at=2,#key do if not finite(key[at]) or key[at]<0 or key[at]>1 then return nil end end
    end
    return value.keys
end
local function sampleTrack(keys,t)
    local first,last=keys[1],keys[#keys]
    local out={}
    if t<=first[1] then for i=1,#mixFamilies do out[i]=first[i+1] end return out end
    if t>=last[1] then for i=1,#mixFamilies do out[i]=last[i+1] end return out end
    local at=1
    while at+1<#keys and keys[at+1][1]<=t do at=at+1 end
    local a,b=keys[at],keys[at+1]
    local f=math.max(0,math.min(1,(t-a[1])/(b[1]-a[1])));f=f*f*(3-2*f)
    for i=1,#mixFamilies do out[i]=a[i+1]+(b[i+1]-a[i+1])*f end
    return out
end
-- Writes one unit-pose channel into a target (the single-label path; the blended path is mixTargets).
local channelTracks={up={'lips_l_corner_up','lips_r_corner_up'},dn={'lips_l_corner_dn','lips_r_corner_dn'},
    ['in']={'eye_l_brows_raise_in','eye_r_brows_raise_in'},out={'eye_l_brows_raise_out','eye_r_brows_raise_out'},
    low={'eye_l_brows_lower','eye_r_brows_lower'},sq={'eye_l_oculi_squint_outer_lower','eye_r_oculi_squint_outer_lower'},
    wide={'eye_l_widen','eye_r_widen'},lat={'eye_l_brows_lateral','eye_r_brows_lateral'},
    lid={'eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper'},sqi={'eye_l_oculi_squint_inner','eye_r_oculi_squint_inner'},
    snear={'nose_l_snear','nose_r_snear'},chin={'lips_chin_raise'},droop={'droop'}}
local function singleChannel(target,key,value)
    for _,track in ipairs(channelTracks[key]) do target[track]=value end
end
-- Exponential approach with a separate time constant for falling and rising; one exp only while the value is moving.
local function ease(prior,goal,fall,rise)
    if prior==nil or prior==goal then return goal end
    local seconds=M.expressionDelta or 0
    if seconds<=0 then return prior end
    -- Within 1 % of the goal it lands on it (a held closure removes the mouth emotion entirely, not asymptotically).
    if math.abs(goal-prior)<.01 then return goal end
    return prior+(goal-prior)*(1-math.exp(-seconds/(goal<prior and fall or rise)))
end
-- Per-frame scratch and constants of expressionPose (single-threaded, never held across calls): no table or closure
-- is built per frame.
local poseTarget,poseWeights={},{}
local cornerTracks={'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn'}
local browReleaseStems={'raise_in','raise_out','lower','lateral'}
local browDownTracks={'eye_l_brows_lower','eye_r_brows_lower','eye_l_brows_lateral','eye_r_brows_lateral',
    'eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper'}
local voiceBrowTracks={{'eye_l_brows_raise_in','eye_l_brows_raise_out','eye_l_brows_lower'},
    {'eye_r_brows_raise_in','eye_r_brows_raise_out','eye_r_brows_lower'}}
-- Per-track facts, computed once per track name.
local lipsTrack=setmetatable({},{__index=function(t,track) local v=track:sub(1,5)=='lips_';t[track]=v;return v end})
local cornerTrack=setmetatable({},{__index=function(t,track) local v=track:find('corner_',1,true)~=nil;t[track]=v;return v end})
local function trackCap(track,capScale)
    local limit=expressionLimit(track)
    if cornerTrack[track] then limit=limit*capScale end
    return limit
end
local function momentary(slot,name,weight)
    local age=slot.flick[name] or 0
    if weight>.1 then age=age+(M.expressionDelta or 0) else age=0 end
    slot.flick[name]=age
    return math.max(0,math.min(1,1-(age-1.0)/1.0))
end
local function setPair(target,stem,value) target['lips_l_'..stem]=value;target['lips_r_'..stem]=value end
local function setBrows(target,stem,value) target['eye_l_brows_'..stem]=value;target['eye_r_brows_'..stem]=value end
local function expressionPose(slot,phase,feature,provider,blocked,upper,mix)
    if phase=='speaking' and slot.awaitingAudio then startHeard(slot) end
    local target=poseTarget
    for key in pairs(target) do target[key]=nil end
    for _,track in ipairs(expressionTracks) do target[track]=0 end
    if slot.expiry and M.expressionClock>=slot.expiry then slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil end
    -- A turn with an expression track holds its last sampled mix between phrases
    -- and after speech (until the usual expiry), so gaps never jump to another pose.
    if mix then slot.holdMix=mix end
    local weights=mix or slot.holdMix
    local family,strength=slot.family,scaleStrength[slot.scale or 1]
    -- Surprise and Interest are momentary: a brow flick at the start of the feeling
    -- (full for 1 s, gone by 2 s), never a sustained raise. Other feelings hold
    -- through their phrase and release after speech (see browExpiry).
    slot.flick=slot.flick or {}
    local surpriseFlick,interestFlick
    if weights then
        -- A copy (the flicks scale two of its entries), in a reused table.
        local copy=poseWeights
        for index=1,#weights do copy[index]=weights[index] end
        for index=#weights+1,#copy do copy[index]=nil end
        weights=copy
        surpriseFlick,interestFlick=momentary(slot,'surprise',weights[7] or 0),momentary(slot,'anticipation',weights[8] or 0)
        weights[7]=(weights[7] or 0)*surpriseFlick;weights[8]=(weights[8] or 0)*interestFlick
    else
        surpriseFlick=momentary(slot,'surprise',family=='surprise' and strength or 0)
        interestFlick=momentary(slot,'anticipation',family=='anticipation' and strength or 0)
        if family=='surprise' then strength=strength*surpriseFlick elseif family=='anticipation' then strength=strength*interestFlick end
    end
    local trait=traitFor(slot.profile)
    local warmth,gain=trait.warmth,trait.gain
    -- This turn's strongest negative feeling (track mix or reply-level label) sets the mood hold.
    if slot.active and not slot.awaitingAudio then
        local worst=0
        if weights then for index=3,6 do worst=math.max(worst,weights[index] or 0) end
        elseif negative[family] then worst=strength end
        slot.turnNegative=math.max(slot.turnNegative or 0,worst)
    end
    if slot.moodUntil then
        local since=M.expressionClock-slot.moodUntil
        if since<0 then warmth=0 elseif since<moodEaseSeconds then warmth=warmth*since/moodEaseSeconds else slot.moodUntil=nil end
    end
    local capScale=math.min(math.max(gain,1),1.3)
    if weights then mixTargets(weights,target,phase,warmth,trait.smile,trait.squint)
    elseif family=='joy' then setPair(target,'corner_up',.45*strength*(1+smileLift*(1-strength))*(trait.smile or 1));setBrows(target,'raise_out',.30*strength);target.smileRaw=.45*strength*(1+smileLift*(1-strength))*(trait.squint or 1)
    elseif family=='trust' then setPair(target,'corner_up',.35*strength*(trait.smile or 1));target.smileRaw=.35*strength*(trait.squint or 1)
    elseif familyPoses[family] then
        -- One reply-level label: the family's unit pose at the label's strength (linear, as before).
        for key,value in pairs(familyPoses[family]) do singleChannel(target,key,value*strength) end
    end
    local frowning=false
    if provider then
        local source={eye_l_brows_lower=.55*provider[5],eye_r_brows_lower=.55*provider[6],
            eye_l_brows_raise_in=.45*provider[7],eye_r_brows_raise_in=.45*provider[7],
            eye_l_brows_raise_out=.40*provider[8],eye_r_brows_raise_out=.40*provider[9]}
        if family=='joy' or family=='trust' then source.lips_l_corner_up=.30*provider[1];source.lips_r_corner_up=.30*provider[2]
        else source.lips_l_corner_dn=.30*provider[3];source.lips_r_corner_dn=.30*provider[4] end
        for track,value in pairs(source) do target[track]=math.max(target[track],value) end
        if (source.lips_l_corner_dn or 0)>.005 or (source.lips_r_corner_dn or 0)>.005
            or source.eye_l_brows_lower>.01 or source.eye_r_brows_lower>.01 then setPair(target,'corner_up',0);frowning=true end
    end
    -- After speech the emotion's brows release within about 1.5 s (corners keep
    -- the longer expiry); they are never held for seconds after the voice stops.
    if slot.browExpiry and M.expressionClock>=slot.browExpiry then
        for _,name in ipairs(browReleaseStems) do setBrows(target,name,0) end
        target.eye_l_widen,target.eye_r_widen=0,0
        target.eye_l_oculi_squint_outer_upper,target.eye_r_oculi_squint_outer_upper=0,0
        target.droop=0
    end
    local suppress=not weights and (negative[family] or family=='unknown')
    if suppress then setPair(target,'corner_up',0) end
    if not weights and (family=='joy' or family=='trust') then setPair(target,'corner_dn',0);setBrows(target,'lower',0) end
    -- Resting warmth: a floor under every non-negative intent (Interest, surprise,
    -- neutral tone) while idle only. The emotion's own smile wins by max.
    if not weights and phase~='speaking' and not negative[family] and family~='unknown'
        and not frowning and target.lips_l_corner_dn==0 then setPair(target,'corner_up',math.max(target.lips_l_corner_up,warmth)) end
    for _,track in ipairs(cornerTracks) do target[track]=target[track]*gain end
    local browDown=trait.browDown or 1
    if browDown~=1 then
        for _,track in ipairs(browDownTracks) do target[track]=(target[track] or 0)*browDown end
    end
    -- The smile's own squint (Duchenne), or the feeling's narrowed eyes, whichever is stronger.
    local squintSmile=target.lips_l_corner_up
    if (target.smileRaw or 0)>0 and target.lips_l_corner_up>0 then squintSmile=target.smileRaw*gain end
    local squint=math.min(.5,math.max(target.eye_l_oculi_squint_outer_lower,.6*squintSmile))
    target.eye_l_oculi_squint_outer_lower,target.eye_r_oculi_squint_outer_lower=squint,squint
    local budget=ease(slot.mouthBudget,mouthBudget(feature,phase),budgetFall,budgetRise)
    slot.mouthBudget=budget
    for _,track in ipairs(expressionTracks) do
        if not (weights and cornerTrack[track]) then
            local goal=clamp(target[track] or 0,trackCap(track,capScale))
            if lipsTrack[track] then goal=goal*budget end
            local prior=slot.pose[track] or 0
            local seconds=goal>prior and .18 or .55
            slot.pose[track]=blocked and 0 or (prior+(goal-prior)*(1-math.exp(-(M.expressionDelta or 0)/seconds)))
        end
    end
    -- The held lid droop (sadness, anger) eases like the brows; applyFeature merges it with the blink.
    local droopGoal=blocked and 0 or clamp(target.droop or 0,.45)
    local droopPrior=slot.droop or 0
    slot.droop=droopPrior+(droopGoal-droopPrior)*(1-math.exp(-(M.expressionDelta or 0)/(droopGoal>droopPrior and .25 or .55)))
    if weights then
        -- Corners cross-fade on one signed axis (up positive, down negative), so
        -- a smile turning into a frown passes through neutral instead of snapping.
        local cornerCap=expressionLimit('corner_')*capScale
        local goalNet=(clamp(target.lips_l_corner_up,cornerCap)-clamp(target.lips_l_corner_dn,cornerCap))*budget
        local priorNet=slot.pose.lips_l_corner_up-slot.pose.lips_l_corner_dn
        local seconds=math.abs(goalNet)>=math.abs(priorNet) and .18 or .55
        local net=blocked and 0 or (priorNet+(goalNet-priorNet)*(1-math.exp(-(M.expressionDelta or 0)/seconds)))
        slot.pose.lips_l_corner_up,slot.pose.lips_r_corner_up=math.max(0,net),math.max(0,net)
        slot.pose.lips_l_corner_dn,slot.pose.lips_r_corner_dn=math.max(0,-net),math.max(0,-net)
    else
        if suppress or target.lips_l_corner_dn>0 or target.lips_r_corner_dn>0 then
            slot.pose.lips_l_corner_up,slot.pose.lips_r_corner_up=0,0
        end
        if target.lips_l_corner_up>0 or target.lips_r_corner_up>0 then
            slot.pose.lips_l_corner_dn,slot.pose.lips_r_corner_dn=0,0
            slot.pose.eye_l_brows_lower,slot.pose.eye_r_brows_lower=0,0
        end
    end
    -- October 9 (night, Evelyn: the mouth barely parted on sad replies). Two expression controls close the lips on the
    -- wide-lipped heads, measured on Evelyn with the writer probe at jaw .35 (brows, lids, cheek squint, nose wrinkle, the
    -- blink droop and a smile's corner pull do not: a smile only widens the gap): the chin raise lifts the lower lip into
    -- the upper (.15 of it cancels a jaw of .2), and the corner depressors stretch the lips thin (.3 halves the gap, .55
    -- with the chin raise seals it). While a jaw-lifted head speaks, each gives way as the jaw opens, the chin raise gone
    -- from .10 and the corners from .20, and both return between words, so a sad, angry or disgusted line still frowns on
    -- the brows, eyes and cheeks and in its pauses. Judy and unknown heads (no jaw lift) are untouched.
    local chinDuck,cornerDuck=1,1
    if phase=='speaking' and M.jawLift then
        local jaw=finite(feature.jaw_mid_open) and feature.jaw_mid_open or 0
        chinDuck,cornerDuck=1-clamp(jaw/chinDuckJaw),1-clamp(jaw/cornerDuckJaw)
    end
    chinDuck,cornerDuck=ease(slot.chinDuck,chinDuck,duckFall,duckRise),ease(slot.cornerDuck,cornerDuck,duckFall,duckRise)
    slot.chinDuck,slot.cornerDuck=chinDuck,cornerDuck
    -- The written values are kept on the slot (one reused table), so the writer never reads
    -- them back from the native feature (each read crosses into the game).
    local written=slot.writtenPose or {};slot.writtenPose=written
    -- An idle copy writes into its own feature object, which keeps what was written between frames (nobody else
    -- touches it), so only the controls that changed cross into the game. Speech writes the shared feature every
    -- frame, and the visibility probe may overwrite any control: both write everything.
    local held
    if phase~='speaking' and not faceTest and feature==slot.feature then
        if slot.heldFeature~=feature then slot.heldFeature,slot.held=feature,{} end
        held=slot.held
    end
    for _,track in ipairs(expressionTracks) do
        -- Hard closure/rounding suppression happens after smoothing, too.
        local value=math.min(slot.pose[track],trackCap(track,capScale)*(lipsTrack[track] and budget or 1))
        if track=='lips_chin_raise' then value=value*chinDuck
        elseif track=='lips_l_corner_dn' or track=='lips_r_corner_dn' then value=value*cornerDuck end
        if held then
            if held[track]~=value then held[track]=value;feature[track]=value end
        else feature[track]=value end
        written[track]=value
    end
    -- Voice-synchronous brows from the game-trained model (emphasis flashes,
    -- focused frowns). Already smooth and on the audio clock: combined by max
    -- with the smoothed emotional pose, never summed, and toned down where it
    -- would contradict the emotion (raised brows in anger, lowered in joy).
    if upper and not blocked then
        -- Held-out game lines: audio predicts brow raises only loosely (r .29)
        -- and lowering hardly at all (r .13), so the predicted lowering is not
        -- used (neutral when unsure). The model output is already a regressed
        -- (shrunk) estimate, so the old extra 35 % gain halved it twice and the
        -- raises (speech mean .10) never showed; .8 keeps emphasis flashes visible.
        -- Voice-synced brows are RARE emphasis: only a strong stress counts (a dead
        -- zone removes the model's constant low-level lift), the peak is small
        -- (.22; .15 before October 9, invisible at conversation distance), and after one
        -- emphasis the next is held off for 2.5 s, so a brow never bobs alone on an
        -- otherwise static face. Emotion brows come from the expression timeline.
        local raise=math.min(.22,.7*math.max(0,upper.raise-.25))*((family=='anger' or family=='disgust') and .4 or 1)
        if raise>.02 then
            if not slot.voiceBrowOn then
                if slot.voiceBrowReady and M.expressionClock<slot.voiceBrowReady then raise=0
                else slot.voiceBrowOn=true;slot.voiceBrowReady=M.expressionClock+2.5 end
            end
        else slot.voiceBrowOn=false end
        local lower=0*upper.lower
        for side=1,2 do
            local names=voiceBrowTracks[side]
            for at=1,3 do
                local track=names[at]
                written[track]=math.min(expressionLimit(track),math.max(written[track],at<3 and raise or lower));feature[track]=written[track]
            end
        end
    end
end
-- Natural blinking (October 9; user: Judy never blinks, while talking or not). Every facial graph (vanilla and
-- ours alike; our build only adds zero-default Add nodes right before the Sermo solver) has exactly two blink
-- sources: animations streamed into its FacialMixerSlot (scene, workspot and dialogue lipsync animations; the
-- game's lines carry about 19 blinks a minute on eye_l/r_blinkLipsyncPoseOutput, peak about .64 up to .95,
-- closed within about .07 s, open again over about .2 s), and that slot's lookAtDefinitions, which play
-- additive__blink_* only on a look-at transition. A companion copy idles outside any scene or workspot, so
-- nothing streams into the slot, and she holds one steady look-at on V (or none), so no transition ever plays a
-- blink. Our speech replaces the lipsync animation as well. This adds the game's kind of blink at all times
-- for the copies this writer owns (managed companions, and the current speaker): every 2-6 s with jitter,
-- every 1.8-5.2 s while listening, now and then one at a phrase boundary. Additive and short: a native
-- gaze-shift blink on top only merges (the solver clamps at 1). Combat, scenes and native dialogue block it
-- like every other optional delta (a scene streams its own blinks). Per call: a few comparisons and at most one
-- exp, no tables; the state is a few numbers on the copy's slot. Crowd NPCs never reach this writer.
local blinkClose,blinkTau,blinkLength,blinkGap=.07,.055,.32,.6
-- A settled idle face sleeps (see updateExpressions): no native reads or writes until the next blink is due,
-- its inputs change, or sleepRecheck seconds pass (then one full frame re-checks combat, scenes and status
-- effects and re-applies the pose). sleepDelta is far below anything visible on a 0-1 rig control.
local sleepDelta,sleepRecheck=1e-4,.25
M.idleSleep=true
M.blinkRandom=math.random
local function blinkWeight(slot,phase,blocked,boundary,room)
    local clock=M.expressionClock
    if blocked then slot.blinkStart,slot.blinkNext=nil,nil;return 0 end
    do
        local random=M.blinkRandom
        -- The first blink comes soon after the face is owned or unblocked, like the game's lines (median 1.2 s).
        if not slot.blinkNext then slot.blinkNext=clock+.6+1.6*random() end
        local since=slot.blinkStart and clock-slot.blinkStart or math.huge
        if boundary and since>1.2 and random()<.45 then slot.blinkNext=math.min(slot.blinkNext,clock+.04+.1*random()) end
        -- room=false: a phrase's last moments, where the next phrase's audio may not have started yet (a held,
        -- half-closed lid would show); the blink waits for the next phrase.
        if clock>=slot.blinkNext and since>=blinkGap and room~=false then
            slot.blinkStart,slot.blinkPeak=clock,.62+.33*random()^2
            -- A listener looks at the speaker and blinks a little more often.
            if phase=='listening' then slot.blinkNext=clock+1.8+3.4*random() else slot.blinkNext=clock+2+4*random() end
            if phase=='speaking' then M.speechBlinks=(M.speechBlinks or 0)+1 else M.restBlinks=(M.restBlinks or 0)+1 end
        end
    end
    local start=slot.blinkStart
    if not start then return 0 end
    local age=clock-start
    if age<0 or age>=blinkLength then return 0 end
    if age<blinkClose then local f=age/blinkClose;return slot.blinkPeak*f*f*(3-2*f) end
    return slot.blinkPeak*math.exp(-(age-blinkClose)/blinkTau)
end
-- The native path of applyFeature (docs/NATIVE_PORT_BRIEF.md, system "faces"). Everything that is Lua's state stays here
-- and runs in expressionPose's own order (heard cue, expiry, held mix, turn mood, mood hold, blink, owner level); the numbers
-- go to one ConvaiNativeFaces.Frame call, which computes the pose block, writes the ConvaiFaceFeature and applies it. True when
-- the frame was handled. False only before anything was applied (the plugin could not take the frame): the caller then runs
-- the Lua path for this frame and every later one.
local function applyNative(actor,feature,entity,phase,provider,upper,mix,boundary,room,slot,blocked)
    local clock,delta=M.expressionClock,M.expressionDelta or 0
    local speaking=phase=='speaking'
    if speaking and slot.awaitingAudio then startHeard(slot) end
    if slot.expiry and clock>=slot.expiry then slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil end
    if mix then slot.holdMix=mix end
    local weights=mix or slot.holdMix
    local family=slot.family
    local trait=traitFor(slot.profile)
    local warmth=trait.warmth
    -- This turn's strongest negative feeling (track mix or reply-level label) sets the mood hold.
    if slot.active and not slot.awaitingAudio then
        local worst=0
        if weights then for index=3,6 do worst=math.max(worst,weights[index] or 0) end
        elseif negative[family] then worst=scaleStrength[slot.scale or 1] end
        slot.turnNegative=math.max(slot.turnNegative or 0,worst)
    end
    if slot.moodUntil then
        local since=clock-slot.moodUntil
        if since<0 then warmth=0 elseif since<moodEaseSeconds then warmth=warmth*since/moodEaseSeconds else slot.moodUntil=nil end
    end
    local blink=blinkWeight(slot,phase,blocked,boundary,room)
    local owned,writeOwner=0,false
    if ownerFace then
        owned=ownerLevel(slot,phase,blocked)
        -- Speaking frames always write it (a reused feature never keeps a stale 1); other phases only to hand it back.
        if speaking or owned>0 or slot.ownWritten then writeOwner=true;slot.ownWritten=owned>0 end
    end
    local turn=speaking and M.lastSpeechExpression or nil
    local newTurn=speaking and (not turn or turn.requestId~=slot.requestId or turn.entity~=entity)
    local flags=0
    if speaking then flags=flags+1 end
    if blocked then flags=flags+2 end
    if weights then flags=flags+4;for index=1,8 do ctl[10+index]=weights[index] or 0 end end
    if provider then flags=flags+8;for index=1,9 do ctl[18+index]=provider[index] or 0 end end
    if upper then flags=flags+16;ctl[28],ctl[29]=upper.raise,upper.lower end
    if slot.browExpiry and clock>=slot.browExpiry then flags=flags+32 end
    if slot.flickReset then flags=flags+64 end
    if M.jawLift then flags=flags+128 end
    if extendedFace then flags=flags+256 end
    if newTurn then flags=flags+512 end
    if writeOwner then flags=flags+1024 end
    if slot.blinkStart and clock-slot.blinkStart<blinkLength then flags=flags+2048 end
    ctl[1],ctl[2],ctl[3]=clock,delta,flags
    ctl[4],ctl[5]=FAMILY[family] or 0,slot.scale or 0
    ctl[6],ctl[7],ctl[8],ctl[9],ctl[10]=warmth,trait.gain,trait.smile or 1,trait.squint or 1,trait.browDown or 1
    ctl[30],ctl[31]=blink,owned
    local vec=EMPTY
    if speaking then
        vec=M.speechVec
        if not vec then vec=newSpeechVec();M.speechVec=vec end
    end
    local ok,code=pcall(native.Frame,actor,feature,slot.nid,ctl,vec)
    if not ok then nativeFailed(code);return false end
    if type(code)~='number' then nativeFailed('unexpected result '..tostring(code));return false end
    if code==-3 then nativeFailed('the game side is unavailable (ConvaiNativeFaces.Info shows which piece)');return false end
    if code<=0 then error(code==-1 and 'Native facial layer rejected the frame' or 'Native facial layer fault',0) end
    slot.flickReset=nil
    slot.written=M.expressionFrame
    slot.phase,slot.blocked,slot.applied=phase,blocked,(slot.applied or 0)+1
    slot.settled,slot.nativeGaze=has(code,2),code
    if speaking then
        -- Peak pose, jaw peak and open-jaw frames of the turn live in the native core (mergeTurn reads them back).
        if newTurn then
            turn={entity=entity,requestId=slot.requestId,frames=0,ownedFrames=0,jawPeak=0,openFrames=0,peak=zeroExpression()}
            M.lastSpeechExpression=turn
        end
        turnNid[turn]=slot.nid
        turn.emotion,turn.family,turn.scale,turn.blocked=slot.emotion,slot.family,slot.scale,blocked
        turn.frames=turn.frames+1
        if owned>=.99 then turn.ownedFrames=(turn.ownedFrames or 0)+1 end
        turn.jawLift=ownerFace==false and M.jawLift and M.jawLift.q or false
        if mix then
            turn.mix,turn.mixPeak=turn.mix or {},turn.mixPeak or {}
            for index,family in ipairs(mixFamilies) do
                turn.mix[family]=math.floor(mix[index]*1000)/1000
                if mix[index]>(turn.mixPeak[family] or 0) then turn.mixPeak[family]=math.floor(mix[index]*1000)/1000 end
            end
        end
    end
    return true
end
local function applyFeature(actor,feature,entity,phase,provider,upper,mix,boundary,room)
    detectExtended(feature)
    detectOwner(feature)
    local slot=expressionSlot(entity)
    local blocked=M.expressionBlocked or M.expressionPaused or not safeExpressionActor(actor,entity)
    if blocked then slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil end
    if native and applyNative(actor,feature,entity,phase,provider,upper,mix,boundary,room,slot,blocked) then return end
    if faceTest then pcall(faceTest.pre,entity,slot,M.expressionClock) end
    expressionPose(slot,phase,feature,provider,blocked,upper,mix)
    local blink=math.max(blinkWeight(slot,phase,blocked,boundary,room),blocked and 0 or (slot.droop or 0))
    -- A copy that never blinked through this layer keeps the fields untouched (zero, the native face).
    -- (held: what expressionPose last wrote on this idle copy's own feature, see there.)
    local held=slot.heldFeature==feature and slot.held or nil
    if blink>0 or slot.blinkWritten then
        if not held or held.blink~=blink then
            feature.eye_l_blink,feature.eye_r_blink=blink,blink
            if held then held.blink=blink end
        end
        slot.blinkWritten=true
    end
    -- A blink closes widened eyes too (they would hold the lids apart).
    local written=slot.writtenPose
    if blink>0 and (written.eye_l_widen or 0)>0 then
        local open=1-blink;written.eye_l_widen,written.eye_r_widen=written.eye_l_widen*open,written.eye_r_widen*open
        feature.eye_l_widen,feature.eye_r_widen=written.eye_l_widen,written.eye_r_widen
        if held then held.eye_l_widen,held.eye_r_widen=written.eye_l_widen,written.eye_r_widen end
    end
    local owned=0
    if ownerFace then
        owned=ownerLevel(slot,phase,blocked)
        -- Speaking frames always write it (a reused feature never keeps a stale 1); other phases only to hand it back.
        if phase=='speaking' or owned>0 or slot.ownWritten then feature.speech_owner=owned;slot.ownWritten=owned>0 end
    end
    if faceTest then
        local ok,skip=pcall(faceTest.post,entity,feature,phase,blocked)
        if ok and skip then return end
    end
    assert(actor:ConvaiFaceApply(feature),'Native facial layer rejected the frame')
    slot.written=M.expressionFrame
    slot.phase,slot.blocked,slot.applied=phase,blocked,(slot.applied or 0)+1
    -- Settled: an idle face whose written pose moved less than sleepDelta on every control since the
    -- last frame, with no blink (a blink starts at weight 0), droop or mouth hand-over in flight (updateExpressions may let it sleep).
    local applied=slot.appliedPose or {}
    local settled=phase~='speaking' and not blocked and blink==0 and owned==0 and slot.appliedPose~=nil
        and not (slot.blinkStart and M.expressionClock-slot.blinkStart<blinkLength)
    for _,track in ipairs(expressionTracks) do
        local value=written[track] or 0
        if settled and math.abs(value-(applied[track] or 0))>=sleepDelta then settled=false end
        applied[track]=value
    end
    slot.appliedPose,slot.settled=applied,settled
    -- Test hook (bridge/facial-playback-native.test.mjs records the Lua path's frames with it); nil in the game.
    if M._observe then M._observe(entity,phase,blocked,slot) end
    if phase=='speaking' then
        -- Peak pose per speech turn, published in speech-state.json so one
        -- in-game reply shows the emotion label, scale and written values.
        local turn=M.lastSpeechExpression
        if not turn or turn.requestId~=slot.requestId or turn.entity~=entity then
            turn={entity=entity,requestId=slot.requestId,frames=0,ownedFrames=0,jawPeak=0,openFrames=0,peak=zeroExpression()}
            M.lastSpeechExpression=turn
        end
        turn.emotion,turn.family,turn.scale,turn.blocked=slot.emotion,slot.family,slot.scale,blocked
        turn.frames=turn.frames+1
        -- Frames with the idle mouth fully handed over (speech_owner at 1); 0 with frames > 0 means the field or the new archive is missing.
        if owned>=.99 then turn.ownedFrames=(turn.ownedFrames or 0)+1 end
        -- What the writer actually gave the mouth this turn (October 10, "her mouth did not open even once"): the peak
        -- written jaw, the frames at or above .16 (Evelyn's lips part from there) and the jaw-lift curve in use, so a
        -- reply seen with no mouth shows at once whether the writer wrote an open jaw or never did.
        local jaw=feature.jaw_mid_open
        if finite(jaw) then
            if jaw>(turn.jawPeak or 0) then turn.jawPeak=math.floor(jaw*1000)/1000 end
            if jaw>=.16 then turn.openFrames=(turn.openFrames or 0)+1 end
        end
        turn.jawLift=ownerFace==false and M.jawLift and M.jawLift.q or false
        if mix then
            turn.mix,turn.mixPeak=turn.mix or {},turn.mixPeak or {}
            for index,family in ipairs(mixFamilies) do
                turn.mix[family]=math.floor(mix[index]*1000)/1000
                if mix[index]>(turn.mixPeak[family] or 0) then turn.mixPeak[family]=math.floor(mix[index]*1000)/1000 end
            end
        end
        for _,track in ipairs(expressionTracks) do
            if feature[track]>(turn.peak[track] or 0) then turn.peak[track]=feature[track] end
        end
    end
end
-- Gaze drop for the companion actuator's eye contact (metres below V's eyes): a sad face looks a little down.
-- Hysteresis on the smoothed pose (on above inner brows .35 with corners down .15, off below .2), so the native
-- look request changes once per mood change, not per frame.
function M.gazeDrop(entity)
    local slot=type(entity)=='string' and M.expressions[entity]
    if not slot or not slot.pose then return 0 end
    local below,above,lowered
    if native then
        -- The native core reports the three pose thresholds with every frame (none yet: a neutral pose).
        local code=slot.nativeGaze or 4
        below,above,lowered=has(code,4),has(code,8),has(code,16)
    else
        local inner,down=slot.pose.eye_l_brows_raise_in or 0,slot.pose.lips_l_corner_dn or 0
        below,above,lowered=inner<.2,inner>.35,down>.15
    end
    if slot.gazeDown then
        if below or slot.blocked then slot.gazeDown=false end
    elseif above and lowered and not slot.blocked then slot.gazeDown=true end
    return slot.gazeDown and -0.15 or 0
end
-- Cached diagnostics for a parent-owned live probe. No native reads, actor
-- handles, speech weights, remote owners or dialogue appear in this snapshot.
function M.expressionStatus(entity)
    local slot=M.expressions[entity]
    if not slot then return nil end
    local pose,values={},nil
    if native and slot.nid then
        local ok,text=pcall(native.Applied,slot.nid)
        if ok and type(text)=='string' and text~='' then
            values={};for number in text:gmatch('%S+') do values[#values+1]=tonumber(number) end
        end
    end
    for index,track in ipairs(expressionTracks) do
        if values then pose[track]=values[index] or 0 else pose[track]=slot.appliedPose and slot.appliedPose[track] or 0 end
    end
    return {version=1,phase=slot.phase,blocked=slot.blocked,applied=slot.applied or 0,
        emotionPresent=slot.emotion~=nil,active=slot.active==true,pose=pose,clock=M.expressionClock}
end
-- The idle writer's phase for a copy (also used by the hand-over in reset()).
local function idlePhase(slot,entity)
    return (slot.active and 'thinking') or (M.thinkingEntity==entity and 'thinking')
        or (M.listeningEntity==entity and 'listening') or 'idle'
end
-- An idle face asleep since its last full frame stays asleep while nothing that feeds the pose has changed:
-- same phase, frame context and profile, no feeling, hold, mood, expiry or mouth hand-over pending, no speech
-- for this copy, no probe run that writes through this layer, and the next blink not yet due. Everything here
-- is Lua state; nothing crosses into the game.
local function asleep(slot,entity,row,busy)
    local at=slot.sleepAt
    if not at or busy or not M.idleSleep then return false end
    local clock=M.expressionClock
    if clock<at or clock-at>=sleepRecheck or not slot.blinkNext or clock>=slot.blinkNext then return false end
    if slot.emotion or slot.holdMix or slot.expiry or slot.moodUntil or slot.active or slot.awaitingAudio
        or (slot.ownLevel or 0)~=0 or (slot.browExpiry and clock<slot.browExpiry) then return false end
    if M.active and M.entity==entity then return false end
    return slot.sleepPhase==idlePhase(slot,entity) and slot.sleepBlocked==M.expressionBlocked
        and slot.sleepProfile==row.profileKey
end
-- Rows seen this frame (reused; cleared at the start of each update).
local seenRows={}
-- One idle frame of one copy: ownership, the slot, the writer, and (for a settled face) the sleep mark.
local function idleFrame(row,entity,actor)
    if not owns(actor,entity) then forget(entity);return end
    local slot=expressionSlot(entity)
    slot.profile=row.profileKey
    -- Speech owns the face from its first HEARD frame. Before that (a reply prepared, a stream
    -- buffering, an Omni phrase loading) this idle writer keeps her idle face (October 9).
    if slot.written==M.expressionFrame or (M.active and M.entity==entity and M.heardRequest==M.requestId and M.state~='paused' and M.state~='releasing') then return end
    slot.feature=slot.feature or NewObject('ConvaiFaceFeature')
    assert(slot.feature,'Native facial feature is unavailable')
    local phase=idlePhase(slot,entity)
    slot.sleepAt=nil
    applyFeature(actor,slot.feature,entity,phase)
    -- The native feature keeps the last applied pose, so a settled face needs no write until it changes.
    if slot.settled and slot.written==M.expressionFrame then
        slot.sleepAt=M.expressionClock
        slot.sleepPhase,slot.sleepBlocked,slot.sleepProfile=phase,M.expressionBlocked,row.profileKey
    end
end
function M.updateExpressions(context)
    if type(context)~='table' or M.expressionPaused then return end
    if faceTest then pcall(faceTest.direct,context.actors,function() return NewObject('ConvaiFaceFeature') end) end
    local seen=seenRows
    for key in pairs(seen) do seen[key]=nil end
    local rows=context.actors
    local busy=faceTest~=nil and probeBusy()
    if rows then
        for _,row in ipairs(rows) do
            local entity,actor=row.entity,row.npc
            local sleeping=type(entity)=='string' and not seen[entity] and M.expressions[entity]
            -- Asleep: a few comparisons, nothing else (a full frame re-checks ownership, combat, scenes and status
            -- effects every sleepRecheck seconds).
            if sleeping and asleep(sleeping,entity,row,busy) then seen[entity]=true;entity=nil end
            if type(entity)=='string' and not seen[entity] then
                seen[entity]=true
                local ok,err=pcall(idleFrame,row,entity,actor)
                if not ok then M.expressionError=tostring(err);forget(entity) end
            end
        end
    end
    for entity in pairs(M.expressions) do
        if not seen[entity] and not (M.active and M.entity==entity) then forget(entity) end
    end
end
-- `seen` (optional): rows already range-checked in an earlier continuous update (a decoded row is never changed),
-- so a growing timeline re-checks only its new rows.
local function providerExpressions(timeline,seen)
    local value=timeline.providerExpressions
    -- Convai turns keep their provider brows/corners when the game-trained
    -- model drives the mouth from the same PCM (source local-jali).
    if (timeline.source~='convai-arkit61' and timeline.source~='local-jali') or type(value)~='table'
        or value.version~=1 or value.format~='arkit61-expression9'
        or type(value.frames)~='table' or #value.frames~=#timeline.frames then return nil end
    for index,frame in ipairs(value.frames) do
        if type(frame)~='table' or #frame~=10 or frame[1]~=timeline.frames[index][1] then return nil end
        if not (seen and seen[frame]) then
            for at=2,10 do if not finite(frame[at]) or frame[at]<0 or frame[at]>1 then return nil end end
            if seen then seen[frame]=true end
        end
    end
    return value.frames
end
-- Optional model upper-face curve on the timeline's exact frame times.
local function modelExpressions(timeline,seen)
    local value=timeline.modelExpressions
    if timeline.source~='local-jali' and timeline.source~='audio-envelope' and timeline.source~='convai-arkit61' then return nil end
    if type(value)~='table' or value.version~=1 or value.format~='jali-upper-v1'
        or type(value.frames)~='table' or #value.frames~=#timeline.frames then return nil end
    for index,frame in ipairs(value.frames) do
        if type(frame)~='table' or #frame~=3 or frame[1]~=timeline.frames[index][1] then return nil end
        if not (seen and seen[frame]) then
            for at=2,3 do if not finite(frame[at]) or frame[at]<0 or frame[at]>1 then return nil end end
            if seen then seen[frame]=true end
        end
    end
    return value.frames
end
-- Phrase starts of this timeline (audio seconds) from its expression track, for the occasional boundary blink.
-- Built once per timeline or continuous update, never per frame. The reply's own first phrase is not a boundary.
local function blinkBoundaries(timeline)
    local track=timeline.expressionTrack
    local spans=type(track)=='table' and track.segments
    if type(spans)~='table' then return nil end
    local out,opening=nil,timeline.segment==nil or timeline.segment.first==true
    for index,span in ipairs(spans) do
        if index>64 then break end
        local at=type(span)=='table' and span.start
        if finite(at) and at>0 and at<=timeline.duration and not (index==1 and opening) then
            out=out or {};out[#out+1]=at
        end
    end
    return out
end
local function blinkCursor(boundaries,position)
    local index=1
    while boundaries and boundaries[index] and boundaries[index]<=position do index=index+1 end
    return index
end
-- October 9 (user: "sometimes the eyebrows flicker"): every Omni phrase ended with face.stop -> ConvaiFaceReset, which
-- zeroes the WHOLE feature. The idle writer is skipped for that frame, so the brows, lids, squints and corners showed
-- one neutral frame and snapped back on the next (the same at a reply's end, a stream underrun and a late native
-- start). A managed copy now hands the face to its idle writer inside the same call: the speech fields drop to zero
-- (a closed mouth, exactly what the reset gave) while the smoothed expression, droop and blink carry on unbroken.
-- Anything else (a world speaker, a paused game, no frame context yet) still gets the plain reset.
local function reset(actor)
    local handed
    local ok, done = pcall(function()
        if not speaker(actor) then return false end
        local entity=M.entity
        local slot=entity and M.expressions[entity]
        if slot and M.expressionManaged and not M.expressionPaused and owns(actor,entity) then
            slot.feature=slot.feature or NewObject('ConvaiFaceFeature')
            if slot.feature then
                local wrote=pcall(applyFeature,actor,slot.feature,entity,idlePhase(slot,entity))
                if wrote and slot.written==M.expressionFrame then handed=true;return true end
            end
        end
        return actor:ConvaiFaceReset()
    end)
    M.restored = ok and done == true
    if M.restored and not handed and M.entity and M.expressions[M.entity] then
        local slot=M.expressions[M.entity]
        slot.written,slot.appliedPose,slot.phase=M.expressionFrame,zeroExpression(),'released'
        if native and slot.nid then pcall(native.NoteReset,slot.nid) end
    end
end
local function clear()
    M.active, M.requestId, M.timeline, M.feature, M.lastPosition = false, nil, nil, nil, nil
    M.segment, M.generation = nil, nil
    M.continuous, M.timelineChanged = nil, nil
    M.localMotion, M.localPose, M.localPosePosition = nil, nil, nil
    M.providerExpressions=nil
    M.modelExpressions=nil
    M.expressionTrackKeys=nil
    M.blinkBoundaries,M.blinkBoundaryIndex=nil,nil
    M.jawLift=nil
    M.speechVec=nil
    M.release,M.stall,M.stalledAt=nil,nil,nil
end

function M.abandon(reason)
    clear()
    M.state, M.entity, M.restored = reason or 'unloaded', nil, false
    M.expressions,M.expressionClock={},0
end

function M.stop(actor, reason)
    -- A reply that was never heard never wrote the face: nothing to reset (the idle writer still owns it).
    if M.active and M.heardRequest==M.requestId then reset(actor) elseif M.active then M.restored=true end
    clear()
    M.state = reason or 'idle'
end

function M.start(context, timeline, actor, duration, expectedSegment)
    local segment, feature
    local ok, err = pcall(function()
        assert(type(timeline) == 'table', 'Facial timeline is unavailable')
        assert(timeline.version == 1 and timeline.requestId == context.requestId
            and timeline.entity == context.entity, 'Facial timeline belongs to another reply')
        assert(finite(duration) and duration > 0 and duration <= 120
            and finite(timeline.duration) and math.abs(timeline.duration - duration) < 0.001, 'Facial duration mismatch')
        assert(timeline.source == 'convai-arkit61' or timeline.source == 'audio-envelope'
            or timeline.source == 'local-phonetic' or timeline.source == 'local-jali', 'Unknown facial source')
        assert(timeline.motion == nil or (timeline.motion == 'local-phonetic-smooth-v1'
            and timeline.source == 'local-phonetic'), 'Unknown facial motion')
        assert(timeline.source ~= 'local-jali' or timeline.articulation == 'jali-audio-v1', 'Unknown model articulation')
        assert(type(timeline.tracks) == 'table' and #timeline.tracks > 0 and #timeline.tracks <= 32
            and type(timeline.frames) == 'table' and #timeline.frames >= 2 and #timeline.frames <= 7202,
            'Invalid facial timeline size')
        local used, previous = {}, -1
        for _, track in ipairs(timeline.tracks) do
            assert(allowed[track] and not used[track], 'Unknown or duplicate facial control')
            used[track] = true
        end
        for _, frame in ipairs(timeline.frames) do
            assert(type(frame) == 'table' and #frame == #timeline.tracks + 1
                and finite(frame[1]) and frame[1] >= 0 and frame[1] <= duration
                and frame[1] > previous, 'Invalid facial frame time')
            for i = 2, #frame do
                assert(finite(frame[i]) and frame[i] >= 0 and frame[i] <= trackLimit(timeline.tracks[i-1]), 'Invalid facial weight')
            end
            previous = frame[1]
        end
        assert(timeline.frames[1][1] == 0 and math.abs(previous - duration) < 0.001, 'Incomplete facial timeline')
        if timeline.segment ~= nil then
            local value = timeline.segment
            assert(type(value) == 'table' and value.version == 1 and finite(value.index)
                and value.index % 1 == 0 and value.index >= 1 and value.index <= 128
                and finite(value.startSeconds) and value.startSeconds >= 0 and value.startSeconds + duration <= 120.0001
                and type(value.first) == 'boolean' and value.first == (value.index == 1)
                and type(value.last) == 'boolean' and (not value.first or value.startSeconds == 0)
                and type(expectedSegment) == 'table' and expectedSegment.index == value.index
                and finite(expectedSegment.startSeconds) and math.abs(expectedSegment.startSeconds-value.startSeconds) < .0001,
                'Facial segment does not match its native audio')
            segment = {version=1,index=value.index,startSeconds=value.startSeconds,first=value.first,last=value.last}
        end
        assert(speaker(actor, context.entity), 'Speaker has no prepared facial layer')
        feature = NewObject('ConvaiFaceFeature')
        assert(feature, 'Native facial feature is unavailable')
    end)
    local contiguous = ok and M.active and segment and M.segment and not M.segment.last
        and M.requestId == context.requestId and M.entity == context.entity and M.generation == context.generation
        and segment.index == M.segment.index + 1
        and math.abs(segment.startSeconds - (M.segment.startSeconds + M.timeline.duration)) < .0001
    local retainedPose = contiguous and M.timeline.motion == timeline.motion and M.localPose or nil
    local retainedPosition = retainedPose and M.localPosePosition or nil
    if M.active and not contiguous then M.stop(actor, 'replaced') end
    clear();M.state,M.entity,M.restored='unavailable',nil,false
    M.source, M.articulation, M.error, M.applied, M.position = nil, nil, nil, 0, nil
    if not ok then M.error = tostring(err); return false end
    M.entity, M.generation, M.segment, M.feature = context.entity, context.generation, segment, feature
    M.jawLift = jawLiftFor(actor, context.entity)
    M.requestId, M.timeline, M.index = context.requestId, timeline, 1
    M.source, M.active, M.state = timeline.source, true, 'waiting-for-audio'
    M.articulation = timeline.articulation
    M.localMotion = timeline.motion == 'local-phonetic-smooth-v1'
    M.localPose, M.localPosePosition = retainedPose, retainedPosition
    M.providerExpressions=providerExpressions(timeline)
    M.modelExpressions=modelExpressions(timeline)
    M.expressionTrackKeys=expressionTrack(timeline)
    M.blinkBoundaries=blinkBoundaries(timeline)
    M.blinkBoundaryIndex=1
    M.beginExpression(context,timeline.expression)
    return true
end

-- Both continuous renderers supply one growing, absolute timeline. Updating the
-- data must not recreate/reset the native layer or advance it ahead of audio.
function M.updateContinuous(context, timeline, actor, duration)
    local sameOwner = type(context) == 'table' and M.active and M.continuous
        and M.requestId == context.requestId and M.entity == context.entity
        and M.generation == context.generation
    if M.active and not sameOwner then return false end
    if sameOwner and type(timeline) == 'table' and (timeline.requestId ~= context.requestId
        or timeline.entity ~= context.entity or timeline.generation ~= context.generation) then return false end
    -- Rows checked by an earlier update of this reply (weak: a row replaced by the next revision is released).
    local seen = sameOwner and M.checkedRows or setmetatable({}, {__mode = 'k'})
    local ok, err = pcall(function()
        assert(type(context) == 'table' and type(timeline) == 'table', 'Facial timeline is unavailable')
        assert(timeline.version == 1 and timeline.continuous == true and type(timeline.complete) == 'boolean'
            and type(context.requestId) == 'string' and #context.requestId > 0
            and type(context.entity) == 'string' and #context.entity > 0
            and timeline.requestId == context.requestId and timeline.entity == context.entity
            and finite(context.generation) and context.generation >= 0 and context.generation % 1 == 0
            and timeline.generation == context.generation, 'Facial timeline belongs to another reply')
        assert(finite(duration) and duration > 0 and duration <= 120
            and finite(timeline.duration) and math.abs(timeline.duration - duration) < .001,
            'Facial duration mismatch')
        assert((timeline.source == 'convai-arkit61' or timeline.source == 'audio-envelope'
            or timeline.source == 'local-phonetic' or timeline.source == 'local-jali')
            and timeline.segment == nil, 'Unknown continuous facial source')
        assert(timeline.motion == nil or (timeline.motion == 'local-phonetic-smooth-v1'
            and timeline.source ~= 'convai-arkit61' and timeline.source ~= 'local-jali'), 'Unknown continuous facial motion')
        if timeline.source == 'local-phonetic' then
            assert(timeline.articulation == 'coarticulated-v5', 'Unknown continuous phonetic articulation')
        elseif timeline.source == 'local-jali' then
            assert(timeline.articulation == 'jali-audio-v1', 'Unknown continuous model articulation')
        elseif timeline.source == 'audio-envelope' then
            assert(timeline.articulation == nil, 'Envelope cannot claim phonetic articulation')
        end
        assert(type(timeline.tracks) == 'table' and #timeline.tracks > 0 and #timeline.tracks <= 32
            and type(timeline.frames) == 'table' and #timeline.frames >= 2 and #timeline.frames <= 7202,
            'Invalid facial timeline size')
        local used, previous = {}, -1
        for _, track in ipairs(timeline.tracks) do
            assert(allowed[track] and not used[track], 'Unknown or duplicate facial control')
            used[track] = true
        end
        for _, frame in ipairs(timeline.frames) do
            assert(type(frame) == 'table' and #frame == #timeline.tracks + 1
                and finite(frame[1]) and frame[1] >= 0 and frame[1] <= duration
                and frame[1] > previous, 'Invalid facial frame time')
            if not seen[frame] then
                for index = 2, #frame do
                    assert(finite(frame[index]) and frame[index] >= 0 and frame[index] <= trackLimit(timeline.tracks[index-1]), 'Invalid facial weight')
                end
                seen[frame] = true
            end
            previous = frame[1]
        end
        assert(timeline.frames[1][1] == 0 and math.abs(previous - duration) < .001, 'Incomplete facial timeline')
        if sameOwner then
            assert(timeline.motion == M.timeline.motion, 'Continuous facial motion changed')
            assert(duration >= M.timeline.duration and (not M.timeline.complete or timeline.complete),
                'Continuous facial timeline moved backwards')
            assert(#timeline.tracks == #M.timeline.tracks, 'Continuous facial controls changed')
            for index, track in ipairs(timeline.tracks) do
                assert(track == M.timeline.tracks[index], 'Continuous facial controls changed')
            end
        end
        assert(speaker(actor, context.entity), 'Speaker has no prepared facial layer')
    end)
    if not ok then
        M.error = tostring(err)
        if sameOwner then M.stop(actor, 'error') end
        return false
    end
    if not sameOwner then
        local created, feature = pcall(NewObject, 'ConvaiFaceFeature')
        if not created or not feature then M.error = 'Native facial feature is unavailable'; return false end
        M.feature, M.index, M.applied = feature, 1, 0
        M.requestId, M.entity, M.generation = context.requestId, context.entity, context.generation
        M.jawLift = jawLiftFor(actor, context.entity)
        M.active, M.continuous, M.state = true, true, 'waiting-for-audio'
        M.lastPosition, M.position, M.segment, M.restored = nil, nil, nil, false
        M.localPose, M.localPosePosition = nil, nil
    end
    M.localMotion = timeline.motion == 'local-phonetic-smooth-v1'
    M.timeline, M.source, M.articulation = timeline, timeline.source, timeline.articulation
    M.checkedRows = seen
    M.providerExpressions=providerExpressions(timeline,seen)
    M.modelExpressions=modelExpressions(timeline,seen)
    M.expressionTrackKeys=expressionTrack(timeline)
    M.blinkBoundaries=blinkBoundaries(timeline)
    M.blinkBoundaryIndex=blinkCursor(M.blinkBoundaries,M.position or 0)
    M.beginExpression(context,timeline.expression)
    M.error, M.timelineChanged = nil, true
    -- A live tail can be re-interpolated or compacted. Keep the playback index
    -- when its bracket remains valid; otherwise locate the current cursor in
    -- the replacement data without rewinding the visible pose.
    local at, frames = math.min(M.position or 0, duration), timeline.frames
    if M.index >= #frames or frames[M.index][1] > at or frames[M.index + 1][1] < at then
        local low, high = 1, #frames - 1
        while low < high do
            local middle = math.floor((low + high + 1) / 2)
            if frames[middle][1] <= at then low = middle else high = middle - 1 end
        end
        M.index = low
    end
    return true
end

-- Hands the face to the idle writer after a pause or a stalled cursor: the written speech tracks ease to zero over
-- releaseSeconds first (the first call snapshots them), then the usual reset hands over. True once it has handed over.
local function releaseSpeech(actor)
    local feature,dt=M.feature,M.expressionDelta or 0
    local release=M.release
    -- Native: the speech values live in the vector handed to the plugin, not on the feature object.
    local vec=native and M.speechVec or nil
    if not release then
        release={level=1,base={}}
        for _,track in ipairs(M.timeline.tracks) do
            local value
            if vec then value=vec[FIELD[track]] else value=feature[track] end
            release.base[track]=finite(value) and value or 0
        end
        M.release=release
    end
    release.level=release.level-dt/releaseSeconds
    if release.level<=0 then
        M.release, M.stall = nil, 0
        reset(actor)
        M.localPose, M.localPosePosition = nil, nil
        M.state, M.lastPosition = 'paused', nil
        return true
    end
    if vec then for track,value in pairs(release.base) do vec[FIELD[track]]=value*release.level end
    else for track,value in pairs(release.base) do feature[track]=value*release.level end end
    applyFeature(actor,feature,M.entity,'speaking')
    M.state='releasing'
    return false
end
-- True while the written mouth is open enough that a one-frame close would show as a snap.
local function mouthOpen()
    local jaw
    if native and M.speechVec then jaw=M.speechVec[FIELD.jaw_mid_open] else jaw=M.feature and M.feature.jaw_mid_open end
    return finite(jaw) and jaw>.02
end

function M.pause(actor)
    if not M.active or M.state == 'paused' then return end
    -- Waiting for the first audio (a buffering stream or a loading phrase) is not a pause of a written face:
    -- resetting here blanked her idle face before the lip sync started (October 9).
    if M.heardRequest~=M.requestId then return end
    -- A menu pause freezes the clock (no delta to ease with), a closed mouth has nothing to ease, and a speaker without the
    -- expression layer (a world NPC) has no idle writer to hand over to: plain reset.
    if M.release or (M.feature and M.expressionManaged and not M.expressionPaused and (M.expressionDelta or 0)>0 and mouthOpen()) then
        if pcall(releaseSpeech,actor) then return end
        M.release=nil
    end
    reset(actor)
    M.localPose, M.localPosePosition = nil, nil
    M.state, M.lastPosition = 'paused', nil
end

function M.sync(actor, position, requestId)
    if not M.active or requestId ~= M.requestId then return end
    local ok, err = pcall(function()
        assert(speaker(actor), 'Facial playback owner changed')
        assert(finite(position) and position >= 0, 'Invalid audio cursor')
        local continuousEnd = M.continuous and position >= M.timeline.duration
        if continuousEnd and M.timeline.complete then M.stop(actor, 'finished'); return end
        -- A stalled cursor already handed the face to the idle writer: stay out until the audio moves again.
        if M.stalledAt then
            if math.abs(position - M.stalledAt) < 1 / 60 - 1e-6 then return end
            M.stalledAt = nil
        end
        -- An exact 60 Hz step can subtract to a few ULPs below 1/60.
        -- A republished/growing continuous timeline is not a new audio tick.
        -- Native phrase handoffs retain their existing replacement semantics.
        if (M.continuous or not M.timelineChanged) and M.lastPosition
            and math.abs(position - M.lastPosition) < 1 / 60 - 1e-6
            and not (position >= M.timeline.duration and M.lastPosition < M.timeline.duration) then
            -- The same cursor again and again while playing: after stallSeconds the mouth must not stay where it was.
            if M.continuous then
                M.stall = (M.stall or 0) + (M.expressionDelta or 0)
                if M.stall >= stallSeconds and M.expressionManaged and not M.expressionPaused and (M.release or mouthOpen()) then
                    local released, done = pcall(releaseSpeech, actor)
                    if not released then M.release = nil elseif done then M.stalledAt = position end
                end
            end
            return
        end
        M.stall, M.release = 0, nil
        local frames, tracks = M.timeline.frames, M.timeline.tracks
        if position >= M.timeline.duration and not M.continuous
            and not (M.segment and not M.segment.last) then M.stop(actor, 'finished'); return end
        local heardPosition = position
        position = math.min(position, M.timeline.duration)
        if M.lastPosition and heardPosition < M.lastPosition then
            M.index = 1; M.localPose, M.localPosePosition = nil, nil
        end
        while M.index < #frames - 1 and frames[M.index + 1][1] <= position do M.index = M.index + 1 end
        local left, right = frames[M.index], frames[M.index + 1]
        local alpha = math.max(0, math.min(1, (position - left[1]) / (right[1] - left[1])))
        local motionPosition = heardPosition + (M.segment and M.segment.startSeconds or 0)
        local motionElapsed = M.localPosePosition and math.max(0, motionPosition - M.localPosePosition) or 1 / 60
        -- Only a graph without speech_owner gets the jaw curve (see jawLimit above).
        -- Known before the first frame of a reply (the idle writer probes it), but a reply can come first.
        if ownerFace == nil and M.feature then detectOwner(M.feature) end
        local lift = ownerFace == false and M.jawLift or nil
        local reach = M.source == 'local-jali' and modelReach or nil
        local vec = native and (M.speechVec or newSpeechVec()) or nil
        M.speechVec = vec or M.speechVec
        for i, track in ipairs(tracks) do
            local value = left[i + 1] + (right[i + 1] - left[i + 1]) * alpha
            local gain = reach and reach[track]
            if gain then value = math.min(value * gain, trackLimit(track)) end
            if lift and track == 'jaw_mid_open' then value = liftJaw(value, lift) end
            if M.localMotion then
                -- Local acoustic shapes (Pocket and Omni) share this easing.
                -- Retain the last applied pose across live phone revisions
                -- and contiguous Omni phrases. Only elapsed audio time moves
                -- it; publication count and render FPS cannot pump the mouth.
                M.localPose = M.localPose or {}
                local previous = M.localPose[track] or 0
                local contact = track == 'lips_together_up' or track == 'lips_together_dn'
                    or track == 'tongue_mid_tip_up' or track == 'lips_suck_dn'
                -- Brief consonant contacts retain a faster attack, while jaw
                -- and lip extensions blend across roughly two visual frames.
                local seconds = contact and value > previous and .018 or .035
                value = previous + (value - previous) * (1 - math.exp(-motionElapsed / seconds))
                M.localPose[track] = value
            end
            if vec then vec[FIELD[track]] = value else M.feature[track] = value end
        end
        if M.localMotion then M.localPosePosition = motionPosition end
        local provider
        if M.providerExpressions then
            local a,b=M.providerExpressions[M.index],M.providerExpressions[M.index+1]
            provider={};for i=2,10 do provider[i-1]=a[i]+(b[i]-a[i])*alpha end
        end
        local upper
        if M.modelExpressions then
            local a,b=M.modelExpressions[M.index],M.modelExpressions[M.index+1]
            upper={raise=a[2]+(b[2]-a[2])*alpha,lower=a[3]+(b[3]-a[3])*alpha}
        end
        local mix
        if M.expressionTrackKeys then mix=sampleTrack(M.expressionTrackKeys,position) end
        -- A phrase start just heard (an occasional boundary blink); a separate phrase's last .35 s holds no new
        -- blink, since the face holds its last frame until the next phrase's audio starts.
        local boundary=false
        local boundaries,cursor=M.blinkBoundaries,M.blinkBoundaryIndex or 1
        while boundaries and boundaries[cursor] and boundaries[cursor]<=position do cursor=cursor+1;boundary=true end
        M.blinkBoundaryIndex=cursor
        local room=M.continuous or M.timeline.duration-position>.35
        M.heardRequest=M.requestId
        applyFeature(actor,M.feature,M.entity,'speaking',provider,upper,mix,boundary,room)
        M.position, M.lastPosition = M.continuous and heardPosition or position, M.continuous and heardPosition or position
        M.timelineChanged = nil
        M.state = position >= M.timeline.duration and 'holding-boundary' or 'playing'
        M.applied = M.applied + 1
    end)
    if not ok then M.error = tostring(err); M.stop(actor, 'error') end
end

function M.hold(actor, requestId)
    if M.active and M.requestId == requestId and M.segment and not M.segment.last then
        M.sync(actor, M.timeline.duration, requestId)
        return M.active
    end
    M.stop(actor, 'chunk-finished')
    return false
end

-- Why a face request or a reply ended without a speaking face, in a sentence, for the log (init.lua convaiFaceRequestLog and the
-- "Conversation result" line). The status words come from Face.reds (ConvaiFaceRequest, ConvaiFaceStatus); a speaking face
-- ("prepared:...") and a word nobody knows have no reason. Read only when such a line is written, never per frame.
local FACE_REASONS = {
    {'^service%-unavailable$', 'the redscript half of the mod is not loaded (see the redscript log)'},
    {'^codeware%-missing$', 'Codeware is missing or did not load, so the scripts compiled without the face layer'},
    {'^unavailable$', 'the character is not attached to the world'},
    {'^initializing$', 'the copy was still being built'},
    {'^no%-face%-rig$', 'the model has no face_rig component, so there is no face to move'},
    {'^rig%-not%-loaded$', 'the face rig did not load'},
    {'^unsupported%-rig$', 'the face rig lacks the lip-sync tracks, so no mouth can be written (a model with its own rig)'},
    {'^speech%-graph%-not%-loaded$', 'the game has not loaded the mod face graphs: convai_facial.archive is missing, in the wrong folder or not enabled'},
    {'^skipped:named$', 'a story character the game placed; its face is driven only while Talk to story characters is on, after the next load'},
    {'^skipped:quest$', 'a quest has marked this character, left to the game'},
    {'^skipped:no%-record$', 'the character has no readable record, left to the game'},
    {'^skipped:dialogue$', 'the character is in a game dialogue'},
    {'^skipped:driven$', 'a quest or a scene commands this character'},
}
function M.faceStatusReason(status)
    if type(status) ~= 'string' or status == '' then return nil end
    if status:find('^prepared') then return nil end
    -- A screen face (an add-on) says the same thing under a "screen:" prefix.
    local plain = status:gsub('^screen:', '')
    for _, row in ipairs(FACE_REASONS) do
        if plain:find(row[1]) then return row[2] end
    end
    local path = plain:match('^unsupported%-graph:(.*)$') or plain:match('^unprepared:(.*)$')
    if path then
        if path:find('_lc%.animgraph$') then
            return 'its face runs a light-crowd graph, which the mod has no lip-sync copy of yet'
        end
        if path:find('^cyberpunk_convai\\') then return nil end
        return 'its face runs a graph the mod has no copy of (' .. path .. '): a model another mod replaced, or a face the game builds another way'
    end
    local live = plain:match('^stale:(%S*)')
    if live then
        return 'the face was rebuilt after the mod prepared it (an appearance change by another mod or the game) and now runs ' .. live
    end
    return nil
end
-- The text appended to a face log line: the reason, then the native facts (ConvaiFaceDetail: kind, record, appearance, entity
-- template, face graph and rig, the mod's own graphs). An install whose scripts lack the detail method still gets the reason.
function M.faceNote(actor, status)
    local text = ''
    local reason = M.faceStatusReason(status)
    if reason then text = ' why=' .. reason end
    if actor ~= nil then
        local ok, detail = pcall(function() return actor:ConvaiFaceDetail() end)
        if ok and type(detail) == 'string' and detail ~= '' then text = text .. ' | ' .. detail end
    end
    return text
end
-- The state of the mod's own face graphs in the game (13 expected: nine companion graphs, four crowd copies), read once per session
-- for the log (init.lua convaiFaceRequestLog, at the first talk start): a game that never mounted convai_facial.archive says
-- loaded:0 failed:13 before any face request has to fail, and a working install says so in its report too. The two settings that
-- decide who gets a face follow. Errors when the redscript half is missing.
function M.graphReport()
    local service = Game.GetScriptableServiceContainer():GetService(CName.new('ConvaiFaceService'))
    local text = service:GraphReport()
    if type(text) ~= 'string' or text == '' then error('no graph report') end
    return text .. ' crowd=' .. tostring(M.crowdMode or 'gated') .. ' story=' .. tostring(M.storyTalk)
end
-- True when a face request status needs a log line: anything but a speaking face. ("managed" is what scripts older than this
-- change answered for our own copies; it says nothing, so it stays quiet.)
function M.faceNeedsLine(ok, status)
    if not ok then return true end
    return status ~= 'managed' and not tostring(status):find('^prepared')
end

function M.status()
    mergeTurn(M.lastSpeechExpression)
    return {state = M.state or 'idle', source = M.source, articulation = M.articulation, position = M.position,
        applied = M.applied or 0, restored = M.restored, error = M.error,
        expressions = {clock=M.expressionClock,error=M.expressionError,lastSpeech=M.lastSpeechExpression},
        -- Blinks this layer started while a reply played, and at other times (idle, listening, thinking),
        -- counted since the mod loaded (October 9).
        blinks = M.speechBlinks or 0, restBlinks = M.restBlinks or 0}
end

convaiFacialPlayback = M
return M
