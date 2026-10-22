// ConvaiNativeFaces: the per-frame facial writer of mod/facial-playback.lua.
//
// Lua keeps the slot lifecycle and policy and hands this one call per face per frame; the call
// computes the pose block (systems/faces/core), writes the ConvaiFaceFeature object and applies
// it to the actor, which replaces about 100 CET property and method crossings. Lua side:
// mod/facial-playback.lua (the `native` shim). Kill switch: line "faces" in runtime/native-off.txt.
//
// Result codes of Frame: bit 1 applied, 2 settled, 4 pose inner brows < .2, 8 inner brows > .35,
// 16 corner-down > .15 (the codes are the sum, always positive when applied); -1 the game
// rejected the frame, -2 a fault inside the plugin (counted toward the kill switch), -3 the game
// side is unavailable (a function or field is missing); Lua then runs its own path.
//
// Every game call inside is optional: an unresolved function answers "unknown" (-1) and Lua does
// its own check, so a patch that renames something degrades to the Lua path.

#include "plugin/GameAccess.hpp"
#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "FacesGame.hpp"
#include "core/Log.hpp"
#include "systems/faces/core/FacesCore.hpp"

#include <RED4ext/Containers/DynArray.hpp>

#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
using namespace convai;

constinit rtti::StaticClass g_class("ConvaiNativeFaces", "faces");
constexpr const char* kSystem = "faces";

faces::FaceEngine g_engine;

std::string ToString(const RED4ext::CString& aText)
{
    return std::string(aText.c_str(), aText.Length());
}

// The arrays cross as array:Float: this game's RTTI has no array:Double. Everything in them survives a
// float: the control array holds flags (below 2^12, exact in a float), small counts, weights, gains,
// warmth and a delta of about 0.016; the speech vector holds feature weights, which the game stores as Float
// anyway. The clock (ctl 0) is the one value that grows: float resolution is 2 ms at 9 hours of play,
// and the core only compares it with a time 2.5 s ahead (voice brow cooldown). The core computes in
// doubles, so the arrays are widened into buffers that live for the whole session (no allocation per
// frame after the first).
using FloatArray = RED4ext::DynArray<float>;

void Widen(const FloatArray& aFrom, std::vector<double>& aTo)
{
    aTo.assign(aFrom.Data(), aFrom.Data() + aFrom.Size());
}

// "10304956ULL" (LuaJIT's tostring of a 64-bit id), or plain digits. False for anything else.
bool ParseEntity(const std::string& aText, std::uint64_t& aOut)
{
    std::size_t index = 0;
    std::uint64_t value = 0;
    while (index < aText.size() && aText[index] >= '0' && aText[index] <= '9')
    {
        const auto digit = static_cast<std::uint64_t>(aText[index] - '0');
        if (value > (UINT64_MAX - digit) / 10)
        {
            return false;
        }
        value = value * 10 + digit;
        ++index;
    }
    if (index == 0)
    {
        return false;
    }
    const std::string suffix = aText.substr(index);
    if (!suffix.empty() && suffix != "ULL" && suffix != "ull" && suffix != "LL" && suffix != "U")
    {
        return false;
    }
    aOut = value;
    return true;
}

// Frame(actor, feature, nid, ctl, speech) -> Int32
void Frame(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    convai::game::Object actor;
    convai::game::Object feature;
    int32_t nid = 0;
    FloatArray control;
    FloatArray speech;
    rtti::ReadArgs(aFrame, &actor, &feature, &nid, &control, &speech);
    static thread_local std::vector<double> controlWide;
    static thread_local std::vector<double> speechWide;
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&]() -> int32_t {
                               Widen(control, controlWide);
                               Widen(speech, speechWide);
                               // A NaN or infinity from Lua is bad input, not a plugin fault: clean it and go on.
                               const std::size_t cleaned = faces::SanitizeFinite(controlWide.data(), controlWide.size()) +
                                                           faces::SanitizeFinite(speechWide.data(), speechWide.size());
                               if (cleaned > 0)
                               {
                                   static bool warned = false;
                                   if (!warned)
                                   {
                                       warned = true;
                                       CONVAI_WARN("Faces: %zu non-finite values in a frame from Lua were replaced by 0 "
                                                   "(logged once)",
                                                   cleaned);
                                   }
                               }
                               faces::FrameInput in;
                               const bool decoded = faces::DecodeControl(controlWide.data(), controlWide.size(),
                                                                         speechWide.data(), speechWide.size(), in);
                               if (!decoded)
                               {
                                   // A short array or an unknown family: the frame is rejected (Lua runs its own path for
                                   // it), and it does not count as a fault of the plugin.
                                   return -1;
                               }
                               if (!in.speaking || speechWide.size() < static_cast<std::size_t>(faces::kFieldCount))
                               {
                                   in.speech = nullptr;
                                   in.speechCount = 0;
                               }
                               if (!actor || !feature)
                               {
                                   return -3;
                               }
                               faces::FrameOutput out;
                               g_engine.Compute(nid, in, out);
                               if (!faces::game::WriteFields(feature.instance, out))
                               {
                                   return -3;
                               }
                               const int applied = faces::game::ApplyFeature(actor, feature);
                               if (applied < 0)
                               {
                                   return -3;
                               }
                               if (applied == 0)
                               {
                                   return -1;
                               }
                               g_engine.Commit(nid, in, out);
                               int32_t code = 1;
                               if (out.settled)
                               {
                                   code += 2;
                               }
                               if (out.innerBelow20)
                               {
                                   code += 4;
                               }
                               if (out.innerAbove35)
                               {
                                   code += 8;
                               }
                               if (out.downAbove15)
                               {
                                   code += 16;
                               }
                               return code;
                           },
                           -2));
}

// Speaker(actor, entity) -> Int32: 1 yes, 0 no, -1 unknown (Lua checks itself).
void Speaker(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    convai::game::Object actor;
    RED4ext::CString entity;
    rtti::ReadArgs(aFrame, &actor, &entity);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&]() -> int32_t {
                               std::uint64_t hash = 0;
                               if (!actor || !ParseEntity(ToString(entity), hash))
                               {
                                   return -1;
                               }
                               return faces::game::SpeakerCheck(actor, hash);
                           },
                           -1));
}

// Safe(actor) -> Int32: 1 safe, 0 not, -1 unknown.
void Safe(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    convai::game::Object actor;
    rtti::ReadArgs(aFrame, &actor);
    rtti::Return(aOut, rtti::Guard(kSystem, [&]() -> int32_t { return faces::game::SafeCheck(actor); }, -1));
}

// Numbers separated by spaces, shortest exact form.
void AppendNumber(std::string& aOut, double aValue)
{
    char text[40];
    std::snprintf(text, sizeof(text), "%.17g", aValue);
    if (!aOut.empty())
    {
        aOut += ' ';
    }
    aOut += text;
}

// Turn(nid) -> String: "jawPeak openFrames peak[0..22]" of the current speech turn, "" when unknown.
void Turn(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    int32_t nid = 0;
    rtti::ReadArgs(aFrame, &nid);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               std::string text;
                               const faces::SlotState* slot = g_engine.Find(nid);
                               if (!slot)
                               {
                                   return text;
                               }
                               AppendNumber(text, slot->jawPeak);
                               AppendNumber(text, slot->openFrames);
                               for (double peak : slot->peak)
                               {
                                   AppendNumber(text, peak);
                               }
                               return text;
                           },
                           std::string()));
}

// Applied(nid) -> String: the applied pose of the slot's tracks, "" before the first frame.
void Applied(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    int32_t nid = 0;
    rtti::ReadArgs(aFrame, &nid);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               std::string text;
                               const faces::SlotState* slot = g_engine.Find(nid);
                               if (!slot || !slot->hasApplied)
                               {
                                   return text;
                               }
                               for (double value : slot->applied)
                               {
                                   AppendNumber(text, value);
                               }
                               return text;
                           },
                           std::string()));
}

void ZeroPose(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    int32_t nid = 0;
    rtti::ReadArgs(aFrame, &nid);
    rtti::Return(aOut, rtti::GuardAlways(
                           kSystem,
                           [&] {
                               g_engine.ZeroPose(nid);
                               return true;
                           },
                           false));
}

void NoteReset(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    int32_t nid = 0;
    rtti::ReadArgs(aFrame, &nid);
    rtti::Return(aOut, rtti::GuardAlways(
                           kSystem,
                           [&] {
                               g_engine.NoteReset(nid);
                               return true;
                           },
                           false));
}

void Release(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    int32_t nid = 0;
    rtti::ReadArgs(aFrame, &nid);
    rtti::Return(aOut, rtti::GuardAlways(
                           kSystem,
                           [&] {
                               g_engine.Release(nid);
                               return true;
                           },
                           false));
}

void Clear(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, bool* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::GuardAlways(
                           kSystem,
                           [&] {
                               g_engine.Clear();
                               return true;
                           },
                           false));
}

// Check(ctl, speech) -> Int32: proves the arrays cross from Lua intact (the Lua side calls it once
// before the first frame): ctl count * 1000 + speech count.
void Check(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    FloatArray control;
    FloatArray speech;
    rtti::ReadArgs(aFrame, &control, &speech);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&]() -> int32_t {
                               return static_cast<int32_t>(control.Size()) * 1000 + static_cast<int32_t>(speech.Size());
                           },
                           -2));
}

void Info(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               std::string json = faces::game::InfoJson();
                               char slots[48];
                               std::snprintf(slots, sizeof(slots), ",\"slots\":%zu}", g_engine.Size());
                               if (!json.empty() && json.back() == '}')
                               {
                                   json.pop_back();
                               }
                               return json + slots;
                           },
                           std::string("{}")));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    const char* handle = "handle:IScriptable";
    g_class.Static("Frame", &Frame, "Int32",
                   {{handle, "actor"}, {handle, "feature"}, {"Int32", "nid"}, {"array:Float", "ctl"},
                    {"array:Float", "speech"}});
    g_class.Static("Speaker", &Speaker, "Int32", {{handle, "actor"}, {"String", "entity"}});
    g_class.Static("Safe", &Safe, "Int32", {{handle, "actor"}});
    g_class.Static("Turn", &Turn, "String", {{"Int32", "nid"}});
    g_class.Static("Applied", &Applied, "String", {{"Int32", "nid"}});
    g_class.Static("ZeroPose", &ZeroPose, "Bool", {{"Int32", "nid"}});
    g_class.Static("NoteReset", &NoteReset, "Bool", {{"Int32", "nid"}});
    g_class.Static("Release", &Release, "Bool", {{"Int32", "nid"}});
    g_class.Static("Clear", &Clear, "Bool", {});
    g_class.Static("Check", &Check, "Int32", {{"array:Float", "ctl"}, {"array:Float", "speech"}});
    g_class.Static("Info", &Info, "String", {});
    // Frame and Check take array:Float (the game has no array:Double); rtti::CommitAll checks it.
}
} // namespace

CONVAI_SYSTEM(faces, {
    .name = "faces",
    .registerTypes = &RegisterTypes,
    .postRegisterTypes = &PostRegisterTypes,
});
