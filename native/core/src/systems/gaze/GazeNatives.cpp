// ConvaiNativeGaze: builds a look-at request in one native call.
//
//   ConvaiNativeGaze.Fill(event, player, style, height, strength, seated) -> Int32
//       0 built, 1 declined for this input (Lua builds it itself), 2 unavailable (Lua keeps its
//       own path for the session; Problem() says why).
//   ConvaiNativeGaze.Problem() -> String
//
// event is a LookAtAddEvent that Lua just created with LookAtAddEvent.new(); player is V.
// The caller (mod/companion-actuator.lua) decides when a request changes and owns the event.

#include "GazeGame.hpp"

#include "plugin/Rtti.hpp"
#include "plugin/Systems.hpp"

#include "core/Log.hpp"

namespace
{
using namespace convai;

constexpr const char* kSystem = "gaze";
constinit rtti::StaticClass g_class("ConvaiNativeGaze", "gaze");

std::string ToString(const RED4ext::CString& aText)
{
    return std::string(aText.c_str(), aText.Length());
}

void Fill(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, int32_t* aOut, int64_t)
{
    game::Object event;
    game::Object player;
    RED4ext::CString style;
    double height = 0.0;
    double strength = 0.0;
    bool seated = false;
    rtti::ReadArgs(aFrame, &event, &player, &style, &height, &strength, &seated);
    rtti::Return(aOut, rtti::Guard(
                           kSystem,
                           [&] {
                               // Any style other than "none" builds a request; "full" is the wide one.
                               const gaze::LookPlan plan = gaze::Plan(ToString(style) == "full", height, strength, seated);
                               return static_cast<int32_t>(gaze::Fill(event, player, plan));
                           },
                           static_cast<int32_t>(gaze::FillResult::Unavailable)));
}

void Problem(RED4ext::IScriptable*, RED4ext::CStackFrame* aFrame, RED4ext::CString* aOut, int64_t)
{
    rtti::ReadNoArgs(aFrame);
    rtti::Return(aOut, rtti::Guard(kSystem, [] { return gaze::Problem(); }, std::string("fault")));
}

void RegisterTypes()
{
    g_class.RegisterType();
}

void PostRegisterTypes()
{
    g_class.Static("Fill", &Fill, "Int32",
                   {{"handle:IScriptable", "event"},
                    {"handle:IScriptable", "player"},
                    {"String", "style"},
                    {"Double", "height"},
                    {"Double", "strength"},
                    {"Bool", "seated"}});
    g_class.Static("Problem", &Problem, "String", {});
}
} // namespace

CONVAI_SYSTEM(gaze, {.name = "gaze", .registerTypes = &RegisterTypes, .postRegisterTypes = &PostRegisterTypes});
