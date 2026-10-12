// The blended-emotion math of mod/facial-playback.lua: expressionLimit, mixChannel, mixTargets,
// the unit poses of familyPoses / cornerVote, and ease. Each function keeps the Lua's order of
// operations so the doubles come out the same.

#include "FacesCore.hpp"

#include <algorithm>
#include <cmath>

namespace convai::faces
{
namespace
{
constexpr int kKeys = static_cast<int>(MixKey::Count);
constexpr double kAbsent = -1.0;

// Rows: the eight families in mixFamilies order (joy, trust, sadness, anger, fear, disgust,
// surprise, anticipation). Columns: MixKey order (up, dn, in, out, low, sq, wide, lat, lid, sqi,
// snear, chin, droop). kAbsent is a key the Lua table does not have.
// clang-format off
constexpr double kFamilyPoses[kMixFamilies][kKeys] = {
    /* joy         */ {.45,     kAbsent, kAbsent, .30,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* trust       */ {.35,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* sadness     */ {kAbsent, .75,     .85,     kAbsent, kAbsent, kAbsent, kAbsent, .35,     kAbsent, kAbsent, kAbsent, .35,     .30},
    /* anger       */ {kAbsent, .40,     kAbsent, kAbsent, .80,     .40,     kAbsent, .70,     .80,     .60,     .35,     .35,     .25},
    /* fear        */ {kAbsent, .25,     .80,     .50,     kAbsent, kAbsent, .45,     .50,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* disgust     */ {kAbsent, .50,     kAbsent, kAbsent, .60,     .25,     kAbsent, kAbsent, kAbsent, kAbsent, .60,     .20,     kAbsent},
    /* surprise    */ {kAbsent, kAbsent, .80,     .90,     kAbsent, kAbsent, .70,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* anticipation*/ {kAbsent, kAbsent, kAbsent, .15,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
};
constexpr double kCornerVote[kMixFamilies][kKeys] = {
    /* joy         */ {.45,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* trust       */ {.35,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* sadness     */ {kAbsent, .40,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* anger       */ {kAbsent, .25,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* fear        */ {kAbsent, .15,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* disgust     */ {kAbsent, .30,     kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* surprise    */ {kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
    /* anticipation*/ {kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent, kAbsent},
};
// clang-format on

constexpr double kMixCurve = .6;
constexpr double kSmileLift = .5;

double Clamp01(double aValue) noexcept
{
    return std::max(0.0, std::min(1.0, aValue));
}
} // namespace

// Lua expressionLimit(track). The '.find' order of the Lua decides which rule a track gets:
// squint_outer_upper, squint_inner, any other squint, widen, snear, lips_chin_raise, corner_, rest.
double ExpressionLimit(int aTrack) noexcept
{
    switch (aTrack)
    {
    case LSquintUpper:
    case RSquintUpper:
        return .8;
    case LSquintInner:
    case RSquintInner:
        return .6;
    case LSquintLower:
    case RSquintLower:
        return .5;
    case LWiden:
    case RWiden:
        return .7;
    case LSnear:
    case RSnear:
        return .6;
    case ChinRaise:
        return .5;
    case LCornerUp:
    case RCornerUp:
    case LCornerDn:
    case RCornerDn:
        return .80;
    default:
        return .90;
    }
}

double FamilyPose(int aFamily, MixKey aKey) noexcept
{
    if (aFamily < FamJoy || aFamily > FamAnticipation)
    {
        return kAbsent;
    }
    return kFamilyPoses[aFamily - 1][static_cast<int>(aKey)];
}

double MixChannel(const double aWeights[kMixFamilies], MixKey aKey, bool aCornerVote) noexcept
{
    double max = 0;
    double sum = 0;
    const int key = static_cast<int>(aKey);
    for (int index = 0; index < kMixFamilies; ++index)
    {
        const double unit = (aCornerVote ? kCornerVote : kFamilyPoses)[index][key];
        if (unit != kAbsent)
        {
            const double weight = Clamp01(aWeights[index]);
            double value = unit * weight;
            if (!aCornerVote && weight > 0)
            {
                if (aKey != MixKey::Up)
                {
                    value = unit * std::pow(weight, kMixCurve);
                }
                else if (index == 0) // joy
                {
                    value = unit * weight * (1 + kSmileLift * (1 - weight));
                }
            }
            if (value > max)
            {
                max = value;
            }
            sum = sum + value;
        }
    }
    return max + .4 * (sum - max);
}

void MixTargets(const double aWeights[kMixFamilies], Target& aTarget, bool aSpeaking, double aWarmth, double aSmile,
                double aSquint) noexcept
{
    double up = MixChannel(aWeights, MixKey::Up, false);
    double dn = MixChannel(aWeights, MixKey::Dn, false);
    double rin = MixChannel(aWeights, MixKey::In, false);
    double rout = MixChannel(aWeights, MixKey::Out, false);
    double low = MixChannel(aWeights, MixKey::Low, false);
    double narrow = MixChannel(aWeights, MixKey::Sq, false);
    double wide = MixChannel(aWeights, MixKey::Wide, false);
    if (narrow > wide)
    {
        narrow = narrow - .5 * wide;
        wide = 0;
    }
    else
    {
        wide = wide - .5 * narrow;
        narrow = 0;
    }
    const double upVote = MixChannel(aWeights, MixKey::Up, true);
    const double dnVote = MixChannel(aWeights, MixKey::Dn, true);
    if (upVote > dnVote)
    {
        up = up * (1 - .5 * dnVote / upVote);
        dn = 0;
    }
    else if (dnVote > 0)
    {
        dn = dn * (1 - .5 * upVote / dnVote);
        up = 0;
    }
    else
    {
        up = 0;
        dn = 0;
    }
    const double clash = std::min(std::max(rin, rout), low);
    rin = std::max(0.0, rin - .5 * clash);
    rout = std::max(0.0, rout - .5 * clash);
    low = std::max(0.0, low - .5 * clash);
    // The character's smile multiplier scales the emotion's smile only; the squint follows the
    // unscaled smile.
    aTarget.smileRaw = up * aSquint;
    aTarget.hasSmileRaw = true;
    up = up * aSmile;
    if (!aSpeaking && dn == 0)
    {
        up = std::max(up, aWarmth);
        aTarget.smileRaw = std::max(aTarget.smileRaw, aWarmth);
    }
    aTarget.track[LCornerUp] = up;
    aTarget.track[RCornerUp] = up;
    aTarget.track[LCornerDn] = dn;
    aTarget.track[RCornerDn] = dn;
    aTarget.track[LBrowsRaiseIn] = rin;
    aTarget.track[RBrowsRaiseIn] = rin;
    aTarget.track[LBrowsRaiseOut] = rout;
    aTarget.track[RBrowsRaiseOut] = rout;
    aTarget.track[LBrowsLower] = low;
    aTarget.track[RBrowsLower] = low;
    aTarget.track[LSquintLower] = narrow;
    aTarget.track[RSquintLower] = narrow;
    aTarget.track[LWiden] = wide;
    aTarget.track[RWiden] = wide;
    const double lat = MixChannel(aWeights, MixKey::Lat, false);
    const double lid = MixChannel(aWeights, MixKey::Lid, false);
    const double inner = MixChannel(aWeights, MixKey::Sqi, false);
    aTarget.track[LBrowsLateral] = lat;
    aTarget.track[RBrowsLateral] = lat;
    aTarget.track[LSquintUpper] = lid;
    aTarget.track[RSquintUpper] = lid;
    aTarget.track[LSquintInner] = inner;
    aTarget.track[RSquintInner] = inner;
    const double snear = MixChannel(aWeights, MixKey::Snear, false);
    aTarget.track[LSnear] = snear;
    aTarget.track[RSnear] = snear;
    aTarget.track[ChinRaise] = MixChannel(aWeights, MixKey::Chin, false);
    aTarget.droop = MixChannel(aWeights, MixKey::Droop, false);
    aTarget.hasDroop = true;
}

// Exponential approach with a separate time constant for falling and rising; one exp only while
// the value is moving. The caller handles a nil prior (the Lua returns the goal).
double Ease(double aPrior, double aGoal, double aFall, double aRise, double aDelta) noexcept
{
    if (aPrior == aGoal)
    {
        return aGoal;
    }
    const double seconds = aDelta;
    if (seconds <= 0)
    {
        return aPrior;
    }
    // Within 1 % of the goal it lands on it.
    if (std::fabs(aGoal - aPrior) < .01)
    {
        return aGoal;
    }
    return aPrior + (aGoal - aPrior) * (1 - std::exp(-seconds / (aGoal < aPrior ? aFall : aRise)));
}
} // namespace convai::faces
