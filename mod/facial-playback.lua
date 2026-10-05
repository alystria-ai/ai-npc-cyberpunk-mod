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
local function owns(actor, entity)
    return actor and convaiCompanions and convaiCompanions.owns(actor)
        and tostring(actor:GetEntityID().hash) == (entity or M.entity)
        and actor:IsAttached() and not actor:IsDeadNoStatPool() and actor:ConvaiFaceReady()
end
-- Speech and expressions share this one native writer. These per-copy entries
-- retain primitives and feature values only, never actors or world components.
local expressionTracks = {'lips_l_corner_up','lips_r_corner_up','lips_l_corner_dn','lips_r_corner_dn',
    'eye_l_brows_raise_in','eye_r_brows_raise_in','eye_l_brows_raise_out','eye_r_brows_raise_out',
    'eye_l_brows_lower','eye_r_brows_lower'}
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
-- Cyberpunk's own dialogue lipsync (extracted JALI corpus) keeps corner-up
-- around .10 during speech and raises brows to ~.44 at p95. These caps stay
-- well inside that, so expressions read without becoming theatrical.
local function expressionLimit(track)
    return track:find('corner_up',1,true) and .12 or (track:find('corner_dn',1,true) and .10 or .20)
end
M.expressions, M.expressionClock, M.expressionFrame = {}, 0, 0
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
        slot.emotion,slot.family,slot.sequence,slot.expiry=nil,nil,-1,nil
    end
    M.acceptExpression(context,receipt)
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
    slot.emotion,slot.family,slot.scale,slot.sequence=label,families[label:lower()] or 'unknown',receipt.scale,receipt.sequence
    return true
end
function M.endExpression(context,finished)
    local slot=type(context)=='table' and M.expressions[context.entity]
    if not slot or not sameExpressionOwner(slot,context) then return end
    slot.active=false
    if finished and slot.emotion then slot.expiry=M.expressionClock+(negative[slot.family] and 8 or 4)
    else slot.emotion,slot.family,slot.expiry=nil,nil,nil;slot.pose=zeroExpression() end
end
function M.clearExpression(entity)
    M.expressions[entity]=nil
end
function M.beginExpressionFrame(delta,context)
    M.expressionFrame=M.expressionFrame+1
    M.expressionDelta=finite(delta) and clamp(delta,.1) or 0
    M.expressionPaused=type(context)=='table' and context.paused==true
    M.expressionBlocked=type(context)=='table' and context.blocked==true
    M.expressionManaged=type(context)=='table'
    local thinking=type(context)=='table' and context.thinkingEntity or nil
    local listening=type(context)=='table' and context.listeningEntity or nil
    local thinkingRequest=type(context)=='table' and context.thinkingRequestId or nil
    -- A new player input retires an earlier reaction before another reply is
    -- audible. Thinking/listening never infer mood from the text or voice.
    for _,entity in ipairs({thinking or false,listening or false}) do
        if entity and not (M.active and M.entity==entity) and
            ((entity==thinking and (thinking~=M.thinkingEntity or thinkingRequest~=M.expressionThinkingRequest))
                or (entity==listening and listening~=M.listeningEntity)) then
            local slot=M.expressions[entity]
            if slot then slot.emotion,slot.family,slot.expiry,slot.active=nil,nil,nil,false;slot.pose=zeroExpression() end
        end
    end
    M.thinkingEntity,M.listeningEntity,M.expressionThinkingRequest=thinking,listening,thinkingRequest
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
    return (phase=='speaking' and .60 or 1)*(1-closure)*(1-rounding)
end
local function expressionPose(slot,phase,feature,provider,blocked,upper)
    local target=zeroExpression()
    if slot.expiry and M.expressionClock>=slot.expiry then slot.emotion,slot.family,slot.expiry=nil,nil,nil end
    local family,strength=slot.family,({.35,.65,1})[slot.scale or 1]
    local function pair(stem,value) target['lips_l_'..stem]=value;target['lips_r_'..stem]=value end
    local function brows(stem,value) target['eye_l_brows_'..stem]=value;target['eye_r_brows_'..stem]=value end
    if family=='joy' then pair('corner_up',.085*strength);brows('raise_out',.04*strength)
    elseif family=='trust' then pair('corner_up',.055*strength)
    elseif family=='sadness' then pair('corner_dn',.065*strength);brows('raise_in',.085*strength)
    elseif family=='anger' then pair('corner_dn',.04*strength);brows('lower',.085*strength)
    elseif family=='fear' then pair('corner_dn',.025*strength);brows('raise_in',.08*strength);brows('raise_out',.05*strength)
    elseif family=='disgust' then pair('corner_dn',.055*strength);brows('lower',.06*strength)
    elseif family=='surprise' then brows('raise_in',.04*strength);brows('raise_out',.08*strength)
    elseif family=='anticipation' then brows('raise_out',.035*strength)
    elseif family~='unknown' and phase=='idle' then pair('corner_up',.025) end
    if provider then
        local source={eye_l_brows_lower=.08*provider[5],eye_r_brows_lower=.08*provider[6],
            eye_l_brows_raise_in=.08*provider[7],eye_r_brows_raise_in=.08*provider[7],
            eye_l_brows_raise_out=.07*provider[8],eye_r_brows_raise_out=.07*provider[9]}
        if family=='joy' or family=='trust' then source.lips_l_corner_up=.06*provider[1];source.lips_r_corner_up=.06*provider[2]
        else source.lips_l_corner_dn=.06*provider[3];source.lips_r_corner_dn=.06*provider[4] end
        for track,value in pairs(source) do target[track]=math.max(target[track],value) end
        if (source.lips_l_corner_dn or 0)>.005 or (source.lips_r_corner_dn or 0)>.005
            or source.eye_l_brows_lower>.01 or source.eye_r_brows_lower>.01 then pair('corner_up',0) end
    end
    local suppress=negative[family] or family=='unknown'
    if suppress then pair('corner_up',0) end
    if family=='joy' or family=='trust' then pair('corner_dn',0);brows('lower',0) end
    local budget=mouthBudget(feature,phase)
    for _,track in ipairs(expressionTracks) do
        local goal=clamp(target[track],expressionLimit(track))
        if track:sub(1,5)=='lips_' then goal=goal*budget end
        local prior=slot.pose[track]
        local seconds=goal>prior and .18 or .55
        slot.pose[track]=blocked and 0 or (prior+(goal-prior)*(1-math.exp(-(M.expressionDelta or 0)/seconds)))
    end
    if suppress or target.lips_l_corner_dn>0 or target.lips_r_corner_dn>0 then
        slot.pose.lips_l_corner_up,slot.pose.lips_r_corner_up=0,0
    end
    if target.lips_l_corner_up>0 or target.lips_r_corner_up>0 then
        slot.pose.lips_l_corner_dn,slot.pose.lips_r_corner_dn=0,0
        slot.pose.eye_l_brows_lower,slot.pose.eye_r_brows_lower=0,0
    end
    for _,track in ipairs(expressionTracks) do
        -- Hard closure/rounding suppression happens after smoothing, too.
        feature[track]=math.min(slot.pose[track],expressionLimit(track)*(track:sub(1,5)=='lips_' and budget or 1))
    end
    -- Voice-synchronous brows from the game-trained model (emphasis flashes,
    -- focused frowns). Already smooth and on the audio clock: combined by max
    -- with the smoothed emotional pose, never summed, and toned down where it
    -- would contradict the emotion (raised brows in anger, lowered in joy).
    if upper and not blocked then
        -- Held-out game lines: audio predicts brow raises only loosely (r .29)
        -- and lowering hardly at all (r .13), so raises stay light and the
        -- predicted lowering is not used (neutral when unsure).
        local raise=.35*upper.raise*((family=='anger' or family=='disgust') and .4 or 1)
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
local function applyFeature(actor,feature,entity,phase,provider,upper)
    local slot=expressionSlot(entity)
    local blocked=M.expressionBlocked or M.expressionPaused or not safeExpressionActor(actor)
    if blocked then slot.emotion,slot.family,slot.expiry=nil,nil,nil end
    expressionPose(slot,phase,feature,provider,blocked,upper)
    assert(actor:ConvaiFaceApply(feature),'Native facial layer rejected the frame')
    slot.written=M.expressionFrame
    slot.phase,slot.blocked,slot.applied=phase,blocked,(slot.applied or 0)+1
    slot.appliedPose={};for _,track in ipairs(expressionTracks) do slot.appliedPose[track]=feature[track] end
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
function M.updateExpressions(context)
    if type(context)~='table' or M.expressionPaused then return end
    local seen={}
    for _,row in ipairs(context.actors or {}) do
        local entity,actor=row.entity,row.npc
        if type(entity)=='string' and not seen[entity] then
            seen[entity]=true
            local ok,err=pcall(function()
                if not owns(actor,entity) then M.expressions[entity]=nil;return end
                local slot=expressionSlot(entity)
                if slot.written==M.expressionFrame or (M.active and M.entity==entity) then return end
                slot.feature=slot.feature or NewObject('ConvaiFaceFeature')
                assert(slot.feature,'Native facial feature is unavailable')
                local phase=(slot.active and 'thinking') or (M.thinkingEntity==entity and 'thinking')
                    or (M.listeningEntity==entity and 'listening') or 'idle'
                applyFeature(actor,slot.feature,entity,phase)
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
local function reset(actor)
    local ok, done = pcall(function()
        return owns(actor) and actor:ConvaiFaceReset()
    end)
    M.restored = ok and done == true
    if M.restored and M.entity and M.expressions[M.entity] then
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
end

function M.abandon(reason)
    clear()
    M.state, M.entity, M.restored = reason or 'unloaded', nil, false
    M.expressions,M.expressionClock={},0
end

function M.stop(actor, reason)
    if M.active then reset(actor) end
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
        assert(owns(actor, context.entity), 'Speaker has no prepared owned facial layer')
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
    M.requestId, M.timeline, M.index = context.requestId, timeline, 1
    M.source, M.active, M.state = timeline.source, true, 'waiting-for-audio'
    M.articulation = timeline.articulation
    M.localMotion = timeline.motion == 'local-phonetic-smooth-v1'
    M.localPose, M.localPosePosition = retainedPose, retainedPosition
    M.providerExpressions=providerExpressions(timeline)
    M.modelExpressions=modelExpressions(timeline)
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
        assert(owns(actor, context.entity), 'Speaker has no prepared owned facial layer')
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
        M.active, M.continuous, M.state = true, true, 'waiting-for-audio'
        M.lastPosition, M.position, M.segment, M.restored = nil, nil, nil, false
        M.localPose, M.localPosePosition = nil, nil
    end
    M.localMotion = timeline.motion == 'local-phonetic-smooth-v1'
    M.timeline, M.source, M.articulation = timeline, timeline.source, timeline.articulation
    M.providerExpressions=providerExpressions(timeline)
    M.modelExpressions=modelExpressions(timeline)
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
    reset(actor)
    M.localPose, M.localPosePosition = nil, nil
    M.state, M.lastPosition = 'paused', nil
end

function M.sync(actor, position, requestId)
    if not M.active or requestId ~= M.requestId then return end
    local ok, err = pcall(function()
        assert(owns(actor), 'Facial playback owner changed')
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
        for i, track in ipairs(tracks) do
            local value = left[i + 1] + (right[i + 1] - left[i + 1]) * alpha
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
        applyFeature(actor,M.feature,M.entity,'speaking',provider,upper)
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
        expressions = {clock=M.expressionClock,error=M.expressionError}}
end

convaiFacialPlayback = M
return M
