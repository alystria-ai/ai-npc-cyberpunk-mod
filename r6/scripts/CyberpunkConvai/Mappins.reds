module CyberpunkConvai

// Identifies the runtime's companion pins without affecting vanilla mappins.
public class ConvaiCompanionMappinData extends MappinScriptData {
    public let serial: Int32;
}

// The companion pin belongs on the minimap. Suppress its in-world HUD widget
// so a game profile without a suitable NPC texture cannot cover the actor.
@wrapMethod(WorldMappinsContainerController)
public func CreateMappinUIProfile(
    mappin: wref<IMappin>,
    mappinVariant: gamedataMappinVariant,
    customData: ref<MappinControllerCustomData>
) -> MappinUIProfile {
    if IsDefined(mappin.GetScriptData() as ConvaiCompanionMappinData) {
        return MappinUIProfile.None();
    };
    return wrappedMethod(mappin, mappinVariant, customData);
}
