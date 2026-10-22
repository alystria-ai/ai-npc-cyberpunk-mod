#pragma once

// Faces core: the per-frame pose writer of mod/facial-playback.lua, without the game.
//
// What moves here (Lua line references are to mod/facial-playback.lua on main at 1709838):
//   expressionPose, mixTargets, mixChannel, ease, expressionLimit, the tail of applyFeature (widen
//   adjust, written pose, settled test, turn peaks). What stays in Lua: the slot lifecycle (emotion,
//   family, hold, expiry, mood, cues), blinkWeight and ownerLevel (cheap, no tables), the speech
//   track interpolation in sync(), and every policy decision. Lua resolves its own state first and
//   hands this core the numbers; this core owns only the *pose block* of a slot (pose, droop, flick
//   ages, mouth budget, ducks, written and applied poses, voice-brow state, turn peaks).
//
// The core has no RED4ext include. The game layer (FacesGame.cpp) writes the output values into
// the ConvaiFaceFeature object and calls ConvaiFaceApply.
//
// Numbers: state and math are doubles, in the order the Lua does them. Values leave as float32
// (the feature fields are Float), and the speech values come back in as float32 too (the Lua reads
// them back from the feature object, which stores float32).

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <unordered_map>

namespace convai::faces
{
// ---- Feature fields ---------------------------------------------------------------------------
// The fields of ConvaiFaceFeature (r6/scripts/CyberpunkConvai/FaceFeature.reds), in declaration
// order. bridge/facial-playback-native.test.mjs checks this list against the .reds file.
inline constexpr int kFieldCount = 60;
extern const std::array<const char*, kFieldCount> kFieldNames;
// Index of a field name, or -1.
int FieldIndex(std::string_view aName) noexcept;

// Named indices for the fields the pose code addresses directly.
inline constexpr int kFieldJaw = 0;        // jaw_mid_open
inline constexpr int kFieldTogetherUp = 6; // lips_together_up
inline constexpr int kFieldTogetherDn = 7;
inline constexpr int kFieldLFunnel = 8; // lips_l_funnel
inline constexpr int kFieldRFunnel = 9;
inline constexpr int kFieldLPurse = 10; // lips_l_purse
inline constexpr int kFieldRPurse = 11;
inline constexpr int kFieldLBlink = 36; // eye_l_blink
inline constexpr int kFieldRBlink = 37;
inline constexpr int kFieldOwner = 59; // speech_owner

// Fields the speech timeline can write (everything that is not an expression track, a blink or
// speech_owner): kIsSpeechField[i] is true for those 34 fields.
bool IsSpeechField(int aField) noexcept;

// ---- Expression tracks ------------------------------------------------------------------------
// Lua expressionTracks: 14 base tracks, then (once the first write proves the feature has them)
// 9 extended ones. The order below is the Lua order; no result depends on it.
inline constexpr int kBaseTracks = 14;
inline constexpr int kTracks = 23;
enum Track : int
{
    LCornerUp = 0,   // lips_l_corner_up
    RCornerUp,       // lips_r_corner_up
    LCornerDn,       // lips_l_corner_dn
    RCornerDn,       // lips_r_corner_dn
    LBrowsRaiseIn,   // eye_l_brows_raise_in
    RBrowsRaiseIn,   // eye_r_brows_raise_in
    LBrowsRaiseOut,  // eye_l_brows_raise_out
    RBrowsRaiseOut,  // eye_r_brows_raise_out
    LBrowsLower,     // eye_l_brows_lower
    RBrowsLower,     // eye_r_brows_lower
    LSquintLower,    // eye_l_oculi_squint_outer_lower
    RSquintLower,    // eye_r_oculi_squint_outer_lower
    LWiden,          // eye_l_widen
    RWiden,          // eye_r_widen
    LBrowsLateral,   // eye_l_brows_lateral       (extended from here on)
    RBrowsLateral,   // eye_r_brows_lateral
    LSquintUpper,    // eye_l_oculi_squint_outer_upper
    RSquintUpper,    // eye_r_oculi_squint_outer_upper
    LSquintInner,    // eye_l_oculi_squint_inner
    RSquintInner,    // eye_r_oculi_squint_inner
    LSnear,          // nose_l_snear
    RSnear,          // nose_r_snear
    ChinRaise,       // lips_chin_raise
};
// Feature field index of each expression track.
extern const std::array<int, kTracks> kTrackField;
// True for the tracks whose name starts with "lips_" (they are scaled by the mouth budget).
bool IsLipsTrack(int aTrack) noexcept;
// True for the four lips_*_corner_* tracks.
bool IsCornerTrack(int aTrack) noexcept;

// ---- Frame input ------------------------------------------------------------------------------
// Lua packs one reused table of doubles per call. Index in Lua = index here + 1.
namespace ctl
{
inline constexpr int kClock = 0;    // M.expressionClock
inline constexpr int kDelta = 1;    // M.expressionDelta (seconds, already clamped by Lua)
inline constexpr int kFlags = 2;    // Flag bits below, as an integer-valued double
inline constexpr int kFamily = 3;   // Family code below
inline constexpr int kScale = 4;    // slot.scale; 0 when nil (the Lua uses scale or 1)
inline constexpr int kWarmth = 5;   // trait warmth after the mood hold was applied
inline constexpr int kGain = 6;     // trait.gain
inline constexpr int kSmile = 7;    // trait.smile
inline constexpr int kSquint = 8;   // trait.squint
inline constexpr int kBrowDown = 9; // trait.browDown or 1
inline constexpr int kWeights = 10; // 8 values: the mix, or the held mix (families in mixFamilies order)
inline constexpr int kProvider = 18; // 9 values (Lua provider[1..9])
inline constexpr int kUpperRaise = 27;
inline constexpr int kUpperLower = 28;
inline constexpr int kBlink = 29; // blinkWeight(...) of this frame (before the droop is merged in)
inline constexpr int kOwned = 30; // ownerLevel(...) of this frame, 0 when the field is absent
inline constexpr int kCount = 31;
} // namespace ctl

namespace flag
{
inline constexpr unsigned kSpeaking = 1;     // phase == 'speaking'
inline constexpr unsigned kBlocked = 2;      // the frame is blocked (pose and droop go to 0)
inline constexpr unsigned kHasWeights = 4;   // weights are valid (mix or held mix)
inline constexpr unsigned kHasProvider = 8;  // provider is valid
inline constexpr unsigned kHasUpper = 16;    // upper is valid
inline constexpr unsigned kBrowExpired = 32; // slot.browExpiry and clock >= slot.browExpiry
inline constexpr unsigned kFlickReset = 64;  // startHeard ran since the last frame: flick ages restart
inline constexpr unsigned kJawLift = 128;    // M.jawLift is set (the ducks apply while speaking)
inline constexpr unsigned kExtended = 256;   // the feature has the nine extended tracks
inline constexpr unsigned kPeakReset = 512;  // a new speech turn starts: peaks and jaw tallies restart
inline constexpr unsigned kWriteOwner = 1024; // write speech_owner = owned this frame
inline constexpr unsigned kBlinkInFlight = 2048; // slot.blinkStart and clock - blinkStart < blinkLength
} // namespace flag

// slot.family: nil, one of the eight mixFamilies (in this order), 'neutral'/'none', or 'unknown'.
enum Family : int
{
    FamNone = 0,
    FamJoy = 1,
    FamTrust = 2,
    FamSadness = 3,
    FamAnger = 4,
    FamFear = 5,
    FamDisgust = 6,
    FamSurprise = 7,
    FamAnticipation = 8,
    FamNeutral = 9,
    FamUnknown = 10,
};

inline constexpr int kMixFamilies = 8;

struct FrameInput
{
    double clock = 0;
    double delta = 0;
    bool speaking = false;
    bool blocked = false;
    bool hasWeights = false;
    bool hasProvider = false;
    bool hasUpper = false;
    bool browExpired = false;
    bool flickReset = false;
    bool jawLift = false;
    bool extended = false;
    bool peakReset = false;
    bool writeOwner = false;
    bool blinkInFlight = false;
    int family = FamNone;
    int scale = 0;
    double warmth = 0;
    double gain = 1;
    double smile = 1;
    double squint = 1;
    double browDown = 1;
    double weights[kMixFamilies]{};
    double provider[9]{};
    double upperRaise = 0;
    double upperLower = 0;
    double blinkBase = 0;
    double owned = 0;
    // The speech values by feature field index (dense, kFieldCount entries) while speaking; empty
    // otherwise. Speech fields are written only on speaking frames.
    const double* speech = nullptr;
    std::size_t speechCount = 0;
};

// Decodes the packed control array. False when it is too short or holds a non-finite number where
// the Lua would have had a finite one.
bool DecodeControl(const double* aControl, std::size_t aControlCount, const double* aSpeech, std::size_t aSpeechCount,
                   FrameInput& aOut) noexcept;

// Bad numbers from Lua (a NaN or an infinity in the control or speech array, which a bad measurement upstream can
// produce) are input to clean, not a fault of the plugin: each non-finite value is replaced by 0 and the count of
// replaced values is returned, so one bad frame does not count towards switching faces off.
std::size_t SanitizeFinite(double* aValues, std::size_t aCount) noexcept;

// ---- Slot state -------------------------------------------------------------------------------
// The pose block of Lua's expression slot. Lua keeps the rest of the slot.
struct SlotState
{
    double pose[kTracks]{};    // slot.pose
    double droop = 0;          // slot.droop (nil reads as 0)
    double flick[2]{};         // slot.flick.surprise, slot.flick.anticipation (ages in seconds)
    double mouthBudget = 0;    // slot.mouthBudget ...
    bool hasMouthBudget = false; // ... nil until the first frame
    double chinDuck = 0;       // slot.chinDuck
    double cornerDuck = 0;     // slot.cornerDuck
    bool hasDuck = false;      // both nil until the first frame
    double written[kTracks]{}; // slot.writtenPose (what the last frame gave the feature, as doubles)
    double applied[kTracks]{}; // slot.appliedPose
    bool hasApplied = false;   // slot.appliedPose ~= nil
    bool voiceBrowOn = false;  // slot.voiceBrowOn
    double voiceBrowReady = 0; // slot.voiceBrowReady
    bool hasVoiceBrowReady = false;
    bool blinkWritten = false; // slot.blinkWritten
    // Speech turn tallies (Lua's lastSpeechExpression.peak, .jawPeak, .openFrames).
    double peak[kTracks]{};
    double jawPeak = 0;
    int openFrames = 0;
    // Set by ComputeFrame for CommitFrame.
    double lastBlink = 0; // the blink value written (max of the blink base and the droop)
    // Bookkeeping for the engine.
    std::uint64_t lastUsed = 0;
};

// ---- Frame output -----------------------------------------------------------------------------
struct FrameOutput
{
    // Fields to write into the feature object this frame, and the values (float32, as stored).
    bool write[kFieldCount]{};
    float value[kFieldCount]{};
    // Filled by CommitFrame (after ConvaiFaceApply returned true).
    bool settled = false;
    bool innerBelow20 = false; // slot.pose.eye_l_brows_raise_in < .2
    bool innerAbove35 = false; // ... > .35
    bool downAbove15 = false;  // slot.pose.lips_l_corner_dn > .15
};

// Lua expressionPose + the feature writes of applyFeature (everything before ConvaiFaceApply).
// Mutates the slot's pose block and fills aOut.write / aOut.value.
void ComputeFrame(SlotState& aSlot, const FrameInput& aIn, FrameOutput& aOut);

// The part of applyFeature after a successful ConvaiFaceApply: appliedPose, settled, the speech
// turn peaks. Fills aOut.settled and the gaze flags.
void CommitFrame(SlotState& aSlot, const FrameInput& aIn, FrameOutput& aOut);

// ---- Pieces of expressionPose (FacesMix.cpp) --------------------------------------------------
// Lua expressionLimit(track) for expression track aTrack (the corner cap scale is applied by the caller).
double ExpressionLimit(int aTrack) noexcept;

// The unit-pose channels of familyPoses / cornerVote.
enum class MixKey : int
{
    Up = 0,
    Dn,
    In,
    Out,
    Low,
    Sq,
    Wide,
    Lat,
    Lid,
    Sqi,
    Snear,
    Chin,
    Droop,
    Count
};

// Lua mixChannel(weights, key, poses): aCornerVote selects the cornerVote table (the Lua passes
// `cornerVote` as poses); otherwise familyPoses with the curve (mixCurve, smileLift) applied.
double MixChannel(const double aWeights[kMixFamilies], MixKey aKey, bool aCornerVote) noexcept;

// What mixTargets writes into Lua's `target`.
struct Target
{
    double track[kTracks]{};
    double smileRaw = 0;
    bool hasSmileRaw = false;
    double droop = 0;
    bool hasDroop = false;
};

// Lua mixTargets(weights, target, phase, warmth, smile, squint). aSpeaking is phase == 'speaking'.
void MixTargets(const double aWeights[kMixFamilies], Target& aTarget, bool aSpeaking, double aWarmth, double aSmile,
                double aSquint) noexcept;

// The unit pose of a single reply-level family label, for singleChannel(): the value of aKey in
// familyPoses[aFamily], or a negative number when that family has no such key.
double FamilyPose(int aFamily, MixKey aKey) noexcept;

// Lua ease(prior, goal, fall, rise) with M.expressionDelta = aDelta. The caller handles prior == nil.
double Ease(double aPrior, double aGoal, double aFall, double aRise, double aDelta) noexcept;

// ---- The engine (FacesEngine.cpp) -------------------------------------------------------------
// Slots by Lua's slot id. Game thread only. An unknown id starts from a fresh slot (what
// expressionSlot() creates). At most kMaxSlots are kept; the least recently used goes first.
inline constexpr std::size_t kMaxSlots = 64;

class FaceEngine
{
public:
    // Computes the frame for slot aId (created on first use). aOut.write / aOut.value are filled.
    void Compute(int aId, const FrameInput& aIn, FrameOutput& aOut);
    // After a successful ConvaiFaceApply for the frame just computed.
    void Commit(int aId, const FrameInput& aIn, FrameOutput& aOut);
    // endExpression: slot.pose = zeroExpression().
    void ZeroPose(int aId);
    // reset() without a hand-over: slot.appliedPose = zeroExpression().
    void NoteReset(int aId);
    void Release(int aId);
    void Clear();
    std::size_t Size() const noexcept;
    // The slot, or nullptr.
    const SlotState* Find(int aId) const noexcept;

private:
    SlotState& Touch(int aId);
    std::unordered_map<int, SlotState> m_slots;
    std::uint64_t m_clock = 0;
};
} // namespace convai::faces
