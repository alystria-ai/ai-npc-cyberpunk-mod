import Audioware.*

// Keep the native event alive for the lifetime of this mod-owned utterance.
// Lua uses methods rather than relying on reflection of added fields.
@addField(PlayerPuppet)
private let m_convaiSpeech: ref<DynamicEmitterEvent>;

@addField(PlayerPuppet)
private let m_convaiSpeechActor: wref<GameObject>;

// A voice heard as V's own sound, not from a place in the world: a holocall reply, which comes through the phone.
@addField(PlayerPuppet)
private let m_convaiSpeechOnV: ref<DynamicSoundEvent>;

@addMethod(PlayerPuppet)
public final func ConvaiSpeechStart(actor: ref<GameObject>, eventName: CName) -> Bool {
  this.ConvaiSpeechStop();
  if !IsDefined(actor) || !actor.IsAttached() { return false; }
  let settings = new EmitterSettings();
  settings.distances = new EmitterDistances();
  settings.distances.min = 2.00;
  settings.distances.max = 18.00;
  settings.persistUntilSoundsFinish = false;
  settings.affectedByReverbMix = false;
  let audio = GameInstance.GetAudioSystemExt(this.GetGame());
  if !audio.RegisterEmitter(actor.GetEntityID(), n"CyberpunkConvaiSpeech", n"", settings) { return false; }
  let ext = new AudioSettingsExt();
  ext.affectedByTimeDilation = false;
  this.m_convaiSpeech = DynamicEmitterEvent.Create(eventName, n"CyberpunkConvaiSpeech", ext);
  this.m_convaiSpeechActor = actor;
  actor.QueueEvent(this.m_convaiSpeech);
  return true;
}

// A holocall reply (mod/speech.lua): Audioware plays a DynamicSoundEvent queued on V on V's own track (its Entity::QueueEvent hook
// sends a sound whose entity is the listener there), never on a spatial emitter, so no emitter position, distance range,
// occlusion or listener placement can make it quiet. The emitter version above put it on V's weapon or chest item, 2 to 18 m
// attenuation: on 2026-10-18 it advanced (the lips moved) but was not heard during a call. Position, pause and stop below
// serve either kind; one utterance owns playback at a time.
@addMethod(PlayerPuppet)
public final func ConvaiSpeechStartOnV(eventName: CName) -> Bool {
  this.ConvaiSpeechStop();
  let ext = new AudioSettingsExt();
  ext.affectedByTimeDilation = false;
  this.m_convaiSpeechOnV = DynamicSoundEvent.Create(eventName, ext);
  if !IsDefined(this.m_convaiSpeechOnV) { return false; }
  this.QueueEvent(this.m_convaiSpeechOnV);
  return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechPosition() -> Float {
  if IsDefined(this.m_convaiSpeech) { return this.m_convaiSpeech.Position(); }
  if IsDefined(this.m_convaiSpeechOnV) { return this.m_convaiSpeechOnV.Position(); }
  return -1.00;
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechPause(paused: Bool) -> Void {
  if IsDefined(this.m_convaiSpeech) {
    if paused { this.m_convaiSpeech.Pause(); } else { this.m_convaiSpeech.Resume(); }
  }
  if IsDefined(this.m_convaiSpeechOnV) {
    if paused { this.m_convaiSpeechOnV.Pause(); } else { this.m_convaiSpeechOnV.Resume(); }
  }
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechStop() -> Void {
  if IsDefined(this.m_convaiSpeech) { this.m_convaiSpeech.Stop(); }
  if IsDefined(this.m_convaiSpeechOnV) { this.m_convaiSpeechOnV.Stop(); }
  this.m_convaiSpeechOnV = null;
  if IsDefined(this.m_convaiSpeechActor) {
    GameInstance.GetAudioSystemExt(this.GetGame()).UnregisterEmitter(this.m_convaiSpeechActor.GetEntityID(), n"CyberpunkConvaiSpeech");
  }
  this.m_convaiSpeech = null;
  this.m_convaiSpeechActor = null;
}
