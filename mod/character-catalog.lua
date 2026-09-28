-- Resolve a named actor before considering a generic crowd voice. Body type
-- alone is never an identity for a quest character or a managed companion.
local M = {}
local function normalized(value)
    return tostring(value or ''):lower():gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', '')
end
function M.build(profiles)
    local catalog = {keys = {}, names = {}, records = {}}
    for _, profile in ipairs(profiles) do
        catalog.keys[profile.key] = profile
        catalog.names[normalized(profile.name)] = profile
        for _, alias in ipairs(profile.aliases or {}) do catalog.names[normalized(alias)] = profile end
        for _, record in ipairs(profile.records or {}) do catalog.records[record] = profile end
    end
    return catalog
end
function M.resolve(catalog, actor)
    if actor.managedKey then
        local profile = catalog.keys[actor.managedKey]
        return actor.managedKey, profile and profile.name or actor.name
    end
    local profile = catalog.records[actor.record] or catalog.names[normalized(actor.name)]
    if profile then return profile.key, profile.name end
    if not actor.crowd then return nil, actor.name end
    local body = normalized(actor.bodyType)
    if body:find('woman',1,true) or body:find('female',1,true) then return 'resident-female', actor.name end
    if body:find('man',1,true) or body:find('male',1,true) then return 'resident-male', actor.name end
    return nil, actor.name
end
return M
