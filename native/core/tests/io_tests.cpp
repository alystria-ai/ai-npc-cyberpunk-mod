// Headless tests of the file IO core: the behaviour mod/native-core.lua relies on.

#include "Fixture.hpp"
#include "Test.hpp"

#include "core/FileIo.hpp"
#include "core/Paths.hpp"
#include "core/Switches.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

using namespace convai;
using convai::test::ReadRaw;
using convai::test::SleepMs;
using convai::test::TempDir;
using convai::test::WriteRaw;

namespace
{
std::wstring P(const TempDir& aDir, const char* aName)
{
    return aDir.path + L"\\" + paths::Utf8ToWide(aName);
}

// Polls until aCondition holds or aMs pass.
template<typename F>
bool WaitFor(F aCondition, unsigned aMs = 2000)
{
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(aMs);
    while (std::chrono::steady_clock::now() < end)
    {
        if (aCondition())
        {
            return true;
        }
        SleepMs(2);
    }
    return aCondition();
}
} // namespace

TEST(channel_names_are_confined)
{
    CHECK(paths::IsValidChannel("reply.json"));
    CHECK(paths::IsValidChannel("phone-chat_input.v2.json"));
    CHECK(!paths::IsValidChannel(""));
    CHECK(!paths::IsValidChannel("../settings.json"));
    CHECK(!paths::IsValidChannel("a..b"));
    CHECK(!paths::IsValidChannel("sub/reply.json"));
    CHECK(!paths::IsValidChannel("sub\\reply.json"));
    CHECK(!paths::IsValidChannel("C:reply.json"));
    CHECK(!paths::IsValidChannel(".hidden"));
    CHECK(!paths::IsValidChannel(std::string(97, 'a')));
}

TEST(switches_parse_names_all_and_trips)
{
    Switches switches;
    CHECK(switches.Enabled("io"));
    switches.ParseFile("# comment\r\n IO \r\ngaze # trailing\n");
    CHECK(!switches.Enabled("io"));
    CHECK(!switches.Enabled("gaze"));
    CHECK(switches.Enabled("faces"));
    switches.ParseFile("");
    CHECK(switches.Enabled("io"));
    switches.ParseFile("all");
    CHECK(!switches.Enabled("faces"));
    switches.ParseFile("");
    switches.Trip("faces", "3 faults");
    CHECK(!switches.Enabled("faces"));
    CHECK(switches.DescribeJson().find("\"faces\":\"3 faults\"") != std::string::npos);
}

TEST(io_write_is_write_through_and_lands_on_disk)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK(io.Write("world-session.json", "{\"a\":1}"));
    const auto snapshot = io.Read("world-session.json");
    CHECK(snapshot.exists);
    CHECK_EQ(snapshot.content, std::string("{\"a\":1}"));
    CHECK(io.Flush(2000));
    CHECK_EQ(ReadRaw(P(dir, "world-session.json")), std::string("{\"a\":1}"));
    bool tempExists = true;
    ReadRaw(P(dir, "world-session.json.native-tmp"), &tempExists);
    CHECK(!tempExists);
    io.Stop();
}

TEST(io_rejects_bad_channels)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK(!io.Write("../escape.json", "x"));
    CHECK(!io.Remove("a/b"));
    CHECK(!io.Watch("..", 100, false));
    CHECK_EQ(io.Revision("bad/name"), 0);
    io.Stop();
}

TEST(io_coalesces_queued_writes_and_skips_identical)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    for (int i = 0; i < 500; ++i)
    {
        CHECK(io.Write("party-connections.json", "{\"n\":" + std::to_string(i) + "}"));
    }
    CHECK(io.Flush(3000));
    CHECK_EQ(ReadRaw(P(dir, "party-connections.json")), std::string("{\"n\":499}"));
    auto stats = io.Stats();
    CHECK(stats.writes + stats.writesCoalesced >= 500);
    CHECK(stats.writes < 500); // most were merged while the worker was busy
    const uint64_t writes = stats.writes;
    CHECK(io.Write("party-connections.json", "{\"n\":499}"));
    CHECK(io.Flush(2000));
    stats = io.Stats();
    CHECK_EQ(stats.writes, writes);
    CHECK(stats.writesSkippedIdentical >= 1);
    // An external delete must not be mistaken for "identical": the next write lands.
    DeleteFileW(P(dir, "party-connections.json").c_str());
    CHECK(io.Write("party-connections.json", "{\"n\":499}"));
    CHECK(io.Flush(2000));
    CHECK_EQ(ReadRaw(P(dir, "party-connections.json")), std::string("{\"n\":499}"));
    io.Stop();
}

TEST(io_remove_then_write_collapses_and_remove_works)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    WriteRaw(P(dir, "last-input.json"), "old");
    CHECK(io.Remove("last-input.json"));
    CHECK(!io.Read("last-input.json").exists);
    CHECK(io.Write("last-input.json", "new"));
    CHECK(io.Flush(2000));
    CHECK_EQ(ReadRaw(P(dir, "last-input.json")), std::string("new"));
    CHECK(io.Remove("last-input.json"));
    CHECK(io.Flush(2000));
    bool exists = true;
    ReadRaw(P(dir, "last-input.json"), &exists);
    CHECK(!exists);
    CHECK(io.Revision("last-input.json") < 0);
    io.Stop();
}

TEST(io_first_read_is_synchronous_then_polls_external_changes)
{
    TempDir dir;
    WriteRaw(P(dir, "reply.json"), "{\"requestId\":1}");
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK(io.Watch("reply.json", 20, true));
    auto first = io.Read("reply.json");
    CHECK(first.exists);
    CHECK_EQ(first.content, std::string("{\"requestId\":1}"));
    const int32_t revision = io.Revision("reply.json");
    CHECK(revision > 0);
    WriteRaw(P(dir, "reply.json"), "{\"requestId\":2}");
    CHECK(WaitFor([&] { return io.Revision("reply.json") != revision; }));
    CHECK_EQ(io.Read("reply.json").content, std::string("{\"requestId\":2}"));
    DeleteFileW(P(dir, "reply.json").c_str());
    CHECK(WaitFor([&] { return io.Revision("reply.json") < 0; }));
    CHECK(!io.Read("reply.json").exists);
    io.Stop();
}

TEST(io_missing_file_reads_as_missing)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK_EQ(io.Revision("memory-chat-resets.json"), -1);
    CHECK(!io.Read("memory-chat-resets.json").exists);
    WriteRaw(P(dir, "memory-chat-resets.json"), "{\"resets\":[]}");
    CHECK(WaitFor([&] { return io.Revision("memory-chat-resets.json") > 0; }));
    io.Stop();
}

TEST(io_json_channel_never_publishes_torn_bytes)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    WriteRaw(P(dir, "continuous-speech.json"), "{\"text\":\"one\"}");
    CHECK(io.Watch("continuous-speech.json", 10, true));
    CHECK_EQ(io.Read("continuous-speech.json").content, std::string("{\"text\":\"one\"}"));
    const int32_t revision = io.Revision("continuous-speech.json");
    WriteRaw(P(dir, "continuous-speech.json"), "{\"text\":\"tw"); // torn
    SleepMs(30);
    CHECK_EQ(io.Revision("continuous-speech.json"), revision);
    CHECK_EQ(io.Read("continuous-speech.json").content, std::string("{\"text\":\"one\"}"));
    WriteRaw(P(dir, "continuous-speech.json"), "{\"text\":\"two\"}");
    CHECK(WaitFor([&] { return io.Read("continuous-speech.json").content == "{\"text\":\"two\"}"; }));
    // Persistently invalid bytes are published after a few polls, as the Lua path would see them.
    WriteRaw(P(dir, "continuous-speech.json"), "not json");
    CHECK(WaitFor([&] { return io.Read("continuous-speech.json").content == "not json"; }));
    CHECK(io.Stats().jsonRejected >= 3);
    io.Stop();
}

TEST(io_appends_are_buffered_and_flushed_in_order)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    WriteRaw(P(dir, "probe.log"), "start\n");
    for (int i = 0; i < 100; ++i)
    {
        CHECK(io.Append("probe.log", "line " + std::to_string(i) + "\n"));
    }
    CHECK(io.Flush(2000));
    const std::string log = ReadRaw(P(dir, "probe.log"));
    CHECK(log.rfind("start\nline 0\nline 1\n", 0) == 0);
    CHECK(log.size() > 600 && log.find("line 99\n") == log.size() - 8);
    io.Stop();
    CHECK(io.Stats().appendsFlushed >= 1);
}

TEST(io_stop_drains_the_queue)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK(io.Write("speech-state.json", "{\"s\":1}"));
    CHECK(io.Append("probe.log", "bye\n"));
    io.Stop(2000);
    CHECK_EQ(ReadRaw(P(dir, "speech-state.json")), std::string("{\"s\":1}"));
    CHECK_EQ(ReadRaw(P(dir, "probe.log")), std::string("bye\n"));
    CHECK(!io.Write("speech-state.json", "late")); // refused after Stop
}

TEST(io_rename_moves_and_updates_both_channels)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    CHECK(io.Write("phone-history.json", "{\"v\":1}"));
    CHECK(io.Rename("phone-history.json", "phone-history.json.previous"));
    CHECK(!io.Read("phone-history.json").exists);
    CHECK_EQ(io.Read("phone-history.json.previous").content, std::string("{\"v\":1}"));
    CHECK(io.Flush(2000));
    CHECK_EQ(ReadRaw(P(dir, "phone-history.json.previous")), std::string("{\"v\":1}"));
    bool exists = true;
    ReadRaw(P(dir, "phone-history.json"), &exists);
    CHECK(!exists);
    io.Stop();
}

TEST(io_replace_survives_a_reader_without_delete_sharing)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    WriteRaw(P(dir, "nearby-connections.json"), "{\"old\":true}");
    // A reader that does not share delete blocks MoveFileEx; the worker must fall back.
    HANDLE reader = CreateFileW(P(dir, "nearby-connections.json").c_str(), GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    CHECK(reader != INVALID_HANDLE_VALUE);
    CHECK(io.Write("nearby-connections.json", "{\"new\":true}"));
    CHECK(io.Flush(2000));
    CloseHandle(reader);
    CHECK_EQ(ReadRaw(P(dir, "nearby-connections.json")), std::string("{\"new\":true}"));
    CHECK(io.Stats().writeFallbacks >= 1);
    io.Stop();
}

TEST(io_concurrent_reader_never_sees_a_torn_file)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    const std::string padding(4000, 'x');
    CHECK(io.Write("relationship-state.json", "{\"n\":0,\"p\":\"" + padding + "\"}"));
    CHECK(io.Flush(2000));
    std::atomic<bool> done{false};
    std::atomic<int> torn{0};
    std::atomic<int> seen{0};
    std::thread reader([&] {
        while (!done)
        {
            bool exists = false;
            const std::string data = ReadRaw(P(dir, "relationship-state.json"), &exists);
            if (exists)
            {
                ++seen;
                if (!fileio::IsJson(data))
                {
                    ++torn;
                }
            }
        }
    });
    for (int i = 1; i <= 300; ++i)
    {
        io.Write("relationship-state.json", "{\"n\":" + std::to_string(i) + ",\"p\":\"" + padding + "\"}");
        SleepMs(1);
    }
    CHECK(io.Flush(3000));
    done = true;
    reader.join();
    CHECK(seen > 0);
    CHECK_EQ(torn.load(), 0);
    io.Stop();
}

TEST(io_control_file_drives_switches)
{
    TempDir dir;
    FileIo io;
    static Switches switches;
    switches.ParseFile("");
    CHECK(io.Start(dir.path));
    io.SetControlFile("native-off.txt", [](std::string_view aContent) { switches.ParseFile(aContent); });
    SleepMs(50);
    CHECK(switches.Enabled("io"));
    WriteRaw(P(dir, "native-off.txt"), "io\n");
    CHECK(WaitFor([] { return !switches.Enabled("io"); }, 3000));
    DeleteFileW(P(dir, "native-off.txt").c_str());
    CHECK(WaitFor([] { return switches.Enabled("io"); }, 3000));
    io.Stop();
}

TEST(io_main_thread_cost_is_microseconds)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    WriteRaw(P(dir, "continuous-speech.json"), "{\"text\":\"" + std::string(12000, 'a') + "\"}");
    CHECK(io.Watch("continuous-speech.json", 15, true));
    io.Read("continuous-speech.json");
    const std::string payload = "{\"updated\":1,\"profiles\":[\"judy-alvarez\",\"panam-palmer\"]}";
    constexpr int kCalls = 5000;
    LARGE_INTEGER frequency, start, end;
    QueryPerformanceFrequency(&frequency);

    QueryPerformanceCounter(&start);
    for (int i = 0; i < kCalls; ++i)
    {
        io.Write("party-connections.json", payload);
    }
    QueryPerformanceCounter(&end);
    const double writeMicros = (end.QuadPart - start.QuadPart) * 1e6 / frequency.QuadPart / kCalls;

    QueryPerformanceCounter(&start);
    for (int i = 0; i < kCalls; ++i)
    {
        io.Revision("continuous-speech.json");
    }
    QueryPerformanceCounter(&end);
    const double revisionMicros = (end.QuadPart - start.QuadPart) * 1e6 / frequency.QuadPart / kCalls;

    QueryPerformanceCounter(&start);
    for (int i = 0; i < kCalls; ++i)
    {
        io.Read("continuous-speech.json");
    }
    QueryPerformanceCounter(&end);
    const double readMicros = (end.QuadPart - start.QuadPart) * 1e6 / frequency.QuadPart / kCalls;

    std::printf("    main thread: Write %.2f us, Revision %.2f us, Read(12 KB) %.2f us\n", writeMicros, revisionMicros,
                readMicros);
    // Generous bounds for a loaded laptop; CET's io.open is about 3000 us.
    CHECK(writeMicros < 50.0);
    CHECK(revisionMicros < 20.0);
    CHECK(readMicros < 100.0);
    io.Stop();
}

// Parity: every runtime path mod/native-core.lua routes must be a channel the worker accepts, and
// the channel name must be the one Lua derived (fixture: bridge/native-core.test.mjs).
TEST(io_channels_match_the_lua_router)
{
    convai::test::Fixture fixture("io-channels");
    for (const auto& item : fixture.Cases())
    {
        if (item.Has("output", "channel"))
        {
            const std::string channel = item.Str("output", "channel");
            CHECK(paths::IsValidChannel(channel));
            CHECK(item.Str("input", "path").ends_with(channel));
        }
    }
    CHECK(fixture.Count() >= 10);
}

namespace
{
// Replaces aName the way the bridge does (a temp file renamed over the target), so a reader never sees
// a half-written file. Returns when the rename has landed.
void ReplaceLikeTheBridge(const TempDir& aDir, const char* aName, const std::string& aData)
{
    const std::wstring target = P(aDir, aName);
    const std::wstring temp = target + L".tmp";
    WriteRaw(temp, aData);
    MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING);
}

double NowMillis()
{
    static LARGE_INTEGER frequency = [] {
        LARGE_INTEGER value;
        QueryPerformanceFrequency(&value);
        return value;
    }();
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return counter.QuadPart * 1000.0 / frequency.QuadPart;
}
} // namespace

// The worker validates a big JSON file before it publishes it. That work must not hold the mutex the
// game thread takes in Revision() and Read(): a 2 MB document is several ms of parsing.
TEST(io_game_thread_never_waits_for_the_workers_json_check)
{
    TempDir dir;
    FileIo io;
    CHECK(io.Start(dir.path));
    auto document = [](int aSerial) {
        std::string text = "{\"n\":" + std::to_string(aSerial) + ",\"v\":[";
        for (int i = 0; i < 120000; ++i)
        {
            text += (i ? "," : "");
            text += std::to_string(1.0 + (i % 977) * 0.0123456);
        }
        return text + "]}";
    };
    ReplaceLikeTheBridge(dir, "continuous-face.json", document(0));
    CHECK(io.Watch("continuous-face.json", 15, true));
    io.Read("continuous-face.json");
    std::atomic<bool> done{false};
    std::thread writer([&] {
        for (int serial = 1; serial <= 20; ++serial)
        {
            ReplaceLikeTheBridge(dir, "continuous-face.json", document(serial));
            SleepMs(40);
        }
        done = true;
    });
    int slow = 0;
    double worst = 0;
    int calls = 0;
    while (!done)
    {
        const double started = NowMillis();
        io.Revision("continuous-face.json");
        const double took = NowMillis() - started;
        worst = std::max(worst, took);
        slow += took > 1.0 ? 1 : 0;
        ++calls;
    }
    writer.join();
    std::printf("    Revision() while 20 big files publish (%d calls): %d over 1 ms, worst %.2f ms\n", calls, slow, worst);
    CHECK(WaitFor([&] { return io.Read("continuous-face.json").content.find("\"n\":20,") != std::string::npos; }, 3000));
    CHECK(io.Stats().publishes >= 5);
    CHECK(slow <= 8); // before the fix every publish stalled it (about 60 calls over 1 ms, worst 3.5 ms)
    io.Stop();
}
