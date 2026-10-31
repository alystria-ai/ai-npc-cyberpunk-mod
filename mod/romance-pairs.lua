-- The romance animation table (docs/ROMANCE_ANIMATIONS.md): V and a romance partner, one row per pair of the game's own
-- two-person workspots. This is the ONLY place the clips are named. mod/romance-anim.lua, scripts/Build-GestureAssets.mjs
-- and bridge/romance-anim.test.mjs read it; nothing else repeats a path.
--
-- EVERY ROW IS A CANDIDATE (verified = false). The paths come from the game's workspot path list and the game's own clip
-- names as other tools list them; nobody has yet opened the game files to check them. A local check on the owner's PC with
-- WolvenKit fixes the table: for each row open both workspots, confirm the file exists, which rig each half is for (the V
-- half runs on the player rig, the partner half on her rig), the entry names, the length of the intro and of the loop, and
-- where the two roots sit. Then set verified = true and correct the numbers. A row that fails in the game is skipped for
-- the session and logged in Developer mode, and the next choice is tried (docs/ROMANCE_ANIMATIONS.md, "When a row fails").
--
-- Fields of a row:
--   id          short name, also the device component stem: convai_romance_<id>_v and convai_romance_<id>_n
--   kind        'kiss' | 'hug' | 'hands' | 'sit' | 'cuddle' | 'lie'
--   verified    false until checked against the game files
--   vRigs       player rigs the V half exists for: 'player_man' (male V), 'player_woman' (female V)
--   npcRigs     companion rigs the partner half exists for: 'woman_base' (Judy, Panam), 'man_base' (Kerry), 'man_big' (River)
--   characters  optional: profile keys the half was authored for (a half made for one person is only offered for them)
--   v, n        the two halves: workspot = depot path of the game's workspot; jump = optional entry name for SendJumpToAnimEnt
--               (nil: the workspot plays its own first sequence); loop = optional entry to jump back to when the clip ends
--   hold        seconds the pair lasts before it ends by itself (V can end it sooner by asking, the action list or any danger)
--   loopEvery   optional: seconds between the two re-jumps that keep a finite clip going (needs jump on both halves)
--   placement   'resource' = both play at the workspot's own authored position (tried first); 'offset' = the device sits at V and the
--               partner is placed by `offset` (forward and right in metres from V, yaw in degrees relative to V's facing)
--   offset      the per row offset used for 'offset' placement and as the fallback when the roots do not line up
--   needs       nil, or what the clip assumes around it: 'seat' (a couch or chair under V), 'bed', 'car', 'ledge', 'table'. A row with a
--               need is offered only where the game confirms it (options.supports); none is confirmed in this update, so they wait
--   offer       false: kept in the table for the record and never offered (the reason is in note)
--   speech      'hold' = the partner stops talking and a reply that arrives ends the pair early (short clips);
--               'fit' = a reply may play during it (long poses)
--   note        where it comes from and what to check
return {
    version = 1,

    -- Which kinds can stand in for a kind that has no pair for these two rigs, in order. The first kinds with a usable pair is
    -- offered, and the confirmation names what will really happen.
    fallback = {
        kiss = {'hug', 'hands', 'sit'},
        hug = {'hands', 'sit'},
        cuddle = {'sit', 'hands'},
        lie = {'cuddle', 'sit', 'hands'},
        sit = {'hands'},
        hands = {'sit'},
    },

    -- Seconds the pair lasts when a row gives no hold.
    holdDefault = {kiss = 8, hug = 9, hands = 30, sit = 45, cuddle = 50, lie = 50},

    rows = {
        -- ---- hug --------------------------------------------------------------------------------------------------------------
        {id = 'hug_judy', kind = 'hug', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base'}, characters = {'judy-alvarez'},
            v = {workspot = 'base\\workspots\\quest\\main_quests\\epilogue\\q202\\q202_05_convoy\\q202__synced__player__stand_ground__hug__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\main_quests\\epilogue\\q202\\q202_05_convoy\\q202__synced__judy__stand_ground__hug__01.workspot'},
            hold = 9, placement = 'resource', offset = {forward = 0.35, right = 0.0, yaw = 180}, speech = 'hold',
            note = 'The convoy scene hug of Judy and V on open ground (q202_05). Check that the V half is not male only.'},
        {id = 'hold_judy', kind = 'hug', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base'}, characters = {'judy-alvarez'},
            v = {workspot = 'base\\workspots\\quest\\main_quests\\epilogue\\q202\\q202_05_convoy\\q202__synced__player__stand_ground__hold__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\main_quests\\epilogue\\q202\\q202_05_convoy\\q202__synced__judy__stand_ground__hold__01.workspot'},
            hold = 12, placement = 'resource', offset = {forward = 0.35, right = 0.0, yaw = 180}, speech = 'fit',
            note = 'The held embrace of the same scene (a loop). Check whether it loops by itself.'},

        -- ---- cuddle -----------------------------------------------------------------------------------------------------------
        {id = 'cuddle_kerry', kind = 'cuddle', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'man_base'}, characters = {'kerry-eurodyne'},
            v = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__player__synced__hangouts_cuddle_with_kerry__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__kerry__synced__hangouts_cuddle_with_player__01.workspot'},
            hold = 50, placement = 'resource', offset = {forward = 0.5, right = 0.0, yaw = 180}, speech = 'fit',
            note = 'The hangout cuddle (mq055). The idle half is mq055__kerry__synced__hangouts_cuddle_with_player_idle__01. Check the prop it assumes (the sofa).'},
        {id = 'cuddle_river', kind = 'cuddle', verified = false,
            vRigs = {'player_woman'}, npcRigs = {'man_big'}, characters = {'river-ward'},
            v = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__female_player__synced__hangouts_cuddle_with_river__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__river__synced__hangouts_cuddle_with_female_player__01.workspot'},
            hold = 50, placement = 'resource', offset = {forward = 0.5, right = 0.0, yaw = 180}, speech = 'fit',
            note = 'The hangout cuddle for a female V (mq055). Idle half: mq055__river__synced__hangouts_cuddle_with_female_player_idle__01. A male V has no River half in the list.'},
        {id = 'lap_judy', kind = 'cuddle', verified = false, needs = 'seat',
            vRigs = {'player_man'}, npcRigs = {'woman_base'}, characters = {'judy-alvarez'},
            v = {workspot = 'base\\workspots\\quest\\minor_quests\\mq053\\mq053__player_male__synced__judy_lies_on_v_lap__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\minor_quests\\mq053\\mq053__judy__synced__judy_lies_on_v_lap__01.workspot'},
            hold = 50, placement = 'resource', offset = {forward = 0.0, right = 0.0, yaw = 0}, speech = 'fit',
            note = 'Judy lies across V on a seat (mq053). Waits for a confirmed seat.'},
        {id = 'lap_woman', kind = 'cuddle', verified = false, needs = 'seat',
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base'},
            v = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__player__synced__lie_idle_on_v_lap__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\minor_quests\\mq055\\mq055__female_average__synced__lie_idle_on_v_lap__01.workspot'},
            hold = 50, placement = 'resource', offset = {forward = 0.0, right = 0.0, yaw = 0}, speech = 'fit',
            note = 'A woman lies across V on a seat (mq055), any woman_base partner. Waits for a confirmed seat.'},

        -- ---- sit together and lie together (two single workspots side by side on open ground) ----------------------------------
        {id = 'sit_ground', kind = 'sit', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base', 'man_base', 'man_big'},
            v = {workspot = 'base\\workspots\\player\\ground\\player__sit_ground_lean_back__idle__01.workspot'},
            n = {workspot = 'base\\workspots\\common\\ground\\generic__sit_ground_lean_back__sit_around__01.workspot'},
            hold = 45, placement = 'offset', offset = {forward = 0.0, right = 0.75, yaw = 0}, speech = 'fit',
            note = 'Two separate sit-on-the-ground workspots, partner placed beside V by the offset. The fallback of everything.'},
        {id = 'lie_ground', kind = 'lie', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base', 'man_base', 'man_big'},
            v = {workspot = 'base\\workspots\\quest\\main_quests\\part1\\q116\\q116_05_mikoshi\\q116__player__lie_ground__lie_around__01.workspot'},
            n = {workspot = 'base\\workspots\\common\\ground\\generic__lie_ground_lean_left__lie_around__01.workspot'},
            hold = 50, placement = 'offset', offset = {forward = 0.0, right = 0.8, yaw = 0}, speech = 'fit',
            note = 'Two separate lie-on-the-ground workspots side by side. The star gazing pair of the party scene (q114__synced__female__lie_ground__look_at_stars__01 and the male one) has no V half in the list.'},

        -- ---- hands and standing close -----------------------------------------------------------------------------------------
        {id = 'close_kerry', kind = 'hands', verified = false,
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'man_base'}, characters = {'kerry-eurodyne'},
            v = {workspot = 'base\\workspots\\quest\\side_quests\\sq017\\sq017_18_sync_kerry_introduce_you\\synced__player__stand__idle__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\side_quests\\sq017\\sq017_18_sync_kerry_introduce_you\\synced__kerry__stand__idle__01.workspot'},
            hold = 30, placement = 'resource', offset = {forward = 0.45, right = 0.0, yaw = 180}, speech = 'fit',
            note = 'Kerry and V standing close and idle (sq017). Check that nothing in it is a handshake or a pose for a camera.'},

        -- ---- kept for the record, never offered -------------------------------------------------------------------------------
        {id = 'kiss_judy_chair', kind = 'kiss', verified = false, offer = false,
            vRigs = {'player_man'}, npcRigs = {'woman_base'}, characters = {'judy-alvarez'},
            v = {}, n = {workspot = 'base\\workspots\\quest\\side_quests\\sq030\\sq030_09_pier\\sq030__judy__sit_chair__try_kissing__01.workspot'},
            hold = 8, placement = 'resource', speech = 'hold',
            note = 'Only Judy half is in the list and it sits on a chair. No V half known.'},
        {id = 'kiss_wall', kind = 'kiss', verified = false, offer = false,
            vRigs = {'player_man'}, npcRigs = {'woman_base'},
            v = {jump = 'synced__lean_wall_female_kiss_player__01_man_player'}, n = {jump = 'synced__lean_wall_female_kiss_player__01_female_average'},
            hold = 7, placement = 'offset', offset = {forward = 0.75, right = 0.0, yaw = 180}, speech = 'hold',
            note = 'Clip names of the game animset for a kiss against a wall. The animset path and the workspot that holds it are not known: a kiss needs a workspot that lists these two entries.'},
        {id = 'kiss_pool_table', kind = 'kiss', verified = false, offer = false, needs = 'table',
            vRigs = {'player_man'}, npcRigs = {'woman_base'},
            v = {jump = 'synced__v_kiss_pool_table__01'}, n = {jump = 'synced__v_kiss_pool_table__01'},
            hold = 8, placement = 'resource', speech = 'hold',
            note = 'Kiss at the pool table (needs the table). Clip name only.'},
        {id = 'car_hood_panam', kind = 'lie', verified = false, offer = false, needs = 'car',
            vRigs = {'player_man'}, npcRigs = {'woman_base'}, characters = {'panam-palmer'},
            v = {workspot = 'base\\workspots\\quest\\minor_quests\\mq052\\mq052__player_male__synced__panam_v_lie_on_car_hood__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\minor_quests\\mq052\\mq052__panam__synced__panam_v_lie_on_car_hood__01.workspot'},
            hold = 50, placement = 'resource', speech = 'fit',
            note = 'Panam and V on a car hood (mq052, also panam_v_sitting_on_car_hood__01). Needs a car under them.'},
        {id = 'cliff_panam', kind = 'sit', verified = false, offer = false, needs = 'ledge',
            vRigs = {'player_man', 'player_woman'}, npcRigs = {'woman_base'}, characters = {'panam-palmer'},
            v = {workspot = 'base\\workspots\\quest\\main_quests\\part1\\q114\\q114_05_quiet_place\\q114__synced__player__sit_cliff__embrace__01.workspot'},
            n = {workspot = 'base\\workspots\\quest\\main_quests\\part1\\q114\\q114_05_quiet_place\\q114__synced__panam__sit_cliff__embrace__01.workspot'},
            hold = 50, placement = 'resource', speech = 'fit',
            note = 'Panam and V sitting on the cliff (q114_05). Needs a ledge.'},
    },
}
