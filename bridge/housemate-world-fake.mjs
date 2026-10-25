// A flat of V's played out against a fake world (used by the housemate tests). The controller is the real mod/housemates.lua; the data is
// the real spots table unless a test brings its own.
export const WORLD = `
  local Housemates = dofile('housemates.lua')
  local registry = dofile('housemate-registry.lua')
  local world = {place = 'CorpoPlaza_Apartment', hours = 14, ready = true, held = nil, facts = {dlc6_apart_cct_dtn_purchased = 1, dlc6_apart_hey_gle_purchased = 1},
    vpos = {x = -1600, y = 340, z = 49.2}, notes = {}, logs = {}, talking = nil, twin = {}, calls = {}, nextSerial = 1, bodies = {}, handles = {}, party = {},
    joined = {}, released = {}, left = {}, homeOutfit = {}, prepared = 0, facts_read = 0}
  local function call(name) world.calls[name] = (world.calls[name] or 0) + 1 end
  local data = dofile('housemate-spots-data.lua')
  world.data = data
  local names = {['judy-alvarez'] = 'Judy', ['panam-palmer'] = 'Panam', ['rogue'] = 'Rogue', ['river-ward'] = 'River', ['kerry-eurodyne'] = 'Kerry', ['misty'] = 'Misty'}
  local values = {}
  local store = {get = function(n) return values[n] or 0 end, set = function(n, v) values[n] = v end}
  local procCount = 0
  local env = {
    data = function() return world.data end,
    place = function() call('place'); return world.place end,
    hours = function() call('hours'); return world.hours end,
    ready = function() return world.ready end,
    held = function() call('held'); return world.held end,
    fact = function(n) world.facts_read = world.facts_read + 1; return world.facts[n] or 0 end,
    vpos = function() return world.vpos end,
    eligible = function(k) return names[k] ~= nil end,
    profileName = function(k) return names[k] end,
    store = store,
    random = function() world.r = ((world.r or 0.31) * 7.13) % 1 return world.r end,
    talking = function() return world.talking end,
    twin = function(r) return world.twin[r.key] end,
    notify = function(text) world.notes[#world.notes + 1] = text end,
    log = function(line) world.logs[#world.logs + 1] = line end,
    t = function(text, vars) return (text:gsub('{(%w+)}', function(k) return tostring(vars and vars[k]) end)) end,
    bodies = {
      spawn = function(r, spot)
        local serial = world.nextSerial; world.nextSerial = serial + 1
        world.bodies[serial] = {serial = serial, key = r.key, profileKey = r.key, owner = 'housemates', home = r.apt, appointmentId = 'hm:' .. r.key,
          state = 'spawning', entityID = tostring(serial) .. 'ULL', position = {x = spot.x, y = spot.y, z = spot.z}, age = 0, hidden = false}
        world.spawned = (world.spawned or 0) + 1
        return true
      end,
      rows = function()
        call('rows')
        local rows = {}
        for _, b in pairs(world.bodies) do
          b.age = b.age + 1
          if b.state == 'spawning' and b.age >= 2 then b.state = 'visiting' end
          rows[#rows + 1] = b
        end
        return rows
      end,
      delete = function(serial) world.bodies[serial] = nil; world.deleted = (world.deleted or 0) + 1 end,
      hide = function(serial, hidden) if world.bodies[serial] then world.bodies[serial].hidden = hidden end end,
    },
    seats = {
      prepare = function(spot, r)
        world.prepared = world.prepared + 1
        if world.wait and world.wait > 0 then world.wait = world.wait - 1; return nil, nil, 'wait' end
        if world.bad and world.bad[spot.id] then return nil, 'bad' end
        local copy = {}
        for k, v in pairs(spot) do copy[k] = v end
        copy.approach = {x = spot.x, y = spot.y - 1, z = spot.z}
        return copy
      end,
      occupy = function(serial, spot, opts)
        local h = #world.handles + 1
        world.handles[h] = {serial = serial, spot = spot, polls = 0, sleep = opts and opts.sleep, state = 'busy'}
        return h
      end,
      status = function(h)
        local handle = world.handles[h]
        if not handle then return 'released' end
        handle.polls = handle.polls + 1
        if handle.state == 'releasing' then handle.state = 'released' return 'busy' end
        if handle.state == 'released' then return 'released' end
        if world.fail and world.fail[handle.spot.id] then return 'failed' end
        if handle.polls >= 2 then handle.state = 'ready' end
        return handle.state
      end,
      release = function(h, instant)
        local handle = world.handles[h]
        if handle and handle.state ~= 'released' then handle.state = instant and 'released' or 'releasing' end
        world.releases = (world.releases or 0) + 1
      end,
    },
    proc = function(apt, r, used)
      procCount = procCount + 1
      return {x = -1596 + procCount * 1.3, y = 345, z = 49.2}
    end,
    companions = {
      join = function(serial) world.joined[#world.joined + 1] = serial; local b = world.bodies[serial]; if b then b.state = 'ready'; b.owner = nil; world.party[serial] = b; world.bodies[serial] = nil end return true end,
      releaseToHome = function(serial, apt)
        world.released[#world.released + 1] = {serial, apt}
        local b = world.party[serial]
        if b then world.party[serial] = nil; b.state = 'visiting'; b.owner = 'housemates'; b.home = apt; b.appointmentId = 'hm:' .. b.profileKey; b.age = 5; b.position = {x = -1601, y = 356, z = 49}; world.bodies[serial] = b end
        return true
      end,
      partyMember = function(key)
        for serial, b in pairs(world.party) do if b.profileKey == key then return {serial = serial, entityID = b.entityID, name = names[key]} end end
        return nil
      end,
      leave = function(serial) world.left[#world.left + 1] = serial; world.party[serial] = nil end,
    },
    outfits = {setHome = function(key, on) world.homeOutfit[key] = on end},
  }
  local function control(homes)
    local c = Housemates.new(env)
    c.setHomes(homes)
    return c
  end
  local function run(c, seconds, step)
    step = step or 0.25
    for _ = 1, math.floor(seconds / step) do c.update(step) end
  end
  local function count(map) local n = 0 for _ in pairs(map) do n = n + 1 end return n end
  local function snapshot(c) return c.snapshot().residents end
  local function states(c) local out = {} for k, v in pairs(snapshot(c)) do out[k] = v.state end return out end
`;
