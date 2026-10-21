#include "FacesGame.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>

#include <array>
#include <cstdio>
#include <string>

namespace convai::faces::game
{
namespace
{
using convai::game::Call;
using convai::game::Object;

// entEntityID: one 64-bit hash.
struct EntityId
{
    std::uint64_t hash = 0;
};

// ---- ConvaiFaceFeature layout ----------------------------------------------------------------------
// The float property of each field, found by name once per class object. A class pointer that
// changes (the scripts were reloaded) rebuilds it.
struct Layout
{
    RED4ext::CClass* type = nullptr;
    std::array<RED4ext::CProperty*, kFieldCount> property{};
};

Layout g_layout;

RED4ext::CProperty* FloatProperty(RED4ext::CClass* aType, const char* aName)
{
    RED4ext::CProperty* property = aType->GetProperty(aName);
    if (!property || !property->type || property->type->GetName() != RED4ext::CName("Float"))
    {
        return nullptr;
    }
    return property;
}

const Layout& LayoutFor(RED4ext::IScriptable* aFeature)
{
    RED4ext::CClass* type = aFeature->GetType();
    if (type != g_layout.type)
    {
        g_layout = {};
        g_layout.type = type;
        if (type)
        {
            for (int field = 0; field < kFieldCount; ++field)
            {
                g_layout.property[static_cast<std::size_t>(field)] =
                    FloatProperty(type, kFieldNames[static_cast<std::size_t>(field)]);
            }
        }
    }
    return g_layout;
}

// A static function of a class (StatusEffectSystem.ObjectHasStatusEffectWithTag), no instance; found by script name
// and parameter count.
template<typename TOut, typename... TArgs>
bool CallStatic(const char* aClass, const char* aFunction, TOut* aOut, TArgs&&... aArgs)
{
    auto* function = convai::game::StaticFunction(aClass, aFunction, static_cast<uint32_t>(sizeof...(TArgs)));
    if (!function)
    {
        return false;
    }
    RED4ext::StackArgs_t args;
    ((args.emplace_back(nullptr, &aArgs)), ...);
    return RED4ext::ExecuteFunction(static_cast<void*>(nullptr), function, aOut, args);
}
} // namespace

bool WriteFields(RED4ext::IScriptable* aFeature, const FrameOutput& aOut)
{
    if (!aFeature)
    {
        return false;
    }
    const Layout& layout = LayoutFor(aFeature);
    for (int field = 0; field < kFieldCount; ++field)
    {
        if (aOut.write[field] && !layout.property[static_cast<std::size_t>(field)])
        {
            return false;
        }
    }
    for (int field = 0; field < kFieldCount; ++field)
    {
        if (aOut.write[field])
        {
            *layout.property[static_cast<std::size_t>(field)]->GetValuePtr<float>(aFeature) = aOut.value[field];
        }
    }
    return true;
}

int ApplyFeature(const Object& aActor, const Object& aFeature)
{
    Object feature = aFeature; // the call takes the address of its arguments
    bool applied = false;
    if (!Call(aActor, "ConvaiFaceApply", &applied, feature))
    {
        return -1;
    }
    return applied ? 1 : 0;
}

int SpeakerCheck(const Object& aActor, std::uint64_t aEntityHash)
{
    EntityId id;
    if (!Call(aActor, "GetEntityID", &id))
    {
        return -1;
    }
    if (id.hash != aEntityHash)
    {
        return 0;
    }
    bool attached = false;
    if (!Call(aActor, "IsAttached", &attached))
    {
        return -1;
    }
    if (!attached)
    {
        return 0;
    }
    bool dead = false;
    if (!Call(aActor, "IsDeadNoStatPool", &dead))
    {
        return -1;
    }
    if (dead)
    {
        return 0;
    }
    bool ready = false;
    if (!Call(aActor, "ConvaiFaceReady", &ready))
    {
        return -1;
    }
    return ready ? 1 : 0;
}

int SafeCheck(const Object& aActor)
{
    if (!aActor || !aActor.instance)
    {
        return -1;
    }
    bool autonomous = false;
    if (!Call(aActor, "IsOnAutonomousAI", &autonomous))
    {
        return -1;
    }
    if (!autonomous)
    {
        return 0;
    }
    Object actor = aActor; // the calls below take the address of their arguments
    RED4ext::WeakHandle<RED4ext::IScriptable> weak(aActor);
    // The combat flag through whichever route resolved (convai::game::PuppetInCombat); unknown answers -1, and the
    // Lua check decides, as it did while the plugin could not find the function.
    bool inCombat = false;
    if (!convai::game::PuppetInCombat(actor, inCombat))
    {
        return -1;
    }
    if (inCombat)
    {
        return 0;
    }
    EntityId id;
    if (!Call(aActor, "GetEntityID", &id))
    {
        return -1;
    }
    // GameInstance.GetSceneSystem is a static function of the class GameInstance, not a global function.
    Object sceneSystem = convai::game::GameSystem("GetSceneSystem");
    if (!sceneSystem)
    {
        return -1;
    }
    Object scene;
    if (!Call(sceneSystem, "GetScriptInterface", &scene) || !scene)
    {
        return -1;
    }
    bool inDialogue = false;
    if (!Call(scene, "IsEntityInDialogue", &inDialogue, id))
    {
        return -1;
    }
    if (inDialogue)
    {
        return 0;
    }
    bool inScene = false;
    if (!Call(scene, "IsEntityInScene", &inScene, id))
    {
        return -1;
    }
    if (inScene)
    {
        return 0;
    }
    // The game's injury and incapacitation signal.
    for (const char* name : {"Injured", "Defeated", "Unconscious", "Stunned", "Ragdoll"})
    {
        RED4ext::CName tag(name);
        bool has = false;
        if (!CallStatic("StatusEffectSystem", "ObjectHasStatusEffectWithTag", &has, weak, tag))
        {
            return -1;
        }
        if (has)
        {
            return 0;
        }
    }
    return 1;
}

std::string InfoJson()
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    RED4ext::CClass* feature = rtti ? rtti->GetClass("ConvaiFaceFeature") : nullptr;
    int fields = 0;
    int base = 0;
    if (feature)
    {
        for (int field = 0; field < kFieldCount; ++field)
        {
            if (FloatProperty(feature, kFieldNames[static_cast<std::size_t>(field)]))
            {
                ++fields;
            }
        }
        for (int track = 0; track < kBaseTracks; ++track)
        {
            if (FloatProperty(feature, kFieldNames[static_cast<std::size_t>(kTrackField[static_cast<std::size_t>(track)])]))
            {
                ++base;
            }
        }
    }
    RED4ext::CClass* puppet = rtti ? rtti->GetClass("NPCPuppet") : nullptr;
    const auto has = [&](RED4ext::CClass* aClass, const char* aName) {
        return aClass && aClass->GetFunction(aName) != nullptr;
    };
    RED4ext::CClass* status = rtti ? rtti->GetClass("StatusEffectSystem") : nullptr;
    const bool sceneGlobal = convai::game::GameSystem("GetSceneSystem") ? true : false;
    char text[640];
    std::snprintf(text, sizeof(text),
                  "{\"featureClass\":%s,\"fields\":%d,\"baseTrackFields\":%d,\"apply\":%s,\"ready\":%s,"
                  "\"attached\":%s,\"dead\":%s,\"autonomous\":%s,\"combat\":%s,\"entityId\":%s,\"sceneSystem\":%s,"
                  "\"statusEffects\":%s}",
                  feature ? "true" : "false", fields, base, has(puppet, "ConvaiFaceApply") ? "true" : "false",
                  has(puppet, "ConvaiFaceReady") ? "true" : "false", has(puppet, "IsAttached") ? "true" : "false",
                  has(puppet, "IsDeadNoStatPool") ? "true" : "false", has(puppet, "IsOnAutonomousAI") ? "true" : "false",
                  convai::game::CombatAvailable() ? "true" : "false", has(puppet, "GetEntityID") ? "true" : "false",
                  sceneGlobal ? "true" : "false", has(status, "ObjectHasStatusEffectWithTag") ? "true" : "false");
    return text;
}
} // namespace convai::faces::game
