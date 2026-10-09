-- Free look while V sits (docs/COMPANION_SEATING.md, "Looking at her").
--
-- The game clamps V's first-person camera inside a workspot with TweakDB
-- camera parameter sets. A workspot state record names its set
-- (playerStateMachineLocomotion.workspot.onEnterCameraParamsName = Workspot,
-- ...workspot_flavour_unlockedCamera = WorkspotUnlocked) and the native
-- camera reads yawMaxLeft / yawMaxRight / pitchMin / pitchMax from
-- fppCameraParamSets.<name> when V enters it. Vanilla values (game 2.3 and
-- Phantom Liberty): Workspot is yaw +-15 and pitch -15..0, WorkspotUnlocked is
-- yaw +-15 and pitch -15..15, so V cannot turn to look at a companion beside
-- her. This module widens those two sets once, from onInit.
--
-- Cost: a handful of TweakDB flat writes at startup. Nothing runs per frame.
-- WorkspotLocked (all zeros: takedowns, trunk disposal and similar scripted
-- workspots) and WorkspotUnlockedCameraVerySmall are never touched, and the
-- scene sets (Tier3Scene, Tier4Scene) are not either. The two widened sets are
-- the ones the game already marks as free-look workspots, which in practice
-- are the seats (couch, bench, chair, bar stool), so the change is a camera
-- comfort fix and not a gameplay change.
local M = {}

-- Seat-beside-V reach: a companion on the same couch or bench is about 90
-- degrees off V's forward. Tier3Scene and Tier4Scene already allow +-90.
M.sets = {'Workspot', 'WorkspotUnlocked'}
M.limits = {
    yawMaxLeft = 90,    -- degrees, positive is left
    yawMaxRight = -90,  -- negative is right
    pitchMin = -50,     -- looking down
    pitchMax = 45,      -- looking up
}

-- Fields only ever widen: a flat that is already wider (another mod, a game
-- patch) is left alone, and running twice changes nothing.
local WIDEN = {yawMaxLeft = math.max, yawMaxRight = math.min, pitchMin = math.min, pitchMax = math.max}

-- Writes the limits into `db` (CET's TweakDB: GetFlat, SetFlat, Update).
-- Returns {changed = n, skipped = {field names}, failed = {field names}}.
function M.apply(db, limits, sets)
    limits, sets = limits or M.limits, sets or M.sets
    local report = {changed = 0, skipped = {}, failed = {}}
    if type(db) ~= 'table' and type(db) ~= 'userdata' then report.failed[1] = 'TweakDB unavailable'; return report end
    for _, set in ipairs(sets) do
        local record, touched = 'fppCameraParamSets.' .. set, false
        for field, widen in pairs(WIDEN) do
            local path = record .. '.' .. field
            local read, current = pcall(function() return db:GetFlat(path) end)
            if not read or type(current) ~= 'number' then
                report.skipped[#report.skipped + 1] = path -- absent in this game build
            else
                local target = widen(current, limits[field])
                if target ~= current then
                    local wrote = pcall(function() return db:SetFlat(path, target) end)
                    local _, after = pcall(function() return db:GetFlat(path) end)
                    if wrote and type(after) == 'number' and math.abs(after - target) < 1e-3 then
                        report.changed, touched = report.changed + 1, true
                    else
                        report.failed[#report.failed + 1] = path
                    end
                end
            end
        end
        -- Re-reads the record from its flats so a cached copy cannot keep the
        -- old limits.
        if touched then pcall(function() return db:Update(record) end) end
    end
    return report
end

return M
