import Audioware.*

// Keep the native event alive for the lifetime of this mod-owned utterance.
// Lua uses methods rather than relying on reflection of added fields.
@addField(PlayerPuppet)
private let m_convaiSpeech: ref<DynamicEmitterEvent>;

@addField(PlayerPuppet)
private let m_convaiSpeechActor: wref<GameObject>;

@addMethod(PlayerPuppet)
public final func ConvaiSpeechStart(actor: ref<GameObject>, eventName: CName) -> Bool {
  this.ConvaiSpeechStop();
  if !IsDefined(actor) || !actor.IsAttached() { return false; }
  let settings = new EmitterSettings();
  settings.distances = new EmitterDistances();
  settings.distances.min = 2.00;
  settings.distances.max = 18.00;
  settings.persistUntilSoundsFinish = false;
  let audio = GameInstance.GetAudioSystemExt(this.GetGame());
  if !audio.RegisterEmitter(actor.GetEntityID(), n"CyberpunkConvaiSpeech", n"", settings) { return false; }
  let ext = new AudioSettingsExt();
  ext.affectedByTimeDilation = false;
  this.m_convaiSpeech = DynamicEmitterEvent.Create(eventName, n"CyberpunkConvaiSpeech", ext);
  this.m_convaiSpeechActor = actor;
  actor.QueueEvent(this.m_convaiSpeech);
  return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechPosition() -> Float {
  if !IsDefined(this.m_convaiSpeech) { return -1.00; }
  return this.m_convaiSpeech.Position();
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechPause(paused: Bool) -> Void {
  if !IsDefined(this.m_convaiSpeech) { return; }
  if paused { this.m_convaiSpeech.Pause(); } else { this.m_convaiSpeech.Resume(); }
}

@addMethod(PlayerPuppet)
public final func ConvaiSpeechStop() -> Void {
  if IsDefined(this.m_convaiSpeech) { this.m_convaiSpeech.Stop(); }
  if IsDefined(this.m_convaiSpeechActor) {
    GameInstance.GetAudioSystemExt(this.GetGame()).UnregisterEmitter(this.m_convaiSpeechActor.GetEntityID(), n"CyberpunkConvaiSpeech");
  }
  this.m_convaiSpeech = null;
  this.m_convaiSpeechActor = null;
}
