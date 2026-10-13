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
      case 'DEL':
        return this.data.delete(key) ? 1 : 0;
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
        const sorted = [...entry.value].sort((a, b) => b[1] - a[1]);
        const stop = Number(rest[1]);
        const slice = sorted.slice(Number(rest[0]), stop < 0 ? undefined : stop + 1);
        return rest.includes('WITHSCORES') ? slice.flatMap(([member, score]) => [member, String(score)]) : slice.map(([member]) => member);
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
