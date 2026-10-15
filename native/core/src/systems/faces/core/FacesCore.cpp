#include "FacesCore.hpp"

#include <algorithm>

namespace convai::faces
{
// ConvaiFaceFeature, in declaration order (r6/scripts/CyberpunkConvai/FaceFeature.reds).
const std::array<const char*, kFieldCount> kFieldNames = {
    "jaw_mid_open",
    "jaw_mid_shift_fwd",
    "jaw_mid_shift_l",
    "jaw_mid_shift_r",
    "lips_apart_up",
    "lips_apart_dn",
    "lips_together_up",
    "lips_together_dn",
    "lips_l_funnel",
    "lips_r_funnel",
    "lips_l_purse",
    "lips_r_purse",
    "lips_l_stretch",
    "lips_r_stretch",
    "lips_l_corner_stretch",
    "lips_r_corner_stretch",
    "lips_l_corner_up",
    "lips_r_corner_up",
    "lips_l_corner_dn",
    "lips_r_corner_dn",
    "lips_l_upper_raise",
    "lips_r_upper_raise",
    "lips_l_lower_raise",
    "lips_r_lower_raise",
    "lips_tighten_up",
    "lips_tighten_dn",
    "lips_puff_up",
    "lips_puff_dn",
    "lips_suck_up",
    "lips_suck_dn",
    "lips_mid_shift_l",
    "lips_mid_shift_r",
    "cheek_l_puff",
    "cheek_r_puff",
    "cheek_l_suck",
    "cheek_r_suck",
    "eye_l_blink",
    "eye_r_blink",
    "eye_l_widen",
    "eye_r_widen",
    "eye_l_brows_raise_in",
    "eye_r_brows_raise_in",
    "eye_l_brows_raise_out",
    "eye_r_brows_raise_out",
    "eye_l_brows_lower",
    "eye_r_brows_lower",
    "eye_l_oculi_squint_outer_lower",
    "eye_r_oculi_squint_outer_lower",
    "tongue_mid_fwd",
    "tongue_mid_tip_up",
    "eye_l_brows_lateral",
    "eye_r_brows_lateral",
    "eye_l_oculi_squint_outer_upper",
    "eye_r_oculi_squint_outer_upper",
    "eye_l_oculi_squint_inner",
    "eye_r_oculi_squint_inner",
    "nose_l_snear",
    "nose_r_snear",
    "lips_chin_raise",
    "speech_owner",
};

// Feature field index of each expression track, in Lua's expressionTracks order (then extended).
const std::array<int, kTracks> kTrackField = {
    16, // lips_l_corner_up
    17, // lips_r_corner_up
    18, // lips_l_corner_dn
    19, // lips_r_corner_dn
    40, // eye_l_brows_raise_in
    41, // eye_r_brows_raise_in
    42, // eye_l_brows_raise_out
    43, // eye_r_brows_raise_out
    44, // eye_l_brows_lower
    45, // eye_r_brows_lower
    46, // eye_l_oculi_squint_outer_lower
    47, // eye_r_oculi_squint_outer_lower
    38, // eye_l_widen
    39, // eye_r_widen
    50, // eye_l_brows_lateral
    51, // eye_r_brows_lateral
    52, // eye_l_oculi_squint_outer_upper
    53, // eye_r_oculi_squint_outer_upper
    54, // eye_l_oculi_squint_inner
    55, // eye_r_oculi_squint_inner
    56, // nose_l_snear
    57, // nose_r_snear
    58, // lips_chin_raise
};

int FieldIndex(std::string_view aName) noexcept
{
    for (int index = 0; index < kFieldCount; ++index)
    {
        if (aName == kFieldNames[static_cast<std::size_t>(index)])
        {
            return index;
        }
    }
    return -1;
}

bool IsSpeechField(int aField) noexcept
{
    static const std::array<bool, kFieldCount> table = [] {
        std::array<bool, kFieldCount> out{};
        out.fill(true);
        out[kFieldLBlink] = false;
        out[kFieldRBlink] = false;
        out[kFieldOwner] = false;
        for (int field : kTrackField)
        {
            out[static_cast<std::size_t>(field)] = false;
        }
        return out;
    }();
    return aField >= 0 && aField < kFieldCount && table[static_cast<std::size_t>(aField)];
}

bool IsLipsTrack(int aTrack) noexcept
{
    // lips_l_corner_up .. lips_r_corner_dn (0-3) and lips_chin_raise.
    return (aTrack >= LCornerUp && aTrack <= RCornerDn) || aTrack == ChinRaise;
}

bool IsCornerTrack(int aTrack) noexcept
{
    return aTrack >= LCornerUp && aTrack <= RCornerDn;
}

bool DecodeControl(const double* aControl, std::size_t aControlCount, const double* aSpeech, std::size_t aSpeechCount,
                   FrameInput& aOut) noexcept
{
    if (!aControl || aControlCount < static_cast<std::size_t>(ctl::kCount))
    {
        return false;
    }
    for (int index = 0; index < ctl::kCount; ++index)
    {
        if (!std::isfinite(aControl[index]))
        {
            return false;
        }
    }
    aOut.clock = aControl[ctl::kClock];
    aOut.delta = aControl[ctl::kDelta];
    const auto bits = static_cast<unsigned>(static_cast<long long>(aControl[ctl::kFlags]));
    aOut.speaking = (bits & flag::kSpeaking) != 0;
    aOut.blocked = (bits & flag::kBlocked) != 0;
    aOut.hasWeights = (bits & flag::kHasWeights) != 0;
    aOut.hasProvider = (bits & flag::kHasProvider) != 0;
    aOut.hasUpper = (bits & flag::kHasUpper) != 0;
    aOut.browExpired = (bits & flag::kBrowExpired) != 0;
    aOut.flickReset = (bits & flag::kFlickReset) != 0;
    aOut.jawLift = (bits & flag::kJawLift) != 0;
    aOut.extended = (bits & flag::kExtended) != 0;
    aOut.peakReset = (bits & flag::kPeakReset) != 0;
    aOut.writeOwner = (bits & flag::kWriteOwner) != 0;
    aOut.blinkInFlight = (bits & flag::kBlinkInFlight) != 0;
    aOut.family = static_cast<int>(aControl[ctl::kFamily]);
    aOut.scale = static_cast<int>(aControl[ctl::kScale]);
    if (aOut.family < FamNone || aOut.family > FamUnknown || aOut.scale < 0 || aOut.scale > 3)
    {
        return false;
    }
    aOut.warmth = aControl[ctl::kWarmth];
    aOut.gain = aControl[ctl::kGain];
    aOut.smile = aControl[ctl::kSmile];
    aOut.squint = aControl[ctl::kSquint];
    aOut.browDown = aControl[ctl::kBrowDown];
    for (int index = 0; index < kMixFamilies; ++index)
    {
        aOut.weights[index] = aControl[ctl::kWeights + index];
    }
    for (int index = 0; index < 9; ++index)
    {
        aOut.provider[index] = aControl[ctl::kProvider + index];
    }
    aOut.upperRaise = aControl[ctl::kUpperRaise];
    aOut.upperLower = aControl[ctl::kUpperLower];
    aOut.blinkBase = aControl[ctl::kBlink];
    aOut.owned = aControl[ctl::kOwned];
    aOut.speech = aSpeech;
    aOut.speechCount = aSpeechCount;
    return true;
}

// ---- Engine -----------------------------------------------------------------------------------
SlotState& FaceEngine::Touch(int aId)
{
    auto found = m_slots.find(aId);
    if (found == m_slots.end())
    {
        if (m_slots.size() >= kMaxSlots)
        {
            // Drop the least recently used slot. Lua gives every slot a new id when it creates it,
            // so a slot that stopped being used belongs to a character Lua already forgot.
            auto oldest = m_slots.begin();
            for (auto it = m_slots.begin(); it != m_slots.end(); ++it)
            {
                if (it->second.lastUsed < oldest->second.lastUsed)
                {
                    oldest = it;
                }
            }
            m_slots.erase(oldest);
        }
        found = m_slots.emplace(aId, SlotState{}).first;
    }
    found->second.lastUsed = ++m_clock;
    return found->second;
}

void FaceEngine::Compute(int aId, const FrameInput& aIn, FrameOutput& aOut)
{
    ComputeFrame(Touch(aId), aIn, aOut);
}

void FaceEngine::Commit(int aId, const FrameInput& aIn, FrameOutput& aOut)
{
    CommitFrame(Touch(aId), aIn, aOut);
}

void FaceEngine::ZeroPose(int aId)
{
    SlotState& slot = Touch(aId);
    std::fill(std::begin(slot.pose), std::end(slot.pose), 0.0);
}

void FaceEngine::NoteReset(int aId)
{
    SlotState& slot = Touch(aId);
    std::fill(std::begin(slot.applied), std::end(slot.applied), 0.0);
    slot.hasApplied = true;
}

void FaceEngine::Release(int aId)
{
    m_slots.erase(aId);
}

void FaceEngine::Clear()
{
    m_slots.clear();
}

std::size_t FaceEngine::Size() const noexcept
{
    return m_slots.size();
}

const SlotState* FaceEngine::Find(int aId) const noexcept
{
    const auto found = m_slots.find(aId);
    return found == m_slots.end() ? nullptr : &found->second;
}
} // namespace convai::faces
