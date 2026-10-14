// The whole admission decision for one token request, as ONE Redis script: every counter is checked and incremented
// atomically in a single round trip (a script counts as one command on Upstash). Every key has a TTL, so nothing
// needs cleaning up. Written to run on Redis's Lua 5.1 and, in the tests, on fengari's Lua 5.3: it uses no features
// that differ between them (no tostring on numbers, no unpack, no integer division).
//
// KEYS  1 ip-hour counter          2 install-hour counter       3 install-seen marker
//       4 new-installs-per-ip/day  5 turns of the day (zset)    6 mint counter of the day
//       7 per-install token cache    8 stored daily limit (optional, set by POST /api/admin/config)
// ARGV  1 ip/hour limit            2 install/hour limit         3 new installs per ip per day
//       4 daily turn cap           5 turns reported now         6 install pseudonym (zset member)
//       7 'shared' | 'per-install' 8 '1' when a shared token must be minted (instance cache stale)
//       9 mints per day cap        10 now (ms)                  11 re-mint margin (ms)
//       12 lowest accepted stored limit                         13 highest accepted stored limit
//
// The daily limit is ARGV 4 (the environment's value) unless KEYS[8] holds a whole number between ARGV 12 and 13: then that
// stored value wins. It is read inside the script, so changing it costs no extra command and takes effect on the next request.
//
// Returns {code, turnsToday, extra, limit} (limit: the daily limit in force, 0 when the request stopped before it was read). Codes: rate_ip, rate_install, new_install_limit, daily (extra: the install's cached
// token, deleted here, for a revoke), cached (extra: "expiresMs|token"), ok (shared token still fine), mint, busy.
export const ADMIT_SCRIPT = `
local function bump(key, ttl)
  local n = redis.call('INCR', key)
  if n == 1 then redis.call('EXPIRE', key, ttl) end
  return n
end
if bump(KEYS[1], 7200) > tonumber(ARGV[1]) then return {'rate_ip', 0, ''} end
if bump(KEYS[2], 7200) > tonumber(ARGV[2]) then return {'rate_install', 0, ''} end
if redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('SET', KEYS[3], '1', 'EX', 3024000)
  if bump(KEYS[4], 172800) > tonumber(ARGV[3]) then
    redis.call('DEL', KEYS[3])
    return {'new_install_limit', 0, ''}
  end
else
  redis.call('EXPIRE', KEYS[3], 3024000)
end
local cap = tonumber(ARGV[4])
local stored = tonumber(redis.call('GET', KEYS[8]) or '')
if stored and stored == math.floor(stored) and stored >= tonumber(ARGV[12]) and stored <= tonumber(ARGV[13]) then cap = stored end
local turns = tonumber(redis.call('ZINCRBY', KEYS[5], ARGV[5], ARGV[6]))
if redis.call('TTL', KEYS[5]) < 0 then redis.call('EXPIRE', KEYS[5], 259200) end
local per = ARGV[7] == 'per-install'
local cached = false
if per then cached = redis.call('GET', KEYS[7]) end
if turns >= cap then
  if cached then
    redis.call('DEL', KEYS[7])
    return {'daily', turns, cached, cap}
  end
  return {'daily', turns, '', cap}
end
if cached then
  local bar = string.find(cached, '|', 1, true)
  if bar then
    local expires = tonumber(string.sub(cached, 1, bar - 1))
    if expires and expires - tonumber(ARGV[11]) > tonumber(ARGV[10]) then
      return {'cached', turns, cached, cap}
    end
  end
end
if not per and ARGV[8] ~= '1' then return {'ok', turns, '', cap} end
if bump(KEYS[6], 172800) > tonumber(ARGV[9]) then return {'busy', turns, '', cap} end
return {'mint', turns, '', cap}
`;
