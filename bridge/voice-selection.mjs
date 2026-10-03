import {PocketVoice, validatePocketConfig} from './pocket-voice.mjs';
import {ResidentVoice, voiceSteps} from './resident-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

// Routing changes commit only at a conversation boundary. Model preparation
// can begin from a settings draft while that routing remains unchanged.
// CPU/CUDA workers retire through confirmed EOF before another backend starts.
export const canonicalVoiceProvider = value => ['hybrid','omnivoice'].includes(value) ? 'omni' : value;
const local = value => value === 'pocket' || value === 'omni';
const equalSet = (a,b) => a.size===b.size&&[...a].every(key=>b.has(key));
export class VoiceSelection {
  constructor(config = {}, options = {}) {
    const supplied = Object.keys(config).length > 0;
    const validated = supplied ? validatePocketConfig(config) : null;
    const empty=createVoiceProfileRegistry({}),pocketRegistry=validated?.registry||empty;
    const omniInput=options.omniConfig||{},omniRegistry=createVoiceProfileRegistry(omniInput);
    const snapshot=(value,registry)=>Object.freeze({...value,voices:Object.freeze({...registry.profiles,
      ...Object.fromEntries(Object.entries(registry.unavailable).map(([key,status])=>[key,Object.freeze({status})]))}),
      preparation:registry.preparation});
    this.registries={pocket:pocketRegistry,omni:omniRegistry,convai:empty};
    this.configs={pocket:snapshot(validated,pocketRegistry),omni:snapshot(omniInput,omniRegistry)};
    this.options = options;
    this.phoneAnalysis=options.phoneAnalysis;
    this.factory = options.factory || ((settings, hooks) => new PocketVoice(settings, hooks));
    this.omniFactory=options.omniFactory||((settings,hooks)=>new ResidentVoice(settings,hooks));
    this.configuredByBackend={pocket:!!validated&&pocketRegistry.keys.length>0,
      omni:omniInput.provider==='hybrid'&&omniRegistry.keys.length>0};
    this.provider = this.requestedProvider = 'pocket';
    this.omniSteps=this.requestedOmniSteps=voiceSteps(omniInput.steps);
    this.playbackEnabled=true;
    this.routeKeys=[...new Set([...Object.keys(this.configs.pocket.voices),...Object.keys(this.configs.omni.voices),
      ...(options.profileKeys||[])])].sort();
    this.retiring = Promise.resolve(); this.releasing = false;
    this.state = this.configured ? 'stopped' : 'disabled'; this.details = {};
    this.availabilities={pocket:new Set(pocketRegistry.keys),omni:new Set(omniRegistry.keys),convai:new Set()};
    this.verifiedAvailabilities=new Map();this.busy=false;
    this.routeRevision = 0; this.routeChanges = new Set(); this.routingWaiters = new Set();
  }
  get registry(){return this.registries[this.provider];}
  get config(){return this.configs[this.provider]||{};}
  get configured(){return !!this.configuredByBackend[this.provider];}
  get availability(){return this.availabilities[this.provider];}
  get steps(){return this.provider==='omni'?this.omniSteps:undefined;}
  get profileKeys() { return [...new Set([...this.registries.pocket.keys,...this.registries.omni.keys])].sort(); }
  hasProfile(key) { return this.registry.has(key) && this.availability.has(key); }
  usesProfile(key) { return local(this.provider) && this.configured && this.hasProfile(key); }
  profileReady(key) { return !this.closed&&this.usesProfile(key)&&this.clientBackend===this.provider
    &&!this.client?.failure&&!this.client?.closing&&this.client?.profileReady(key)===true; }
  request(settings) {
    if(typeof settings?.voice==='boolean'&&settings.voice!==this.playbackEnabled){
      this.playbackEnabled=settings.voice;this.routeRevision++;
      for(const key of this.routeKeys)this.routeChanges.add(key);
    }
    const chosen=canonicalVoiceProvider(settings?.voiceProvider);
    if (['pocket','omni','convai'].includes(chosen))this.requestedProvider=chosen;
    if ([16,32].includes(settings?.omniSteps))this.requestedOmniSteps=settings.omniSteps;
  }
  get pending() { return this.provider!==this.requestedProvider
    ||(this.provider==='omni'&&this.omniSteps!==this.requestedOmniSteps); }
  get availabilityPending() { const verified=this.verifiedAvailabilities.get(this.provider);
    return !!verified&&!equalSet(this.availability,verified); }
  get previewRoutingPending(){return local(this.provider)&&this.targetBackend!==null&&this.targetBackend!==this.provider;}
  consumeRouteChanges() { const value = [...this.routeChanges].sort(); this.routeChanges.clear(); return value; }
  stageAvailability(client,backend=this.clientBackend) {
    if (this.client !== client || this.closed || !client.loaded) return;
    this.verifiedAvailabilities.set(backend,new Set(this.registries[backend].keys.filter(key=>client.hasProfile(key))));
  }
  routingSettled({signal} = {}) {
    throwIfCancelled(signal);
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    if (!this.pending && !this.availabilityPending&&!this.previewRoutingPending) return Promise.resolve();
    let waiter;
    const pending = new Promise((resolve, reject) => { waiter = {resolve, reject}; this.routingWaiters.add(waiter); });
    return abortable(pending, signal).finally(() => this.routingWaiters.delete(waiter));
  }
  settleRouting() {
    if (this.pending || this.availabilityPending||this.previewRoutingPending) return;
    for (const waiter of this.routingWaiters) waiter.resolve();
    this.routingWaiters.clear();
  }
  get wantsLocal() {
    // Provisional configured profiles keep initial warmup intact. Once an idle
    // commit proves every reference unavailable, residency serves no local
    // route; release it without creating an automatic replacement loop.
    return this.targetBackend!==null;
  }
  get targetBackend(){
    if(this.closed)return null;
    // An unloadable settings draft must not retire a usable committed worker.
    // Apply still changes routing normally and lets unsupported profiles use
    // Convai; a configured draft retains its existing warm-up/retirement path.
    return [this.preview?.provider,this.requestedProvider,this.provider].find(candidate=>local(candidate)
      &&this.configuredByBackend[candidate]&&this.availabilities[candidate].size>0)||null;
  }
  get warmSteps(){return this.preview?.provider==='omni'?this.preview.omniSteps:this.requestedOmniSteps;}
  setPreview(preview) {
    const chosen=canonicalVoiceProvider(preview?.provider),quality=preview?.omniSteps??preview?.steps??32;
    const next=preview&&['pocket','omni','convai'].includes(chosen)&&(!['omni'].includes(chosen)||[16,32].includes(quality))
      ?{provider:chosen,...(chosen==='omni'?{omniSteps:quality}:{})}:null;
    const changed=this.preview?.provider!==next?.provider||this.preview?.omniSteps!==next?.omniSteps;
    this.preview = next;
    return changed;
  }
  prepare(preview) {
    if (this.closed) return;
    const changed = this.setPreview(preview);
    this.reconcile();
    if (changed) this.publish();
  }
  update(settings, preview, busy) {
    if (this.closed) return false;
    this.busy=!!busy;this.request(settings);
    const previewChanged = this.setPreview(preview);
    const applied = this.applyWhenIdle(busy);
    this.reconcile();
    if (previewChanged && !applied) this.publish();
    return applied;
  }
  reconcile() {
    const wanted=this.targetBackend;
    this.phoneAnalysis?.setWanted((this.busy&&this.clientBackend==='pocket'&&this.provider==='pocket')
      ||(this.playbackEnabled!==false&&wanted==='pocket'));
    if(this.client&&this.clientBackend!==wanted){
      // A settings draft queues warm-up immediately, but never stops the
      // model that still owns a submitted local turn.
      if(this.busy&&this.clientBackend===this.provider)return;
      this.retire();
    }
    if(this.clientBackend==='omni'&&wanted==='omni')this.client?.setSteps(this.warmSteps);
    if(wanted)void this.start().catch(()=>{});
    else if(this.client&&!this.busy)this.retire();
  }
  publish(state = this.state, extra = {}) {
    this.state = state;
    const value = {...this.details, version: 1, state, provider: this.provider,
      requestedProvider: this.requestedProvider, pending: this.pending,
      playbackEnabled:this.playbackEnabled,
      omniSteps:this.omniSteps,requestedOmniSteps:this.requestedOmniSteps,
      workerBackend:this.clientBackend,preparationQueued:this.targetBackend!==this.clientBackend,
      configured: this.configured, bridgePid: process.pid,
      configuredProfiles: this.profileKeys,
      availabilityPending: this.availabilityPending, routeRevision: this.routeRevision,
      routedProfiles: local(this.provider)?[...this.availability].sort():[],
      previewActive: !!this.preview, previewProvider: this.preview?.provider,
      previewOmniSteps:this.preview?.omniSteps,
      preparationOnly:this.wantsLocal&&this.targetBackend!==this.provider,
      updated: Date.now(), ...extra};
    try { Promise.resolve(this.options.onState?.(value)).catch(() => {}); } catch {}
  }
  applyWhenIdle(busy) {
    if (this.closed) return false;
    this.busy=!!busy;
    if (!this.pending && !this.availabilityPending) { this.settleRouting(); return false; }
    if (busy) { this.reconcile(); this.publish(); return false; }
    const previous = new Set(this.profileKeys.filter(key => this.usesProfile(key)));
    this.provider = this.requestedProvider;
    this.omniSteps=this.requestedOmniSteps;
    const verified=this.verifiedAvailabilities.get(this.provider);
    if(verified)this.availabilities[this.provider]=new Set(verified);
    if(this.clientBackend==='omni')this.client?.setSteps(this.omniSteps);
    const changedRoutes = this.profileKeys.filter(key => previous.has(key) !== this.usesProfile(key));
    if (changedRoutes.length) {
      this.routeRevision++;
      for (const key of changedRoutes) this.routeChanges.add(key);
    }
    this.reconcile();
    this.publish();
    this.settleRouting();
    return true;
  }
  start() {
    if (this.closed) return Promise.reject(Error('Voice service is closed'));
    this.phoneAnalysis?.setWanted((this.busy&&this.clientBackend==='pocket'&&this.provider==='pocket')
      ||(this.playbackEnabled!==false&&this.targetBackend==='pocket'));
    if (!this.wantsLocal) {
      this.publish(this.releasing ? 'releasing' : (this.provider === 'convai' ? 'remote' : 'disabled'));
      return Promise.resolve();
    }
    const backend=this.targetBackend;
    if(this.clientBackend===backend&&this.client?.failure)return Promise.reject(this.client.failure);
    if(this.client&&this.clientBackend!==backend){
      if(this.busy&&this.clientBackend===this.provider)return this.starting||Promise.resolve();
      this.retire();
    }
    if (this.starting) return this.starting;
    let client;
    this.clientBackend=backend;
    const factory=backend==='omni'?this.omniFactory:this.factory;
    const hooks={...this.options,...(backend==='omni'?{configPath:this.options.omniConfigPath,
      pythonExecutable:this.options.omniPythonExecutable}:{}),onState: value => {
      if (this.client !== client || this.closed) return;
      if (value.state === 'ready') this.stageAvailability(client,backend);
      this.details = value; this.publish(value.state);
    }};
    client=this.client=factory(this.configs[backend],hooks);
    if(backend==='omni')client.setSteps(this.warmSteps);
    this.publish(this.releasing ? 'releasing' : 'loading');
    this.starting = this.retiring.then(async () => {
      if (this.client !== client || this.closed) return;
      await client.start();
      this.stageAvailability(client,backend);
    });
    this.starting.catch(() => {});
    return this.starting;
  }
  retire() {
    const client = this.client;
    const backend=this.clientBackend;
    this.client = this.starting = this.clientBackend = null;
    if (!client) { this.publish(this.releasing ? 'releasing' : (this.closed ? 'stopped' : 'remote')); return this.retiring; }
    this.releasing = true;
    this.publish('releasing');
    // Signal EOF even during warmup. The worker owns its bounded physical
    // cleanup; waiting for readiness first could prevent shutdown forever.
    // An unconfirmed prior exit must continue blocking any replacement.
    const phoneRetirement=backend==='pocket'?this.phoneAnalysis?.retire().catch(()=>{}):undefined;
    const retirement = this.retiring.then(() => Promise.all([client.close(),phoneRetirement]));
    this.retiring = retirement.then(() => {
      if (this.retiring !== completed) return;
      this.releasing = false;
      if (!this.client) {
        this.details = {resident:false,gpuVramBytes:0,cudaAllocatedMiB:0,cudaReservedMiB:0};
        this.publish(this.closed ? 'stopped' : 'remote');
      }
    });
    const completed = this.retiring;
    this.retiring.catch(() => this.publish('error', {detail: 'Could not release local voices. Restart the voice service.'}));
    return this.retiring;
  }
  async synthesizeStream(profile, text, options = {}) {
    if (this.provider!=='pocket'||!this.usesProfile(profile))throw Error('This character does not use Pocket streaming');
    await abortable(this.start(), options.signal); throwIfCancelled(options.signal);
    const client = this.client;
    if (!client || this.clientBackend!=='pocket'||!this.usesProfile(profile))throw Error('Voice selection changed before synthesis');
    return client.synthesizeStream(profile, text, options);
  }
  async synthesize(profile,text,options={}){
    if(this.provider!=='omni'||!this.usesProfile(profile))throw Error('This character does not use OmniVoice');
    const steps=options.steps??this.omniSteps;
    await abortable(this.start(),options.signal);throwIfCancelled(options.signal);
    const client=this.client;
    if(!client||this.clientBackend!=='omni'||this.provider!=='omni'||!this.usesProfile(profile))
      throw Error('Voice selection changed before synthesis');
    return client.synthesize(profile,text,{...options,steps});
  }
  async prepareProfile(profile, options = {}) {
    const remote = reason => ({provider: 'convai', ready: true, reason});
    for (;;) {
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      await this.routingSettled(options);
      throwIfCancelled(options.signal);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (!this.configured || !this.registry.has(profile)) return remote(this.registry.status(profile));
      const startingBackend=this.provider;let startedClient;
      try {
        const starting=this.start();startedClient=this.client;
        await abortable(starting, options.signal);
      }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote('selected');
        throw error;
      }
      throwIfCancelled(options.signal);
      // A ready worker can discover a vanished reference during an owned turn.
      // The flight waits for the normal idle commit; no polling loop is held.
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (!this.hasProfile(profile)) return remote('unavailable');
      const client = this.client;
      // Retry only a real ownership/selection transition. A fulfilled startup
      // with no loaded owner is a failure, not a resolved-await polling loop.
      if(this.provider!==startingBackend||client!==startedClient)continue;
      if(client?.failure)throw client.failure;
      if(!client?.loaded||client.closing||this.clientBackend!==this.provider)
        throw Error('Selected local voice backend did not become ready');
      let receipt;
      const phonePreparing=this.provider==='pocket'&&this.playbackEnabled!==false&&this.phoneAnalysis
        ?this.phoneAnalysis.prepare(options).catch(error=>{throwIfCancelled(options.signal);return{ready:false};}):null;
      phonePreparing?.catch(()=>{});
      try { receipt = await client.prepareProfile(profile, options); }
      catch (error) {
        throwIfCancelled(options.signal);
        if (!this.closed && this.provider === 'convai') return remote('selected');
        throw error;
      }
      throwIfCancelled(options.signal);
      if(phonePreparing)await phonePreparing;
      throwIfCancelled(options.signal);
      await this.routingSettled(options);
      if (this.closed) throw Error('Voice service is closed');
      if (this.provider === 'convai') return remote('selected');
      if (this.client !== client) continue;
      if (!this.hasProfile(profile)) return remote('unavailable');
      return {...receipt,provider:this.provider};
    }
  }
  close() {
    if (this.closed) return this.closing||this.retiring;
    this.closed = true; this.preview = null;
    for (const waiter of this.routingWaiters) waiter.reject(Error('Voice service is closed'));
    this.routingWaiters.clear();
    return this.closing=Promise.all([this.retire(),this.phoneAnalysis?.close()]);
  }
}
