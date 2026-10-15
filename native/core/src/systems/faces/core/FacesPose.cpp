// expressionPose and the feature-writing tail of applyFeature (mod/facial-playback.lua), without
// the game. Lua resolves the slot lifecycle first (see FacesCore.hpp); this function owns the pose
// block. The order of operations follows the Lua line by line so the doubles come out the same.

#include "FacesCore.hpp"

#include <algorithm>
#include <cmath>

namespace convai::faces
{
namespace
{
constexpr double kScaleStrength[3] = {.4, .67, 1};
constexpr double kSmileLiftLocal = .5; // smileLift (also used by FacesMix.cpp for the blended path)
constexpr double kSpeechMouthFactor = .85;
constexpr double kChinDuckJaw = .10;
constexpr double kCornerDuckJaw = .20;
constexpr double kBudgetFall = .07;
constexpr double kBudgetRise = .18;
constexpr double kDuckFall = .07;
constexpr double kDuckRise = .18;
constexpr double kSleepDelta = 1e-4;
// The smile shape (Lua shapeStretch, shapeUpper, shapeWide, shapeCap and shapeFields).
constexpr double kShapeStretch = 1;
constexpr double kShapeUpper = .8;
constexpr double kShapeWide = .5;
constexpr double kShapeCap = .8;
constexpr int kFieldLStretch = 12;
constexpr int kFieldRStretch = 13;
constexpr int kFieldLCornerStretch = 14;
constexpr int kFieldRCornerStretch = 15;
constexpr int kFieldLUpperRaise = 20;
constexpr int kFieldRUpperRaise = 21;

double Clamp(double aValue, double aMaximum = 1.0) noexcept
{
    return std::max(0.0, std::min(aMaximum, aValue));
}

bool Negative(int aFamily) noexcept
{
    return aFamily == FamSadness || aFamily == FamAnger || aFamily == FamFear || aFamily == FamDisgust;
}

float Sane(double aValue) noexcept
{
    const auto value = static_cast<float>(aValue);
    return std::isfinite(value) ? value : 0.0f;
}

// The feature stores float32; the Lua reads speech values back from the feature.
double SpeechAt(const FrameInput& aIn, int aField) noexcept
{
    if (!aIn.speech || static_cast<std::size_t>(aField) >= aIn.speechCount)
    {
        return 0.0;
    }
    return static_cast<double>(static_cast<float>(aIn.speech[aField]));
}

// Lua mouthBudget(feature, phase): read() is `finite(value) and clamp(value) or 0`.
double MouthBudget(const FrameInput& aIn) noexcept
{
    const auto read = [&](int aField) {
        const double value = SpeechAt(aIn, aField);
        return std::isfinite(value) ? Clamp(value) : 0.0;
    };
    const double closure = Clamp(std::max(read(kFieldTogetherUp), read(kFieldTogetherDn)) / .85);
    const double rounding = Clamp(std::max(read(kFieldLFunnel), read(kFieldRFunnel)) / .32 +
                                  std::max(read(kFieldLPurse), read(kFieldRPurse)) / .28);
    return (aIn.speaking ? kSpeechMouthFactor : 1.0) * (1 - closure) * (1 - rounding);
}

void Pair(Target& aTarget, int aLeft, int aRight, double aValue) noexcept
{
    aTarget.track[aLeft] = aValue;
    aTarget.track[aRight] = aValue;
}

// channelTracks / singleChannel: one unit-pose channel into a target.
void SingleChannel(Target& aTarget, MixKey aKey, double aValue) noexcept
{
    switch (aKey)
    {
    case MixKey::Up: Pair(aTarget, LCornerUp, RCornerUp, aValue); break;
    case MixKey::Dn: Pair(aTarget, LCornerDn, RCornerDn, aValue); break;
    case MixKey::In: Pair(aTarget, LBrowsRaiseIn, RBrowsRaiseIn, aValue); break;
    case MixKey::Out: Pair(aTarget, LBrowsRaiseOut, RBrowsRaiseOut, aValue); break;
    case MixKey::Low: Pair(aTarget, LBrowsLower, RBrowsLower, aValue); break;
    case MixKey::Sq: Pair(aTarget, LSquintLower, RSquintLower, aValue); break;
    case MixKey::Wide: Pair(aTarget, LWiden, RWiden, aValue); break;
    case MixKey::Lat: Pair(aTarget, LBrowsLateral, RBrowsLateral, aValue); break;
    case MixKey::Lid: Pair(aTarget, LSquintUpper, RSquintUpper, aValue); break;
    case MixKey::Sqi: Pair(aTarget, LSquintInner, RSquintInner, aValue); break;
    case MixKey::Snear: Pair(aTarget, LSnear, RSnear, aValue); break;
    case MixKey::Chin: aTarget.track[ChinRaise] = aValue; break;
    case MixKey::Droop:
        aTarget.droop = aValue;
        aTarget.hasDroop = true;
        break;
    case MixKey::Count: break;
    }
}
} // namespace

void ComputeFrame(SlotState& aSlot, const FrameInput& aIn, FrameOutput& aOut)
{
    SlotState& s = aSlot;
    const int tracks = aIn.extended ? kTracks : kBaseTracks;
    const double delta = aIn.delta;
    const bool blocked = aIn.blocked;
    int family = aIn.family;

    // startHeard() cleared slot.flick.
    if (aIn.flickReset)
    {
        s.flick[0] = 0;
        s.flick[1] = 0;
    }

    Target target{}; // zeroExpression()
    double weights[kMixFamilies];
    for (int i = 0; i < kMixFamilies; ++i)
    {
        weights[i] = aIn.weights[i];
    }
    double strength = kScaleStrength[(aIn.scale == 0 ? 1 : aIn.scale) - 1];

    // Surprise and Interest are momentary: a brow flick at the start of the feeling.
    const auto flick = [&](int aIndex, double aWeight) {
        double age = s.flick[aIndex];
        if (aWeight > .1)
        {
            age = age + delta;
        }
        else
        {
            age = 0;
        }
        s.flick[aIndex] = age;
        return std::max(0.0, std::min(1.0, 1 - (age - 1.0) / 1.0));
    };
    if (aIn.hasWeights)
    {
        const double surpriseFlick = flick(0, weights[6]);
        const double interestFlick = flick(1, weights[7]);
        weights[6] = weights[6] * surpriseFlick;
        weights[7] = weights[7] * interestFlick;
    }
    else
    {
        const double surpriseFlick = flick(0, family == FamSurprise ? strength : 0);
        const double interestFlick = flick(1, family == FamAnticipation ? strength : 0);
        if (family == FamSurprise)
        {
            strength = strength * surpriseFlick;
        }
        else if (family == FamAnticipation)
        {
            strength = strength * interestFlick;
        }
    }

    const double warmth = aIn.warmth;
    const double gain = aIn.gain;
    const double capScale = std::min(std::max(gain, 1.0), 1.3);
    const auto limitFor = [&](int aTrack) {
        double limit = ExpressionLimit(aTrack);
        if (IsCornerTrack(aTrack))
        {
            limit = limit * capScale;
        }
        return limit;
    };

    // The target pose of this frame.
    if (aIn.hasWeights)
    {
        MixTargets(weights, target, aIn.speaking, warmth, aIn.smile, aIn.squint);
    }
    else if (family == FamJoy)
    {
        Pair(target, LCornerUp, RCornerUp, .45 * strength * (1 + kSmileLiftLocal * (1 - strength)) * aIn.smile);
        Pair(target, LBrowsRaiseOut, RBrowsRaiseOut, .30 * strength);
        target.smileRaw = .45 * strength * (1 + kSmileLiftLocal * (1 - strength)) * aIn.squint;
        target.hasSmileRaw = true;
    }
    else if (family == FamTrust)
    {
        Pair(target, LCornerUp, RCornerUp, .35 * strength * aIn.smile);
        target.smileRaw = .35 * strength * aIn.squint;
        target.hasSmileRaw = true;
    }
    else if (family >= FamSadness && family <= FamAnticipation)
    {
        // One reply-level label: the family's unit pose at the label's strength.
        for (int key = 0; key < static_cast<int>(MixKey::Count); ++key)
        {
            const double unit = FamilyPose(family, static_cast<MixKey>(key));
            if (unit >= 0)
            {
                SingleChannel(target, static_cast<MixKey>(key), unit * strength);
            }
        }
    }

    bool frowning = false;
    if (aIn.hasProvider)
    {
        const double* p = aIn.provider;
        const double lowerL = .55 * p[4];
        const double lowerR = .55 * p[5];
        const double inL = .45 * p[6];
        const double inR = .45 * p[6];
        const double outL = .40 * p[7];
        const double outR = .40 * p[8];
        double cornerUpL = 0;
        double cornerUpR = 0;
        double cornerDnL = 0;
        double cornerDnR = 0;
        const bool smiling = family == FamJoy || family == FamTrust;
        if (smiling)
        {
            cornerUpL = .30 * p[0];
            cornerUpR = .30 * p[1];
        }
        else
        {
            cornerDnL = .30 * p[2];
            cornerDnR = .30 * p[3];
        }
        target.track[LBrowsLower] = std::max(target.track[LBrowsLower], lowerL);
        target.track[RBrowsLower] = std::max(target.track[RBrowsLower], lowerR);
        target.track[LBrowsRaiseIn] = std::max(target.track[LBrowsRaiseIn], inL);
        target.track[RBrowsRaiseIn] = std::max(target.track[RBrowsRaiseIn], inR);
        target.track[LBrowsRaiseOut] = std::max(target.track[LBrowsRaiseOut], outL);
        target.track[RBrowsRaiseOut] = std::max(target.track[RBrowsRaiseOut], outR);
        if (smiling)
        {
            target.track[LCornerUp] = std::max(target.track[LCornerUp], cornerUpL);
            target.track[RCornerUp] = std::max(target.track[RCornerUp], cornerUpR);
        }
        else
        {
            target.track[LCornerDn] = std::max(target.track[LCornerDn], cornerDnL);
            target.track[RCornerDn] = std::max(target.track[RCornerDn], cornerDnR);
        }
        if (cornerDnL > .005 || cornerDnR > .005 || lowerL > .01 || lowerR > .01)
        {
            Pair(target, LCornerUp, RCornerUp, 0);
            frowning = true;
        }
    }

    // After speech the emotion's brows release within about 1.5 s.
    if (aIn.browExpired)
    {
        Pair(target, LBrowsRaiseIn, RBrowsRaiseIn, 0);
        Pair(target, LBrowsRaiseOut, RBrowsRaiseOut, 0);
        Pair(target, LBrowsLower, RBrowsLower, 0);
        Pair(target, LBrowsLateral, RBrowsLateral, 0);
        Pair(target, LWiden, RWiden, 0);
        Pair(target, LSquintUpper, RSquintUpper, 0);
        target.droop = 0;
        target.hasDroop = true;
    }
    const bool suppress = !aIn.hasWeights && (Negative(family) || family == FamUnknown);
    if (suppress)
    {
        Pair(target, LCornerUp, RCornerUp, 0);
    }
    if (!aIn.hasWeights && (family == FamJoy || family == FamTrust))
    {
        Pair(target, LCornerDn, RCornerDn, 0);
        Pair(target, LBrowsLower, RBrowsLower, 0);
    }
    // Resting warmth: a floor under every non-negative intent while idle only.
    if (!aIn.hasWeights && !aIn.speaking && !Negative(family) && family != FamUnknown && !frowning &&
        target.track[LCornerDn] == 0)
    {
        Pair(target, LCornerUp, RCornerUp, std::max(target.track[LCornerUp], warmth));
    }
    target.track[LCornerUp] = target.track[LCornerUp] * gain;
    target.track[RCornerUp] = target.track[RCornerUp] * gain;
    target.track[LCornerDn] = target.track[LCornerDn] * gain;
    target.track[RCornerDn] = target.track[RCornerDn] * gain;
    const double browDown = aIn.browDown;
    if (browDown != 1)
    {
        for (int track : {LBrowsLower, RBrowsLower, LBrowsLateral, RBrowsLateral, LSquintUpper, RSquintUpper})
        {
            target.track[track] = target.track[track] * browDown;
        }
    }
    // The smile's own squint (Duchenne), or the feeling's narrowed eyes, whichever is stronger.
    double squintSmile = target.track[LCornerUp];
    if ((target.hasSmileRaw ? target.smileRaw : 0.0) > 0 && target.track[LCornerUp] > 0)
    {
        squintSmile = target.smileRaw * gain;
    }
    const double squint = std::min(.5, std::max(target.track[LSquintLower], .6 * squintSmile));
    Pair(target, LSquintLower, RSquintLower, squint);

    // The mouth budget follows the speech closure and rounding (read back from the feature, float32).
    const double goalBudget = MouthBudget(aIn);
    const double budget = s.hasMouthBudget ? Ease(s.mouthBudget, goalBudget, kBudgetFall, kBudgetRise, delta) : goalBudget;
    s.mouthBudget = budget;
    s.hasMouthBudget = true;

    for (int track = 0; track < tracks; ++track)
    {
        if (!(aIn.hasWeights && IsCornerTrack(track)))
        {
            double goal = Clamp(target.track[track], limitFor(track));
            if (IsLipsTrack(track))
            {
                goal = goal * budget;
            }
            const double prior = s.pose[track];
            const double seconds = goal > prior ? .18 : .55;
            s.pose[track] = blocked ? 0.0 : (prior + (goal - prior) * (1 - std::exp(-delta / seconds)));
        }
    }
    // The held lid droop (sadness, anger) eases like the brows; the blink merges it below.
    const double droopGoal = blocked ? 0.0 : Clamp(target.hasDroop ? target.droop : 0.0, .45);
    const double droopPrior = s.droop;
    s.droop = droopPrior + (droopGoal - droopPrior) * (1 - std::exp(-delta / (droopGoal > droopPrior ? .25 : .55)));
    if (aIn.hasWeights)
    {
        // Corners cross-fade on one signed axis (up positive, down negative).
        const double cornerCap = .80 * capScale;
        const double goalNet = (Clamp(target.track[LCornerUp], cornerCap) - Clamp(target.track[LCornerDn], cornerCap)) * budget;
        const double priorNet = s.pose[LCornerUp] - s.pose[LCornerDn];
        const double seconds = std::fabs(goalNet) >= std::fabs(priorNet) ? .18 : .55;
        const double net = blocked ? 0.0 : (priorNet + (goalNet - priorNet) * (1 - std::exp(-delta / seconds)));
        s.pose[LCornerUp] = std::max(0.0, net);
        s.pose[RCornerUp] = std::max(0.0, net);
        s.pose[LCornerDn] = std::max(0.0, -net);
        s.pose[RCornerDn] = std::max(0.0, -net);
    }
    else
    {
        if (suppress || target.track[LCornerDn] > 0 || target.track[RCornerDn] > 0)
        {
            s.pose[LCornerUp] = 0;
            s.pose[RCornerUp] = 0;
        }
        if (target.track[LCornerUp] > 0 || target.track[RCornerUp] > 0)
        {
            s.pose[LCornerDn] = 0;
            s.pose[RCornerDn] = 0;
            s.pose[LBrowsLower] = 0;
            s.pose[RBrowsLower] = 0;
        }
    }

    // While a jaw-lifted head speaks, the chin raise and the corner depressors give way as the jaw opens.
    double chinDuck = 1;
    double cornerDuck = 1;
    if (aIn.speaking && aIn.jawLift)
    {
        const double raw = SpeechAt(aIn, kFieldJaw);
        const double jaw = std::isfinite(raw) ? raw : 0.0;
        chinDuck = 1 - Clamp(jaw / kChinDuckJaw);
        cornerDuck = 1 - Clamp(jaw / kCornerDuckJaw);
    }
    if (s.hasDuck)
    {
        chinDuck = Ease(s.chinDuck, chinDuck, kDuckFall, kDuckRise, delta);
        cornerDuck = Ease(s.cornerDuck, cornerDuck, kDuckFall, kDuckRise, delta);
    }
    s.chinDuck = chinDuck;
    s.cornerDuck = cornerDuck;
    s.hasDuck = true;

    for (int track = 0; track < tracks; ++track)
    {
        // Hard closure/rounding suppression happens after smoothing, too.
        double value = std::min(s.pose[track], limitFor(track) * (IsLipsTrack(track) ? budget : 1.0));
        if (track == ChinRaise)
        {
            value = value * chinDuck;
        }
        else if (track == LCornerDn || track == RCornerDn)
        {
            value = value * cornerDuck;
        }
        s.written[track] = value;
    }

    // Voice-synchronous brows from the game-trained model: rare emphasis, combined by max.
    if (aIn.hasUpper && !blocked)
    {
        double raise = std::min(.22, .7 * std::max(0.0, aIn.upperRaise - .25)) *
                       ((family == FamAnger || family == FamDisgust) ? .4 : 1.0);
        if (raise > .02)
        {
            if (!s.voiceBrowOn)
            {
                if (s.hasVoiceBrowReady && aIn.clock < s.voiceBrowReady)
                {
                    raise = 0;
                }
                else
                {
                    s.voiceBrowOn = true;
                    s.voiceBrowReady = aIn.clock + 2.5;
                    s.hasVoiceBrowReady = true;
                }
            }
        }
        else
        {
            s.voiceBrowOn = false;
        }
        const double lower = 0 * aIn.upperLower;
        const int raiseTracks[4] = {LBrowsRaiseIn, LBrowsRaiseOut, RBrowsRaiseIn, RBrowsRaiseOut};
        for (int track : raiseTracks)
        {
            s.written[track] = std::min(ExpressionLimit(track), std::max(s.written[track], raise));
        }
        for (int track : {LBrowsLower, RBrowsLower})
        {
            s.written[track] = std::min(ExpressionLimit(track), std::max(s.written[track], lower));
        }
    }

    // ---- applyFeature, after expressionPose ----
    const double blink = std::max(aIn.blinkBase, blocked ? 0.0 : s.droop);
    s.lastBlink = blink;
    if (blink > 0 || s.blinkWritten)
    {
        aOut.write[kFieldLBlink] = true;
        aOut.write[kFieldRBlink] = true;
        aOut.value[kFieldLBlink] = Sane(blink);
        aOut.value[kFieldRBlink] = Sane(blink);
        s.blinkWritten = true;
    }
    // A blink closes widened eyes too (they would hold the lids apart).
    if (blink > 0 && s.written[LWiden] > 0)
    {
        const double open = 1 - blink;
        s.written[LWiden] = s.written[LWiden] * open;
        s.written[RWiden] = s.written[RWiden] * open;
    }
    if (aIn.writeOwner)
    {
        aOut.write[kFieldOwner] = true;
        aOut.value[kFieldOwner] = Sane(aIn.owned);
    }
    for (int track = 0; track < tracks; ++track)
    {
        const auto field = static_cast<std::size_t>(kTrackField[static_cast<std::size_t>(track)]);
        aOut.write[field] = true;
        aOut.value[field] = Sane(s.written[track]);
    }
    if (aIn.speaking && aIn.speech)
    {
        for (int field = 0; field < kFieldCount; ++field)
        {
            if (IsSpeechField(field))
            {
                aOut.write[field] = true;
                aOut.value[field] = Sane(field < static_cast<int>(aIn.speechCount) ? aIn.speech[field] : 0.0);
            }
        }
    }
    // The smile shape: corner stretch, upper-lip raise and lip stretch derived from the corners up just written. While speaking the
    // speech value (already in aOut) wins where it is larger; idle frames write the shape alone, and once more at 0
    // after the shape goes away. The speech vector itself is never changed.
    const double shape = blocked ? 0.0 : aIn.smileShape;
    if (shape > 0 || s.shapeWritten)
    {
        const struct
        {
            int field;
            int track;
            double gain;
        } shapes[6] = {{kFieldLCornerStretch, LCornerUp, kShapeStretch},
                       {kFieldRCornerStretch, RCornerUp, kShapeStretch},
                       {kFieldLUpperRaise, LCornerUp, kShapeUpper},
                       {kFieldRUpperRaise, RCornerUp, kShapeUpper},
                       {kFieldLStretch, LCornerUp, kShapeWide},
                       {kFieldRStretch, RCornerUp, kShapeWide}};
        for (const auto& entry : shapes)
        {
            double value = std::min(kShapeCap, s.written[entry.track] * entry.gain * shape);
            if (aIn.speaking && aOut.write[entry.field])
            {
                value = std::max(static_cast<double>(aOut.value[entry.field]), value);
            }
            aOut.write[entry.field] = true;
            aOut.value[entry.field] = Sane(value);
        }
        s.shapeWritten = shape > 0;
    }
}

void CommitFrame(SlotState& aSlot, const FrameInput& aIn, FrameOutput& aOut)
{
    SlotState& s = aSlot;
    const int tracks = aIn.extended ? kTracks : kBaseTracks;

    // Settled: an idle face whose written pose moved less than sleepDelta on every control since the
    // last frame, with no blink, droop or mouth hand-over in flight.
    bool settled = !aIn.speaking && !aIn.blocked && s.lastBlink == 0 && aIn.owned == 0 && s.hasApplied &&
                   !aIn.blinkInFlight;
    for (int track = 0; track < tracks; ++track)
    {
        const double value = s.written[track];
        if (settled && std::fabs(value - s.applied[track]) >= kSleepDelta)
        {
            settled = false;
        }
        s.applied[track] = value;
    }
    s.hasApplied = true;
    aOut.settled = settled;

    if (aIn.speaking)
    {
        if (aIn.peakReset)
        {
            std::fill(std::begin(s.peak), std::end(s.peak), 0.0);
            s.jawPeak = 0;
            s.openFrames = 0;
        }
        const double jaw = SpeechAt(aIn, kFieldJaw);
        if (std::isfinite(jaw))
        {
            if (jaw > s.jawPeak)
            {
                s.jawPeak = std::floor(jaw * 1000) / 1000;
            }
            if (jaw >= .16)
            {
                s.openFrames = s.openFrames + 1;
            }
        }
        for (int track = 0; track < tracks; ++track)
        {
            const double value = static_cast<double>(aOut.value[kTrackField[static_cast<std::size_t>(track)]]);
            if (value > s.peak[track])
            {
                s.peak[track] = value;
            }
        }
    }

    aOut.innerBelow20 = s.pose[LBrowsRaiseIn] < .2;
    aOut.innerAbove35 = s.pose[LBrowsRaiseIn] > .35;
    aOut.downAbove15 = s.pose[LCornerDn] > .15;
}
} // namespace convai::faces
