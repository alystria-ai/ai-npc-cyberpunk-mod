// The two Durable Object classes: thin wrappers that hand the object's storage to an engine (state.js, errors-store.js). The only
// file besides index.js that imports `cloudflare:workers`, so the engines and the router can be tested in node.
import { DurableObject } from 'cloudflare:workers';
import { ErrorsEngine } from './errors-store.js';
import { StateEngine } from './state.js';

export class StateDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new StateEngine(ctx.storage);
  }
  admit(params) { return this.engine.admit(params); }
  saveToken(params) { return this.engine.saveToken(params); }
  saveShared(params) { return this.engine.saveShared(params); }
  turns(params) { return this.engine.turns(params); }
  getConfig() { return this.engine.getConfig(); }
  setConfig(params) { return this.engine.setConfig(params); }
  getPlans() { return this.engine.getPlans(); }
  ping() { return this.engine.ping(); }
}

export class ErrorsDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new ErrorsEngine(ctx.storage);
  }
  report(params) { return this.engine.report(params); }
  list(params) { return this.engine.list(params); }
  body(params) { return this.engine.body(params); }
  deleteBody(params) { return this.engine.deleteBody(params); }
  deleteSignature(params) { return this.engine.deleteSignature(params); }
  ping() { return this.engine.ping(); }
}
