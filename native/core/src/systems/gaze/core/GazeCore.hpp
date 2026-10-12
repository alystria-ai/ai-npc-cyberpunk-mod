#pragma once

// Gaze: the numbers of one look-at request, as mod/companion-actuator.lua look() computes them.
// Pure logic, no game types. GazeGame.cpp writes the plan into a LookAtAddEvent.
//
// The Lua decides WHEN a request changes (style, eye-contact height, head-follow strength or the
// seated flag differ from the owned request) and keeps the exact event handle for release and
// retry. Only the construction of the event, about 40 CET calls, moves native.
//
//   style         "full" (soft 70 / hard 120 degrees, head weight 0.18) or any other non-"none"
//                 style such as "side" (soft 45 / hard 100, head weight 0.05)
//   height        eye-contact height in metres, already bounded and mood-adjusted by Lua; 0 means
//                 no world offset is written (the provider's default stays)
//   strength      head-follow strength, already bounded by Lua; scales the head weight
//   seated        true leaves the chest part out (the passenger animation's hand-on-knee constraints)

namespace convai::gaze
{
struct PartPlan
{
    const char* name = "";
    double weight = 0.0;
    double suppress = 0.0;
    int mode = 0;
};

struct LookPlan
{
    const char* targetSlot = "pla_default_tgt"; // SetEntityTarget slot on V
    const char* bodyPart = "Eyes";
    const char* styleName = "Normal"; // animLookAtStyle
    double softLimitDegrees = 0.0;
    double hardLimitDegrees = 0.0;
    double backLimitDegrees = 0.0;
    double hardLimitDistance = 0.0;
    bool hasWorldOffset = false; // height ~= 0 (true for NaN, as in Lua)
    double worldOffsetZ = 0.0;
    int partCount = 0;
    PartPlan parts[2];
};

// The request for a style other than "none". Same arithmetic order as the Lua: the head weight is
// (full and 0.18 or 0.05) * strength in doubles.
LookPlan Plan(bool aFull, double aHeight, double aStrength, bool aSeated);
} // namespace convai::gaze
