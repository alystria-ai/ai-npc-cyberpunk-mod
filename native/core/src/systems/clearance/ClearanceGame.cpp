#include "systems/clearance/ClearanceGame.hpp"

#include "plugin/GameAccess.hpp"

#include "core/Log.hpp"

#include <RED4ext/GameEngine.hpp>
#include <RED4ext/RED4ext.hpp>
#include <RED4ext/Scripting/Natives/Generated/EulerAngles.hpp>
#include <RED4ext/Scripting/Natives/Generated/physics/TraceResult.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>
#include <RED4ext/Scripting/Stack.hpp>
#include <RED4ext/Scripting/Utils.hpp>

// WIN32_LEAN_AND_MEAN and NOMINMAX come from the convai_core compile definitions.
#include <windows.h>

#include <cstdio>

namespace convai::clearance
{
namespace
{
// Game thread only, so plain counters.
QueryStats g_stats;

std::uint64_t NowMicros()
{
    static const std::uint64_t frequency = [] {
        LARGE_INTEGER value;
        QueryPerformanceFrequency(&value);
        return static_cast<std::uint64_t>(value.QuadPart > 0 ? value.QuadPart : 1);
    }();
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return static_cast<std::uint64_t>(counter.QuadPart) * 1000000ull / frequency;
}

void Note(std::uint64_t aStart)
{
    const std::uint64_t took = NowMicros() - aStart;
    g_stats.micros += took;
    if (took > g_stats.maxMicros)
    {
        g_stats.maxMicros = took;
    }
}

// The game system for a class, found by the class itself or by the interface it is registered
// under (gameISpatialQueriesSystem). A candidate only counts when it really is the wanted class.
RED4ext::IScriptable* FindSystem(const char* aClassName)
{
    RED4ext::CClass* wanted = game::Class(aClassName);
    auto* engine = RED4ext::CGameEngine::Get();
    if (!wanted || !engine || !engine->framework || !engine->framework->gameInstance)
    {
        return nullptr;
    }
    // The class itself, then the interface above it; nothing further up is a game system.
    int steps = 0;
    for (RED4ext::CClass* type = wanted; type && steps < 2; type = type->parent, ++steps)
    {
        RED4ext::IScriptable* system = engine->framework->gameInstance->GetSystem(type);
        if (!system)
        {
            continue;
        }
        RED4ext::CClass* actual = system->GetType();
        if (actual && actual->IsA(wanted))
        {
            return system;
        }
    }
    return nullptr;
}
} // namespace

QueryStats GetQueryStats()
{
    return g_stats;
}

GameProbe::GameProbe()
{
    m_system = FindSystem("SpatialQueriesSystem");
    if (!m_system)
    {
        m_error = kErrorNoSystem;
        return;
    }
    // The function lookups build strings, so keep them for the class (it lives as long as the game).
    static RED4ext::CClass* knownType = nullptr;
    static RED4ext::CBaseFunction* knownOverlap = nullptr;
    static RED4ext::CBaseFunction* knownRay = nullptr;
    RED4ext::CClass* type = m_system->GetType();
    if (type != knownType || !knownOverlap || !knownRay)
    {
        knownOverlap = game::Method(type, "Overlap");
        knownRay = game::Method(type, "SyncRaycastByCollisionGroup");
        knownType = type;
    }
    m_overlap = knownOverlap;
    m_ray = knownRay;
}

Hit GameProbe::Overlap(const Box& aBox, int aGroup)
{
    if (!m_system)
    {
        m_error = kErrorNoSystem;
        return Hit::Error;
    }
    if (!m_overlap)
    {
        m_error = kErrorNoOverlap;
        return Hit::Error;
    }
    if (aGroup < 0 || aGroup >= kGroupCount)
    {
        m_error = kErrorBadGroup;
        return Hit::Error;
    }
    RED4ext::Vector4 half(static_cast<float>(aBox.half.x), static_cast<float>(aBox.half.y),
                          static_cast<float>(aBox.half.z), 0.0f);
    RED4ext::Vector4 center(static_cast<float>(aBox.center.x), static_cast<float>(aBox.center.y),
                            static_cast<float>(aBox.center.z), 1.0f);
    RED4ext::EulerAngles rotation{static_cast<float>(aBox.roll), static_cast<float>(aBox.pitch),
                                  static_cast<float>(aBox.yaw)};
    RED4ext::CName group(kGroups[aGroup]);
    RED4ext::TraceResult trace{};
    bool hit = false;

    RED4ext::StackArgs_t args;
    args.reserve(5);
    args.emplace_back(nullptr, &half);
    args.emplace_back(nullptr, &center);
    args.emplace_back(nullptr, &rotation);
    args.emplace_back(nullptr, &group);
    args.emplace_back(nullptr, &trace);

    const std::uint64_t start = NowMicros();
    const bool called = RED4ext::ExecuteFunction(m_system, m_overlap, &hit, args);
    Note(start);
    ++g_stats.overlaps;
    if (!called)
    {
        ++g_stats.errors;
        m_error = kErrorInvoke;
        return Hit::Error;
    }
    return hit ? Hit::Blocked : Hit::Free;
}

Hit GameProbe::Ray(const Vec3& aFrom, const Vec3& aTo, const char* aGroup, double* aHitZ)
{
    if (!m_system)
    {
        m_error = kErrorNoSystem;
        return Hit::Error;
    }
    if (!m_ray)
    {
        m_error = kErrorNoRay;
        return Hit::Error;
    }
    RED4ext::Vector4 start(static_cast<float>(aFrom.x), static_cast<float>(aFrom.y), static_cast<float>(aFrom.z),
                           1.0f);
    RED4ext::Vector4 finish(static_cast<float>(aTo.x), static_cast<float>(aTo.y), static_cast<float>(aTo.z), 1.0f);
    RED4ext::CName group(aGroup);
    RED4ext::TraceResult trace{};
    bool staticOnly = false;
    bool dynamicOnly = false;
    bool hit = false;

    RED4ext::StackArgs_t args;
    args.reserve(6);
    args.emplace_back(nullptr, &start);
    args.emplace_back(nullptr, &finish);
    args.emplace_back(nullptr, &group);
    args.emplace_back(nullptr, &trace);
    args.emplace_back(nullptr, &staticOnly);
    args.emplace_back(nullptr, &dynamicOnly);

    const std::uint64_t began = NowMicros();
    const bool called = RED4ext::ExecuteFunction(m_system, m_ray, &hit, args);
    Note(began);
    ++g_stats.rays;
    if (!called)
    {
        ++g_stats.errors;
        m_error = kErrorInvoke;
        return Hit::Error;
    }
    if (hit && aHitZ)
    {
        *aHitZ = static_cast<double>(trace.position.Z);
    }
    return hit ? Hit::Blocked : Hit::Free;
}

std::string SelfTest()
{
    GameProbe probe;
    if (!probe.Ready())
    {
        // No world yet, or a lookup that does not work: the Lua side counts the waits.
        return "wait the spatial queries system was not found";
    }
    char text[160];

    // A speck in the sky touches nothing, in any group.
    Box speck;
    speck.half = {0.1, 0.1, 0.1};
    speck.center = {0.0, 0.0, 20000.0};
    for (int group = 0; group < kGroupCount; ++group)
    {
        const Hit hit = probe.Overlap(speck, group);
        if (hit == Hit::Error)
        {
            std::snprintf(text, sizeof(text), "fail the overlap call failed (code %d)", probe.ErrorCode());
            return text;
        }
        if (hit == Hit::Blocked)
        {
            std::snprintf(text, sizeof(text), "fail an empty sky box reported a hit in %s", kGroups[group]);
            return text;
        }
    }
    double ignored = 0;
    for (int group = 0; group < kGroupCount; ++group)
    {
        const Hit hit = probe.Ray({0.0, 0.0, 20000.0}, {0.0, 0.0, 20002.0}, kSightGroups[group], &ignored);
        if (hit == Hit::Error)
        {
            std::snprintf(text, sizeof(text), "fail the raycast call failed (code %d)", probe.ErrorCode());
            return text;
        }
        if (hit == Hit::Blocked)
        {
            std::snprintf(text, sizeof(text), "fail an empty sky ray reported a hit in %s", kSightGroups[group]);
            return text;
        }
    }

    game::Object player = game::Player();
    if (!player)
    {
        return "ok";
    }
    // Around V there is ground: a 30 m box and a ray down 60 m must find something. Without V (or where her
    // position cannot be read), the sky checks above are what is proven.
    RED4ext::Vector4 at{};
    if (!game::Call(player, "GetWorldPosition", &at))
    {
        return "ok";
    }
    Box wide;
    wide.half = {30.0, 30.0, 30.0};
    wide.center = {at.X, at.Y, at.Z};
    bool anyBox = false;
    for (int group = 0; group < kGroupCount && !anyBox; ++group)
    {
        const Hit hit = probe.Overlap(wide, group);
        if (hit == Hit::Error)
        {
            std::snprintf(text, sizeof(text), "fail the overlap call failed (code %d)", probe.ErrorCode());
            return text;
        }
        anyBox = hit == Hit::Blocked;
    }
    if (!anyBox)
    {
        return "fail a 30 m box around V found no geometry";
    }
    bool anyRay = false;
    for (int group = 0; group < kGroupCount && !anyRay; ++group)
    {
        const Hit hit = probe.Ray({at.X, at.Y, at.Z + 2.0}, {at.X, at.Y, at.Z - 60.0}, kSightGroups[group], &ignored);
        if (hit == Hit::Error)
        {
            std::snprintf(text, sizeof(text), "fail the raycast call failed (code %d)", probe.ErrorCode());
            return text;
        }
        anyRay = hit == Hit::Blocked;
    }
    if (!anyRay)
    {
        return "fail a ray straight down from V hit nothing";
    }
    return "ok";
}
} // namespace convai::clearance
