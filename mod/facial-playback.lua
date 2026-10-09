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
-- The speaker: whoever speech.lua is voicing right now, a managed companion or
-- a world NPC (ambient resident, archetype, named character met in the world).
-- ConvaiFaceReady() is the native ownership proof: a tagged companion copy or a
-- world NPC whose face_rig ConvaiFaceService prepared (Face.reds). Speech hands
-- only its own target here, matched to the reply's entity.
local function speaker(actor, entity)
    return actor and tostring(actor:GetEntityID().hash) == (entity or M.entity)
        and actor:IsAttached() and not actor:IsDeadNoStatPool() and actor:ConvaiFaceReady()
end
-- Idle, thinking and listening faces stay on managed companions only.
local function owns(actor, entity)
    return actor and convaiCompanions and convaiCompanions.owns(actor) and speaker(actor, entity)
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
-- Mood hold after a negative turn: seconds of neutral rest, a shorter hold once a
-- later turn was calm, and the ease back to the resting smile.
local moodHoldSeconds,moodCalmSeconds,moodEaseSeconds,moodThreshold=60,10,5,.2
local function traitFor(profile) return traitTable[profile] or traitTable.default end
local speechMouthFactor=.85
-- October 9 (user: Evelyn and Johnny, with wider, thinner lips than Judy, "don't open the mouth on some words"):
-- every speech source is calibrated on Judy's rig, where a jaw weight of .06 already parts her lips. Measured in game
-- on 23 characters (docs/COMPANION_EXPRESSIONS.md, lip sync round): the shared woman_average heads (Evelyn, Alex, Claire,
-- Lizzy, Mama Welles, Meredith, Misty, Panam, Regina, Rogue, Songbird, Wakako) keep their lips sealed until about .20,
-- and the man_average / man_big / man_fat heads part them later and less than Judy. Typical speech sits at jaw .04-.15
-- (median .12), so many words never broke the seal. The jaw weight is lifted by a concave curve that is steepest at 0 and
-- exactly the identity at the validation ceiling, so the widest vowels are unchanged and silence stays closed:
--   jaw' = .7 * (1 - (1 - jaw / .7) ^ q)       q = 2: .06 -> .115, .12 -> .22, .20 -> .36, .37 -> .55
-- q is a constant per head type (the facial graph name, read once per reply, never per frame), or a per-character
-- override (traitTable[profile].jawLift, false = none). Judy's graph (player_woman_photomode) has no entry: unchanged.
local jawLimit=.7
local jawLiftByGraph={woman_average=2,man_average=1.5,man_big=1.5,man_fat=1.5}
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
    return rest>0 and jawLimit*(1-rest^lift) or jawLimit
end
M.expressions, M.expressionClock, M.expressionFrame = {}, 0, 0
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
local function expressionSlot(entity)
    if not M.expressions[entity] then M.expressions[entity]={pose=zeroExpression(),sequence=-1} end
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
    slot.holdMix=nil;slot.browExpiry=nil;slot.flick={};slot.turnNegative=0
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
    else slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil;slot.pose=zeroExpression() end
end
function M.clearExpression(entity)
    M.expressions[entity]=nil
end
function M.beginExpressionFrame(delta,context)
    if faceTest then pcall(faceTest.poll,delta,context) end
    M.expressionFrame=M.expressionFrame+1
    M.expressionDelta=finite(delta) and clamp(delta,.1) or 0
    M.expressionPaused=type(context)=='table' and context.paused==true
    M.expressionBlocked=type(context)=='table' and context.blocked==true
    M.expressionManaged=type(context)=='table'
    local thinking=type(context)=='table' and context.thinkingEntity or nil
    local listening=type(context)=='table' and context.listeningEntity or nil
    local thinkingRequest=type(context)=='table' and context.thinkingRequestId or nil
    -- A new player input ends an earlier reply's ownership that was never heard. The face itself keeps its
    -- idle expression (the resting smile, a lingering reaction, a mood hold) through listening and thinking;
    -- only the next reply's first audible frame changes it (October 9; before, the input zeroed it at once).
    -- Thinking/listening never infer mood from the text or voice.
    for _,entity in ipairs({thinking or false,listening or false}) do
        if entity and not (M.active and M.entity==entity) and
            ((entity==thinking and (thinking~=M.thinkingEntity or thinkingRequest~=M.expressionThinkingRequest))
                or (entity==listening and listening~=M.listeningEntity)) then
            local slot=M.expressions[entity]
            if slot and slot.awaitingAudio then slot.active,slot.awaitingAudio=false,false;slot.cueEmotion,slot.cueFamily,slot.cueScale=nil,nil,nil end
        end
    end
    M.thinkingEntity,M.listeningEntity,M.expressionThinkingRequest=thinking,listening,thinkingRequest
    for _,row in ipairs(type(context)=='table' and type(context.actors)=='table' and context.actors or {}) do
        local known=type(row)=='table' and M.expressions[row.entity]
        if known then known.profile=row.profileKey end
    end
    if not M.expressionPaused and finite(delta) then M.expressionClock=M.expressionClock+math.max(0,delta) end
end
local function safeExpressionActor(actor)
    if not M.expressionManaged then return true end
    local ok,ready=pcall(function()
        if not actor:IsOnAutonomousAI() or NPCPuppet.IsInCombat(actor) then return false end
        local scene=Game.GetSceneSystem():GetScriptInterface()
        if scene:IsEntityInDialogue(actor:GetEntityID()) or scene:IsEntityInScene(actor:GetEntityID()) then return false end
        -- Status effects are the game's injury/incapacitation signal. Missing
        -- native APIs fail closed for the optional expression layer only.
        for _,tag in ipairs({'Injured','Defeated','Unconscious','Stunned','Ragdoll'}) do
            if StatusEffectSystem.ObjectHasStatusEffectWithTag(actor,CName.new(tag)) then return false end
        end
        return true
    end)
    return ok and ready==true
end
local function mouthBudget(feature,phase)
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
local function expressionPose(slot,phase,feature,provider,blocked,upper,mix)
    if phase=='speaking' and slot.awaitingAudio then startHeard(slot) end
    local target=zeroExpression()
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
    local function flick(name,weight)
        local age=slot.flick[name] or 0
        if weight>.1 then age=age+(M.expressionDelta or 0) else age=0 end
        slot.flick[name]=age
        return math.max(0,math.min(1,1-(age-1.0)/1.0))
    end
    local surpriseFlick,interestFlick
    if weights then
        weights={table.unpack(weights)}
        surpriseFlick,interestFlick=flick('surprise',weights[7] or 0),flick('anticipation',weights[8] or 0)
        weights[7]=(weights[7] or 0)*surpriseFlick;weights[8]=(weights[8] or 0)*interestFlick
    else
        surpriseFlick=flick('surprise',family=='surprise' and strength or 0)
        interestFlick=flick('anticipation',family=='anticipation' and strength or 0)
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
    local function limitFor(track)
        local limit=expressionLimit(track)
        if track:find('corner_',1,true) then limit=limit*capScale end
        return limit
    end
    local function pair(stem,value) target['lips_l_'..stem]=value;target['lips_r_'..stem]=value end
    local function brows(stem,value) target['eye_l_brows_'..stem]=value;target['eye_r_brows_'..stem]=value end
    if weights then mixTargets(weights,target,phase,warmth,trait.smile,trait.squint)
    elseif family=='joy' then pair('corner_up',.45*strength*(1+smileLift*(1-strength))*(trait.smile or 1));brows('raise_out',.30*strength);target.smileRaw=.45*strength*(1+smileLift*(1-strength))*(trait.squint or 1)
    elseif family=='trust' then pair('corner_up',.35*strength*(trait.smile or 1));target.smileRaw=.35*strength*(trait.squint or 1)
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
            or source.eye_l_brows_lower>.01 or source.eye_r_brows_lower>.01 then pair('corner_up',0);frowning=true end
    end
    -- After speech the emotion's brows release within about 1.5 s (corners keep
    -- the longer expiry); they are never held for seconds after the voice stops.
    if slot.browExpiry and M.expressionClock>=slot.browExpiry then
        for _,name in ipairs({'raise_in','raise_out','lower','lateral'}) do brows(name,0) end
        target.eye_l_widen,target.eye_r_widen=0,0
        target.eye_l_oculi_squint_outer_upper,target.eye_r_oculi_squint_outer_upper=0,0
        target.droop=0
    end
    local suppress=not weights and (negative[family] or family=='unknown')
    if suppress then pair('corner_up',0) end
    if not weights and (family=='joy' or family=='trust') then pair('corner_dn',0);brows('lower',0) end
    -- Resting warmth: a floor under every non-negative intent (Interest, surprise,
    -- neutral tone) while idle only. The emotion's own smile wins by max.
    if not weights and phase~='speaking' and not negative[family] and family~='unknown'
        and not frowning and target.lips_l_corner_dn==0 then pair('corner_up',math.max(target.lips_l_corner_up,warmth)) end
    for _,track in ipairs({'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn'}) do target[track]=target[track]*gain end
    local browDown=trait.browDown or 1
    if browDown~=1 then
        for _,track in ipairs({'eye_l_brows_lower','eye_r_brows_lower','eye_l_brows_lateral','eye_r_brows_lateral',
            'eye_l_oculi_squint_outer_upper','eye_r_oculi_squint_outer_upper'}) do target[track]=(target[track] or 0)*browDown end
    end
    -- The smile's own squint (Duchenne), or the feeling's narrowed eyes, whichever is stronger.
    local squintSmile=target.lips_l_corner_up
    if (target.smileRaw or 0)>0 and target.lips_l_corner_up>0 then squintSmile=target.smileRaw*gain end
    local squint=math.min(.5,math.max(target.eye_l_oculi_squint_outer_lower,.6*squintSmile))
    target.eye_l_oculi_squint_outer_lower,target.eye_r_oculi_squint_outer_lower=squint,squint
    local budget=mouthBudget(feature,phase)
    for _,track in ipairs(expressionTracks) do
        if not (weights and track:find('corner_',1,true)) then
            local goal=clamp(target[track] or 0,limitFor(track))
            if track:sub(1,5)=='lips_' then goal=goal*budget end
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
    for _,track in ipairs(expressionTracks) do
        -- Hard closure/rounding suppression happens after smoothing, too.
        feature[track]=math.min(slot.pose[track],limitFor(track)*(track:sub(1,5)=='lips_' and budget or 1))
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
        for _,side in ipairs({'l','r'}) do
            for _,stem in ipairs({'raise_in','raise_out'}) do
                local track='eye_'..side..'_brows_'..stem
                feature[track]=math.min(expressionLimit(track),math.max(feature[track],raise))
            end
            local track='eye_'..side..'_brows_lower'
            feature[track]=math.min(expressionLimit(track),math.max(feature[track],lower))
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
local function applyFeature(actor,feature,entity,phase,provider,upper,mix,boundary,room)
    detectExtended(feature)
    local slot=expressionSlot(entity)
    local blocked=M.expressionBlocked or M.expressionPaused or not safeExpressionActor(actor)
    if blocked then slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.holdMix=nil end
    if faceTest then pcall(faceTest.pre,entity,slot,M.expressionClock) end
    expressionPose(slot,phase,feature,provider,blocked,upper,mix)
    local blink=math.max(blinkWeight(slot,phase,blocked,boundary,room),blocked and 0 or (slot.droop or 0))
    -- A copy that never blinked through this layer keeps the fields untouched (zero, the native face).
    if blink>0 or slot.blinkWritten then feature.eye_l_blink,feature.eye_r_blink=blink,blink;slot.blinkWritten=true end
    -- A blink closes widened eyes too (they would hold the lids apart).
    if blink>0 and feature.eye_l_widen>0 then
        local open=1-blink;feature.eye_l_widen,feature.eye_r_widen=feature.eye_l_widen*open,feature.eye_r_widen*open
    end
    if faceTest then
        local ok,skip=pcall(faceTest.post,entity,feature,phase,blocked)
        if ok and skip then return end
    end
    assert(actor:ConvaiFaceApply(feature),'Native facial layer rejected the frame')
    slot.written=M.expressionFrame
    slot.phase,slot.blocked,slot.applied=phase,blocked,(slot.applied or 0)+1
    slot.appliedPose={};for _,track in ipairs(expressionTracks) do slot.appliedPose[track]=feature[track] end
    if phase=='speaking' then
        -- Peak pose per speech turn, published in speech-state.json so one
        -- in-game reply shows the emotion label, scale and written values.
        local turn=M.lastSpeechExpression
        if not turn or turn.requestId~=slot.requestId or turn.entity~=entity then
            turn={entity=entity,requestId=slot.requestId,frames=0,peak=zeroExpression()}
            M.lastSpeechExpression=turn
        end
        turn.emotion,turn.family,turn.scale,turn.blocked=slot.emotion,slot.family,slot.scale,blocked
        turn.frames=turn.frames+1
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
    local inner,down=slot.pose.eye_l_brows_raise_in or 0,slot.pose.lips_l_corner_dn or 0
    if slot.gazeDown then
        if inner<.2 or slot.blocked then slot.gazeDown=false end
    elseif inner>.35 and down>.15 and not slot.blocked then slot.gazeDown=true end
    return slot.gazeDown and -0.15 or 0
end
-- Cached diagnostics for a parent-owned live probe. No native reads, actor
-- handles, speech weights, remote owners or dialogue appear in this snapshot.
function M.expressionStatus(entity)
    local slot=M.expressions[entity]
    if not slot then return nil end
    local pose={};for _,track in ipairs(expressionTracks) do pose[track]=slot.appliedPose and slot.appliedPose[track] or 0 end
    return {version=1,phase=slot.phase,blocked=slot.blocked,applied=slot.applied or 0,
        emotionPresent=slot.emotion~=nil,active=slot.active==true,pose=pose,clock=M.expressionClock}
end
-- The idle writer's phase for a copy (also used by the hand-over in reset()).
local function idlePhase(slot,entity)
    return (slot.active and 'thinking') or (M.thinkingEntity==entity and 'thinking')
        or (M.listeningEntity==entity and 'listening') or 'idle'
end
function M.updateExpressions(context)
    if type(context)~='table' or M.expressionPaused then return end
    if faceTest then pcall(faceTest.direct,context.actors,function() return NewObject('ConvaiFaceFeature') end) end
    local seen={}
    for _,row in ipairs(context.actors or {}) do
        local entity,actor=row.entity,row.npc
        if type(entity)=='string' and not seen[entity] then
            seen[entity]=true
            local ok,err=pcall(function()
                if not owns(actor,entity) then M.expressions[entity]=nil;return end
                local slot=expressionSlot(entity)
                slot.profile=row.profileKey
                -- Speech owns the face from its first HEARD frame. Before that (a reply prepared, a stream
                -- buffering, an Omni phrase loading) this idle writer keeps her idle face (October 9).
                if slot.written==M.expressionFrame or (M.active and M.entity==entity and M.heardRequest==M.requestId and M.state~='paused') then return end
                slot.feature=slot.feature or NewObject('ConvaiFaceFeature')
                assert(slot.feature,'Native facial feature is unavailable')
                applyFeature(actor,slot.feature,entity,idlePhase(slot,entity))
            end)
            if not ok then M.expressionError=tostring(err);M.expressions[entity]=nil end
        end
    end
    for entity in pairs(M.expressions) do
        if not seen[entity] and not (M.active and M.entity==entity) then M.expressions[entity]=nil end
    end
end
local function providerExpressions(timeline)
    local value=timeline.providerExpressions
    -- Convai turns keep their provider brows/corners when the game-trained
    -- model drives the mouth from the same PCM (source local-jali).
    if (timeline.source~='convai-arkit61' and timeline.source~='local-jali') or type(value)~='table'
        or value.version~=1 or value.format~='arkit61-expression9'
        or type(value.frames)~='table' or #value.frames~=#timeline.frames then return nil end
    for index,frame in ipairs(value.frames) do
        if type(frame)~='table' or #frame~=10 or frame[1]~=timeline.frames[index][1] then return nil end
        for at=2,10 do if not finite(frame[at]) or frame[at]<0 or frame[at]>1 then return nil end end
    end
    return value.frames
end
-- Optional model upper-face curve on the timeline's exact frame times.
local function modelExpressions(timeline)
    local value=timeline.modelExpressions
    if timeline.source~='local-jali' and timeline.source~='audio-envelope' and timeline.source~='convai-arkit61' then return nil end
    if type(value)~='table' or value.version~=1 or value.format~='jali-upper-v1'
        or type(value.frames)~='table' or #value.frames~=#timeline.frames then return nil end
    for index,frame in ipairs(value.frames) do
        if type(frame)~='table' or #frame~=3 or frame[1]~=timeline.frames[index][1] then return nil end
        for at=2,3 do if not finite(frame[at]) or frame[at]<0 or frame[at]>1 then return nil end end
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
            for index = 2, #frame do
                assert(finite(frame[index]) and frame[index] >= 0 and frame[index] <= trackLimit(timeline.tracks[index-1]), 'Invalid facial weight')
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
    M.providerExpressions=providerExpressions(timeline)
    M.modelExpressions=modelExpressions(timeline)
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

function M.pause(actor)
    if not M.active or M.state == 'paused' then return end
    -- Waiting for the first audio (a buffering stream or a loading phrase) is not a pause of a written face:
    -- resetting here blanked her idle face before the lip sync started (October 9).
    if M.heardRequest~=M.requestId then return end
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
        -- An exact 60 Hz step can subtract to a few ULPs below 1/60.
        -- A republished/growing continuous timeline is not a new audio tick.
        -- Native phrase handoffs retain their existing replacement semantics.
        if (M.continuous or not M.timelineChanged) and M.lastPosition
            and math.abs(position - M.lastPosition) < 1 / 60 - 1e-6
            and not (position >= M.timeline.duration and M.lastPosition < M.timeline.duration) then return end
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
        local lift = M.jawLift
        for i, track in ipairs(tracks) do
            local value = left[i + 1] + (right[i + 1] - left[i + 1]) * alpha
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
            M.feature[track] = value
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

function M.status()
    return {state = M.state or 'idle', source = M.source, articulation = M.articulation, position = M.position,
        applied = M.applied or 0, restored = M.restored, error = M.error,
        expressions = {clock=M.expressionClock,error=M.expressionError,lastSpeech=M.lastSpeechExpression},
        -- Blinks this layer started while a reply played, and at other times (idle, listening, thinking),
        -- counted since the mod loaded (October 9).
        blinks = M.speechBlinks or 0, restBlinks = M.restBlinks or 0}
end

convaiFacialPlayback = M
return M
