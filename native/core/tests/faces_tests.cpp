// Headless tests of the faces core (src/systems/faces/core): the per-frame pose writer of
// mod/facial-playback.lua. The parity fixture is recorded from the Lua path by
// bridge/facial-playback-native.test.mjs (CONVAI_WRITE_FIXTURES=1): every call the Lua shim made to
// ConvaiNativeFaces.Frame with the control array and the speech vector it sent, and the feature vector
// and status code the Lua path produced for the same frame. This replays them and compares.

#include "Fixture.hpp"
#include "Test.hpp"

#include "systems/faces/core/FacesCore.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <vector>

using namespace convai::faces;

namespace
{
std::vector<double> Numbers(yyjson_val* aArray)
{
    std::vector<double> out;
    size_t index;
    size_t count;
    yyjson_val* item;
    yyjson_arr_foreach(aArray, index, count, item)
    {
        out.push_back(yyjson_get_num(item));
    }
    return out;
}

std::string Text(yyjson_val* aValue)
{
    return aValue && yyjson_is_str(aValue) ? std::string(yyjson_get_str(aValue), yyjson_get_len(aValue)) : std::string();
}

int Int(yyjson_val* aObject, const char* aKey)
{
    yyjson_val* value = yyjson_obj_get(aObject, aKey);
    return value ? static_cast<int>(yyjson_get_num(value)) : 0;
}

// What ConvaiNativeFaces.Frame does around the core, without the game: decode, compute, write the fields
// into the feature object, "apply", commit, and build the status code.
int ReplayFrame(FaceEngine& aEngine, std::array<float, kFieldCount>& aFeature, int aNid, const std::vector<double>& aControl,
                const std::vector<double>& aSpeech)
{
    FrameInput in;
    if (!DecodeControl(aControl.data(), aControl.size(), aSpeech.data(), aSpeech.size(), in))
    {
        return -2;
    }
    if (!in.speaking || aSpeech.size() < static_cast<std::size_t>(kFieldCount))
    {
        in.speech = nullptr;
        in.speechCount = 0;
    }
    FrameOutput out;
    aEngine.Compute(aNid, in, out);
    for (int field = 0; field < kFieldCount; ++field)
    {
        if (out.write[field])
        {
            aFeature[static_cast<std::size_t>(field)] = out.value[field];
        }
    }
    aEngine.Commit(aNid, in, out);
    int code = 1;
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
}

std::vector<double> IdleControl()
{
    std::vector<double> control(static_cast<std::size_t>(ctl::kCount), 0.0);
    control[ctl::kDelta] = .1;
    control[ctl::kGain] = 1;
    control[ctl::kSmile] = 1.65;
    control[ctl::kSquint] = 1.3;
    control[ctl::kBrowDown] = 1;
    control[ctl::kWarmth] = .12;
    control[ctl::kFamily] = FamJoy;
    control[ctl::kScale] = 2;
    return control;
}
} // namespace

TEST(faces_field_tables_match_the_scripts)
{
    convai::test::Fixture fixture("faces-frames");
    const auto cases = fixture.Cases();
    CHECK(cases.size() == 1);
    yyjson_val* fields = cases.front().Get("input", "fields");
    yyjson_val* tracks = cases.front().Get("input", "tracks");
    CHECK(fields && yyjson_is_arr(fields) && tracks && yyjson_is_arr(tracks));
    // FaceFeature.reds order, as bridge/facial-playback-native.test.mjs read it from the script.
    CHECK_EQ(yyjson_arr_size(fields), static_cast<size_t>(kFieldCount));
    for (int field = 0; field < kFieldCount; ++field)
    {
        CHECK_EQ(Text(yyjson_arr_get(fields, static_cast<size_t>(field))), std::string(kFieldNames[static_cast<std::size_t>(field)]));
        CHECK_EQ(FieldIndex(kFieldNames[static_cast<std::size_t>(field)]), field);
    }
    // The expression tracks, in the Lua expressionTracks order.
    CHECK_EQ(yyjson_arr_size(tracks), static_cast<size_t>(kTracks));
    for (int track = 0; track < kTracks; ++track)
    {
        const std::string name = Text(yyjson_arr_get(tracks, static_cast<size_t>(track)));
        CHECK_EQ(FieldIndex(name), kTrackField[static_cast<std::size_t>(track)]);
        CHECK_EQ(IsLipsTrack(track), name.rfind("lips_", 0) == 0);
        CHECK_EQ(IsCornerTrack(track), name.find("corner_") != std::string::npos);
        CHECK(!IsSpeechField(kTrackField[static_cast<std::size_t>(track)]));
    }
    int speechFields = 0;
    for (int field = 0; field < kFieldCount; ++field)
    {
        speechFields += IsSpeechField(field) ? 1 : 0;
    }
    CHECK_EQ(speechFields, 60 - 23 - 3);
    CHECK_EQ(kFieldNames[kFieldLBlink], std::string("eye_l_blink"));
    CHECK_EQ(kFieldNames[kFieldRBlink], std::string("eye_r_blink"));
    CHECK_EQ(kFieldNames[kFieldOwner], std::string("speech_owner"));
    CHECK_EQ(kFieldNames[kFieldJaw], std::string("jaw_mid_open"));
}

TEST(faces_replay_matches_the_lua_path)
{
    convai::test::Fixture fixture("faces-frames");
    const auto cases = fixture.Cases();
    CHECK(cases.size() == 1);
    yyjson_val* events = cases.front().Get("input", "events");
    CHECK(events && yyjson_is_arr(events));

    FaceEngine engine;
    std::map<int, std::array<float, kFieldCount>> features;
    std::set<int> live;     // slots the engine holds (a released slot's turn data lives on in Lua only)
    size_t index;
    size_t count;
    yyjson_val* event;
    int frames = 0;
    int checkpoints = 0;
    int statusMismatches = 0;
    double worst = 0;
    int worstFrame = -1;
    int worstField = -1;
    std::chrono::nanoseconds spent{0};
    yyjson_arr_foreach(events, index, count, event)
    {
        const std::string kind = Text(yyjson_obj_get(event, "t"));
        if (kind == "frame")
        {
            ++frames;
            const int nid = Int(event, "nid");
            live.insert(nid);
            const int featureId = Int(event, "feature");
            const std::vector<double> control = Numbers(yyjson_obj_get(event, "ctl"));
            yyjson_val* speechNode = yyjson_obj_get(event, "speech");
            const std::vector<double> speech = speechNode && yyjson_is_arr(speechNode) ? Numbers(speechNode) : std::vector<double>();
            const std::vector<double> expected = Numbers(yyjson_obj_get(event, "expected"));
            auto& feature = features.try_emplace(featureId, std::array<float, kFieldCount>{}).first->second;
            const auto start = std::chrono::steady_clock::now();
            const int code = ReplayFrame(engine, feature, nid, control, speech);
            spent += std::chrono::steady_clock::now() - start;
            if (code != Int(event, "status"))
            {
                if (++statusMismatches <= 5)
                {
                    convai::test::Fail(__FILE__, __LINE__,
                                       "frame " + std::to_string(frames) + ": status " + std::to_string(code) +
                                           " != Lua " + std::to_string(Int(event, "status")));
                }
            }
            CHECK(expected.size() == static_cast<std::size_t>(kFieldCount));
            for (int field = 0; field < kFieldCount; ++field)
            {
                const double error = std::fabs(static_cast<double>(feature[static_cast<std::size_t>(field)]) -
                                               expected[static_cast<std::size_t>(field)]);
                if (error > worst)
                {
                    worst = error;
                    worstFrame = frames;
                    worstField = field;
                }
            }
        }
        else if (kind == "zero")
        {
            engine.ZeroPose(Int(event, "nid"));
        }
        else if (kind == "noteReset")
        {
            engine.NoteReset(Int(event, "nid"));
        }
        else if (kind == "release")
        {
            engine.Release(Int(event, "nid"));
            live.erase(Int(event, "nid"));
        }
        else if (kind == "clear")
        {
            engine.Clear();
            live.clear();
        }
        else if (kind == "checkpoint")
        {
            ++checkpoints;
            yyjson_val* turn = yyjson_obj_get(event, "turn");
            if (turn && yyjson_is_arr(turn) && live.count(Int(event, "nid")) > 0)
            {
                const SlotState* slot = engine.Find(Int(event, "nid"));
                CHECK(slot != nullptr);
                const std::vector<double> values = Numbers(turn);
                CHECK(values.size() == static_cast<std::size_t>(2 + kTracks));
                if (slot && values.size() == static_cast<std::size_t>(2 + kTracks))
                {
                    CHECK_NEAR(slot->jawPeak, values[0], 1e-9);
                    CHECK_NEAR(slot->openFrames, values[1], 0);
                    for (int track = 0; track < kTracks; ++track)
                    {
                        CHECK_NEAR(slot->peak[track], values[static_cast<std::size_t>(2 + track)], 1e-6);
                    }
                }
            }
            yyjson_val* applied = yyjson_obj_get(event, "applied");
            size_t i2;
            size_t n2;
            yyjson_val* row;
            if (applied && yyjson_is_arr(applied))
            {
                yyjson_arr_foreach(applied, i2, n2, row)
                {
                    const SlotState* slot = engine.Find(Int(row, "nid"));
                    CHECK(slot != nullptr);
                    const std::vector<double> values = Numbers(yyjson_obj_get(row, "values"));
                    CHECK(values.size() == static_cast<std::size_t>(kTracks));
                    if (slot && values.size() == static_cast<std::size_t>(kTracks))
                    {
                        for (int track = 0; track < kTracks; ++track)
                        {
                            CHECK_NEAR(slot->applied[track], values[static_cast<std::size_t>(track)], 1e-9);
                        }
                    }
                }
            }
        }
    }
    CHECK(frames > 400);
    CHECK(checkpoints >= 8);
    CHECK_EQ(statusMismatches, 0);
    std::printf("    %d frames replayed, worst feature error %.3g (frame %d, %s), %.2f us per frame\n", frames, worst,
                worstFrame, worstField >= 0 ? kFieldNames[static_cast<std::size_t>(worstField)] : "none",
                static_cast<double>(spent.count()) / 1000.0 / std::max(frames, 1));
    CHECK(worst < 2e-6);
}

TEST(faces_engine_slots)
{
    FaceEngine engine;
    const std::vector<double> control = IdleControl();
    FrameInput in;
    CHECK(DecodeControl(control.data(), control.size(), nullptr, 0, in));
    FrameOutput out;
    engine.Compute(7, in, out);
    engine.Commit(7, in, out);
    CHECK(engine.Find(7) != nullptr);
    CHECK(engine.Find(8) == nullptr);
    CHECK(engine.Find(7)->hasApplied);
    engine.NoteReset(7);
    CHECK(engine.Find(7)->hasApplied);
    for (double value : engine.Find(7)->applied)
    {
        CHECK_EQ(value, 0.0);
    }
    engine.ZeroPose(7);
    for (double value : engine.Find(7)->pose)
    {
        CHECK_EQ(value, 0.0);
    }
    engine.Release(7);
    CHECK(engine.Find(7) == nullptr);
    CHECK_EQ(engine.Size(), static_cast<std::size_t>(0));

    // More slots than the cap: the least recently used one goes first, the others keep their state.
    for (int id = 1; id <= static_cast<int>(kMaxSlots); ++id)
    {
        engine.Compute(id, in, out);
    }
    CHECK_EQ(engine.Size(), kMaxSlots);
    engine.Compute(1, in, out); // slot 1 is now the most recently used
    engine.Compute(1000, in, out);
    CHECK_EQ(engine.Size(), kMaxSlots);
    CHECK(engine.Find(1) != nullptr);
    CHECK(engine.Find(2) == nullptr);
    CHECK(engine.Find(1000) != nullptr);
    engine.Clear();
    CHECK_EQ(engine.Size(), static_cast<std::size_t>(0));
}

TEST(faces_control_array_is_validated)
{
    std::vector<double> control = IdleControl();
    FrameInput in;
    CHECK(DecodeControl(control.data(), control.size(), nullptr, 0, in));
    CHECK(!DecodeControl(control.data(), control.size() - 1, nullptr, 0, in));
    CHECK(!DecodeControl(nullptr, control.size(), nullptr, 0, in));
    auto bad = control;
    bad[ctl::kWarmth] = std::nan("");
    CHECK(!DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    bad = control;
    bad[ctl::kGain] = INFINITY;
    CHECK(!DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    bad = control;
    bad[ctl::kFamily] = 11;
    CHECK(!DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    bad = control;
    bad[ctl::kFamily] = -1;
    CHECK(!DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    bad = control;
    bad[ctl::kScale] = 4;
    CHECK(!DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    bad = control;
    bad[ctl::kFlags] = flag::kSpeaking | flag::kExtended | flag::kWriteOwner;
    CHECK(DecodeControl(bad.data(), bad.size(), nullptr, 0, in));
    CHECK(in.speaking && in.extended && in.writeOwner && !in.blocked);
}

TEST(faces_blocked_frames_zero_the_pose_and_a_settled_face_reports_it)
{
    FaceEngine engine;
    std::vector<double> control = IdleControl();
    FrameInput in;
    FrameOutput out;
    // Warm the idle face until it settles.
    bool settled = false;
    for (int frame = 0; frame < 200 && !settled; ++frame)
    {
        control[ctl::kClock] = frame * .1;
        CHECK(DecodeControl(control.data(), control.size(), nullptr, 0, in));
        out = FrameOutput{};
        engine.Compute(1, in, out);
        engine.Commit(1, in, out);
        settled = out.settled;
    }
    CHECK(settled);
    // A blocked frame drives every track to zero at once.
    control[ctl::kFlags] = flag::kBlocked;
    CHECK(DecodeControl(control.data(), control.size(), nullptr, 0, in));
    out = FrameOutput{};
    engine.Compute(1, in, out);
    engine.Commit(1, in, out);
    CHECK(!out.settled);
    for (double value : engine.Find(1)->pose)
    {
        CHECK_EQ(value, 0.0);
    }
}

// The cost of one speaking frame in the core (no game calls): the budget the port claims.
TEST(faces_frame_cost)
{
    FaceEngine engine;
    std::vector<double> control = IdleControl();
    control[ctl::kFlags] = flag::kSpeaking | flag::kHasWeights | flag::kHasProvider | flag::kHasUpper | flag::kJawLift |
                           flag::kExtended | flag::kWriteOwner;
    control[ctl::kDelta] = 1.0 / 60.0;
    for (int family = 0; family < kMixFamilies; ++family)
    {
        control[static_cast<std::size_t>(ctl::kWeights + family)] = .1 * (family + 1);
    }
    for (int index = 0; index < 9; ++index)
    {
        control[static_cast<std::size_t>(ctl::kProvider + index)] = .1 * index;
    }
    control[ctl::kUpperRaise] = .6;
    control[ctl::kOwned] = 1;
    std::vector<double> speech(static_cast<std::size_t>(kFieldCount), 0.0);
    FrameInput in;
    FrameOutput out;
    const int frames = 20000;
    const auto start = std::chrono::steady_clock::now();
    double sink = 0;
    for (int frame = 0; frame < frames; ++frame)
    {
        control[ctl::kClock] = frame / 60.0;
        speech[kFieldJaw] = .3 + .2 * std::sin(frame * .4);
        speech[kFieldTogetherUp] = frame % 9 == 0 ? .8 : 0;
        CHECK(DecodeControl(control.data(), control.size(), speech.data(), speech.size(), in));
        out = FrameOutput{};
        engine.Compute(1, in, out);
        engine.Commit(1, in, out);
        sink += out.value[kFieldJaw];
    }
    const double micros = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count() / frames;
    std::printf("    core cost of a speaking frame: %.2f us (sink %.1f)\n", micros, sink);
    CHECK(micros < 50.0);
}
