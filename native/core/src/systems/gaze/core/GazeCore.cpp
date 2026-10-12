#include "GazeCore.hpp"

namespace convai::gaze
{
LookPlan Plan(bool aFull, double aHeight, double aStrength, bool aSeated)
{
    LookPlan plan;
    plan.hasWorldOffset = aHeight != 0.0;
    plan.worldOffsetZ = aHeight;
    plan.softLimitDegrees = aFull ? 70.0 : 45.0;
    plan.hardLimitDegrees = aFull ? 120.0 : 100.0;
    plan.backLimitDegrees = 120.0;
    plan.hardLimitDistance = 5.0;

    plan.parts[0] = {"Head", (aFull ? 0.18 : 0.05) * aStrength, 1.0, 0};
    plan.partCount = 1;
    // Native 2.31 ActivateReactionLookAt(inVehicle=true) omits Chest, and a part's zero stiffness
    // still admits it into the solver, so a seated request has no chest part at all.
    if (!aSeated)
    {
        plan.parts[1] = {"Chest", 0.0, 0.0, 0};
        plan.partCount = 2;
    }
    return plan;
}
} // namespace convai::gaze
