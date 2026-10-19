// A fake Redis for the tests. The admission script is the REAL Lua text from api/_lib/admit.js, executed by fengari
// (a Lua VM in JavaScript) against a small in-memory Redis with a controllable clock. Only the commands the service
// uses are implemented; anything else throws, so a new command cannot slip in untested.
import fengari from 'fengari';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

export class FakeStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.data = new Map(); // key -> {type, value, expiresAt}
    this.commands = 0; // billed commands: one per command, one per script, one per pipelined command
    this.scripts = 0;
    this.log = [];
    this.failing = false;
  }

  #live(key) {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  /** The entry under `key` when it holds `type`, undefined when absent; throws like Redis when it holds something else. */
  #typed(key, type) {
    const entry = this.#live(key);
    if (entry && entry.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return entry;
  }

  #create(key, type, value) {
    const entry = { type, value, expiresAt: null };
    this.data.set(key, entry);
    return entry;
  }

  /** Redis removes a hash, list or zset that has become empty (and its expiry with it). */
  #tidy(key) {
    const entry = this.data.get(key);
    if (!entry || entry.type === 'string') return;
    if ((entry.type === 'list' ? entry.value.length : entry.value.size) === 0) this.data.delete(key);
  }

  /** A zset's members by ascending score, ties by member, as Redis orders them. */
  static #ascending(entry) {
    return [...entry.value].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** A score bound as ZREMRANGEBYSCORE takes it: -inf, +inf, a number, or '(' + number for "not including". */
  static #bound(text) {
    const lower = text.toLowerCase();
    if (lower === '-inf') return { value: -Infinity, exclusive: false };
    if (lower === '+inf' || lower === 'inf') return { value: Infinity, exclusive: false };
    const exclusive = text.startsWith('(');
    const value = Number(exclusive ? text.slice(1) : text);
    if (Number.isNaN(value)) throw new Error(`min or max is not a float: ${text}`);
    return { value, exclusive };
  }

  /** The inclusive index range start..stop of a list of `length` items (negative counts from the end), as a [from, to) slice. */
  static #range(length, start, stop) {
    let from = Number(start), to = Number(stop);
    if (from < 0) from = Math.max(0, length + from);
    if (to < 0) to = length + to;
    return [from, Math.min(length - 1, to) + 1];
  }

  /** The Redis commands this fake knows. Returns what Redis would: integers as numbers, bulk strings as strings, nil as null. */
  exec(args) {
    const [name, key, ...rest] = args.map(String);
    switch (name.toUpperCase()) {
      case 'INCR': {
        const entry = this.#live(key);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.data.set(key, { type: 'string', value: String(next), expiresAt: entry?.expiresAt ?? null });
        return next;
      }
      case 'EXPIRE': {
        const entry = this.#live(key);
        if (!entry) return 0;
        entry.expiresAt = this.now() + Number(rest[0]) * 1000;
        return 1;
      }
      case 'TTL': {
        const entry = this.#live(key);
        if (!entry) return -2;
        return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - this.now()) / 1000);
      }
      case 'EXISTS':
        return this.#live(key) ? 1 : 0;
      case 'GET': {
        const entry = this.#live(key);
        return entry ? entry.value : null;
      }
      case 'SET': {
        const [value, ...options] = rest;
        let expiresAt = null;
        for (let index = 0; index < options.length; index++) {
          if (options[index].toUpperCase() === 'EX') expiresAt = this.now() + Number(options[++index]) * 1000;
          else throw new Error(`SET option not supported by the fake: ${options[index]}`);
        }
        this.data.set(key, { type: 'string', value, expiresAt });
        return 'OK';
      }
      case 'DEL': {
        let removed = 0;
        for (const name of [key, ...rest]) {
          if (this.#live(name)) {
            this.data.delete(name);
            removed += 1;
          }
        }
        return removed;
      }
      case 'ZINCRBY': {
        const entry = this.#live(key) ?? { type: 'zset', value: new Map(), expiresAt: null };
        const [increment, member] = rest;
        const score = (entry.value.get(member) ?? 0) + Number(increment);
        entry.value.set(member, score);
        this.data.set(key, entry);
        return String(score);
      }
      case 'ZCARD':
        return this.#live(key)?.value.size ?? 0;
      case 'ZREVRANGE': {
        const entry = this.#live(key);
        if (!entry) return [];
        const sorted = FakeStore.#ascending(entry).reverse();
        const stop = Number(rest[1]);
        const slice = sorted.slice(Number(rest[0]), stop < 0 ? undefined : stop + 1);
        return rest.includes('WITHSCORES') ? slice.flatMap(([member, score]) => [member, String(score)]) : slice.map(([member]) => member);
      }
      case 'HSET': {
        if (!rest.length || rest.length % 2) throw new Error('wrong number of arguments for HSET');
        const entry = this.#typed(key, 'hash') ?? this.#create(key, 'hash', new Map());
        let added = 0;
        for (let index = 0; index < rest.length; index += 2) {
          if (!entry.value.has(rest[index])) added += 1;
          entry.value.set(rest[index], rest[index + 1]);
        }
        return added;
      }
      case 'HSETNX': {
        const entry = this.#typed(key, 'hash') ?? this.#create(key, 'hash', new Map());
        if (entry.value.has(rest[0])) return 0;
        entry.value.set(rest[0], rest[1]);
        return 1;
      }
      case 'HGET':
        return this.#typed(key, 'hash')?.value.get(rest[0]) ?? null;
      case 'HEXISTS':
        return this.#typed(key, 'hash')?.value.has(rest[0]) ? 1 : 0;
      case 'HLEN':
        return this.#typed(key, 'hash')?.value.size ?? 0;
      case 'HGETALL':
        // The flat [field, value, ...] list Upstash's REST interface returns.
        return [...(this.#typed(key, 'hash')?.value ?? [])].flat();
      case 'HINCRBY': {
        const entry = this.#typed(key, 'hash') ?? this.#create(key, 'hash', new Map());
        const current = Number(entry.value.get(rest[0]) ?? 0);
        if (!Number.isInteger(current) || !Number.isInteger(Number(rest[1]))) throw new Error('hash value is not an integer');
        const next = current + Number(rest[1]);
        entry.value.set(rest[0], String(next));
        return next;
      }
      case 'HDEL': {
        const entry = this.#typed(key, 'hash');
        if (!entry) return 0;
        const removed = rest.filter(field => entry.value.delete(field)).length;
        this.#tidy(key);
        return removed;
      }
      case 'LPUSH': {
        const entry = this.#typed(key, 'list') ?? this.#create(key, 'list', []);
        for (const item of rest) entry.value.unshift(item);
        return entry.value.length;
      }
      case 'RPOP': {
        const entry = this.#typed(key, 'list');
        if (!entry) return null;
        const item = entry.value.pop() ?? null;
        this.#tidy(key);
        return item;
      }
      case 'LLEN':
        return this.#typed(key, 'list')?.value.length ?? 0;
      case 'LINDEX': {
        const list = this.#typed(key, 'list')?.value ?? [];
        const at = Number(rest[0]);
        return list[at < 0 ? list.length + at : at] ?? null;
      }
      case 'LRANGE': {
        const list = this.#typed(key, 'list')?.value ?? [];
        const [from, to] = FakeStore.#range(list.length, rest[0], rest[1]);
        return list.slice(from, to);
      }
      case 'LREM': {
        const entry = this.#typed(key, 'list');
        if (!entry) return 0;
        const limit = Number(rest[0]);
        const wanted = Math.abs(limit) || Infinity;
        let removed = 0;
        const order = [...entry.value.keys()];
        if (limit < 0) order.reverse();
        const drop = new Set();
        for (const position of order) {
          if (removed >= wanted) break;
          if (entry.value[position] === rest[1]) {
            drop.add(position);
            removed += 1;
          }
        }
        entry.value = entry.value.filter((_, position) => !drop.has(position));
        this.#tidy(key);
        return removed;
      }
      case 'ZADD': {
        if (!rest.length || rest.length % 2 || rest.some((part, index) => index % 2 === 0 && Number.isNaN(Number(part)))) {
          throw new Error('ZADD form not supported by the fake (only score member pairs)');
        }
        const entry = this.#typed(key, 'zset') ?? this.#create(key, 'zset', new Map());
        let added = 0;
        for (let index = 0; index < rest.length; index += 2) {
          if (!entry.value.has(rest[index + 1])) added += 1;
          entry.value.set(rest[index + 1], Number(rest[index]));
        }
        return added;
      }
      case 'ZREM': {
        const entry = this.#typed(key, 'zset');
        if (!entry) return 0;
        const removed = rest.filter(member => entry.value.delete(member)).length;
        this.#tidy(key);
        return removed;
      }
      case 'ZREMRANGEBYSCORE': {
        const entry = this.#typed(key, 'zset');
        if (!entry) return 0;
        const low = FakeStore.#bound(rest[0]), high = FakeStore.#bound(rest[1]);
        let removed = 0;
        for (const [member, score] of [...entry.value]) {
          const above = low.exclusive ? score > low.value : score >= low.value;
          const below = high.exclusive ? score < high.value : score <= high.value;
          if (above && below) {
            entry.value.delete(member);
            removed += 1;
          }
        }
        this.#tidy(key);
        return removed;
      }
      case 'ZREMRANGEBYRANK': {
        const entry = this.#typed(key, 'zset');
        if (!entry) return 0;
        const ordered = FakeStore.#ascending(entry);
        const [from, to] = FakeStore.#range(ordered.length, rest[0], rest[1]);
        const doomed = ordered.slice(from, to);
        for (const [member] of doomed) entry.value.delete(member);
        this.#tidy(key);
        return doomed.length;
      }
      case 'PING':
        return 'PONG';
      default:
        throw new Error(`Redis command not supported by the fake: ${name}`);
    }
  }

  #guard() {
    if (this.failing) throw new Error('store unreachable');
  }

  async command(args) {
    this.#guard();
    this.commands += 1;
    this.log.push(String(args[0]).toUpperCase());
    return this.exec(args);
  }

  async pipeline(commands) {
    this.#guard();
    this.commands += commands.length;
    this.log.push('PIPELINE');
    return commands.map(args => this.exec(args));
  }

  /** Runs the script in a fresh Lua state; counts as ONE command however many Redis calls it makes. */
  async evalScript(script, keys, args) {
    this.#guard();
    this.commands += 1;
    this.scripts += 1;
    this.log.push('EVAL');
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const fail = message => { throw new Error(message); };
    const pushList = (list, name) => {
      lua.lua_createtable(L, list.length, 0);
      list.forEach((value, index) => {
        lua.lua_pushstring(L, to_luastring(String(value)));
        lua.lua_rawseti(L, -2, index + 1);
      });
      lua.lua_setglobal(L, to_luastring(name));
    };
    pushList(keys, 'KEYS');
    pushList(args, 'ARGV');
    const call = state => {
      const count = lua.lua_gettop(state);
      const callArgs = [];
      for (let index = 1; index <= count; index++) callArgs.push(to_jsstring(lua.lua_tolstring(state, index)));
      const result = this.exec(callArgs);
      if (result === null) lua.lua_pushboolean(state, false);
      else if (typeof result === 'number') lua.lua_pushinteger(state, result);
      else if (typeof result === 'string') lua.lua_pushstring(state, to_luastring(result));
      else fail('unsupported reply inside the script');
      return 1;
    };
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushjsfunction(L, call);
    lua.lua_setfield(L, -2, to_luastring('call'));
    lua.lua_setglobal(L, to_luastring('redis'));
    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== 0) fail('script does not compile: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 1, 0) !== 0) fail('script failed: ' + to_jsstring(lua.lua_tostring(L, -1)));
    const result = [];
    const length = lua.lua_rawlen(L, -1);
    for (let index = 1; index <= length; index++) {
      lua.lua_rawgeti(L, -1, index);
      result.push(lua.lua_isnumber(L, -1) && lua.lua_type(L, -1) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -1) : to_jsstring(lua.lua_tolstring(L, -1)));
      lua.lua_pop(L, 1);
    }
    lua.lua_close(L);
    return result;
  }
}

/** A Convai double: counts mints and revokes, hands out numbered tokens that live an hour, never touches the network. */
export function createFakeConvai({ now = () => Date.now(), lifetimeMs = 3_600_000 } = {}) {
  const state = { mints: 0, revokes: [], failing: false, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    state.calls.push({ url: String(url), headers: init.headers, body: init.body });
    if (state.failing) return new Response('{}', { status: 500 });
    if (String(url).endsWith('/user/connect')) {
      state.mints += 1;
      return Response.json({ apiAuthToken: `fake-token-${state.mints}`, expirationTime: new Date(now() + lifetimeMs).toISOString() });
    }
    if (String(url).endsWith('/user/revoke-token')) {
      state.revokes.push(JSON.parse(init.body).apiAuthToken);
      return Response.json({});
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, state };
}
