-- Explicit read-only qualification. No facts, journal state or save data writes.
-- This small symbol probe is not a semantic rule pack and never reaches Convai.
local report = {version = 1, capturedAt = os.date('!%Y-%m-%dT%H:%M:%SZ')}
local ok, problem = pcall(function()
    local player = Game.GetPlayer()
    assert(player and player:IsAttached() and not player:IsDeadNoStatPool(), 'Player unavailable')
    local version = Game.GetSystemRequestsHandler():GetGameVersion()
    report.gameVersion = version
    local tracked = dofile('quest-context.lua').capture()
    report.trackedJournal = tracked
    local pack = {version = 1, gameVersions = {version}, factAllowlist = {}, journalAllowlist = {}}
    -- Exact symbols present in the extracted shipping quest graphs. Reading
    -- them tests API types; names alone do not establish narrative meanings.
    for _, name in ipairs({'sq030_judy_lover', 'q101_done', 'q110_done'}) do
        pack.factAllowlist[name] = {evidenceRefs = {'diagnostic-extracted-symbol'}}
    end
    if tracked and tracked.quest then
        pack.journalAllowlist[tracked.quest.id] = {questKey = 'diagnostic-tracked-quest', evidenceRefs = {'diagnostic-live-journal'}}
    end
    local token = 'read-only-capture-probe'
    local collector = dofile('world-knowledge.lua').new({
        currentGeneration = function() return 1 end, currentWorldToken = function() return token end,
    })
    local configured, reason = collector:configure(pack, {gameVersion = version})
    assert(configured, reason)
    -- At most five observations total, with the collector's native work budget.
    for _ = 1, 4 do
        collector:update({generation = 1, worldToken = token})
        report.snapshot = collector:capture({generation = 1, worldToken = token,
            identity = {status = 'unknown'}, audience = {channel = 'private', profileKeys = {'judy-alvarez'}}})
        if report.snapshot.status == 'ready' then break end
    end
    report.progress = collector:progress()
    collector:reset(nil, 'probe-finished')
end)
report.ok, report.error = ok, not ok and tostring(problem) or nil
local file = io.open('runtime/knowledge-capture-probe.json', 'wb')
if file then file:write(json.encode(report)); file:close() end
return report
