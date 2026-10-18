#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>

// Asynchronous file IO for the bridge mailbox, lease and log files.
//
// Why: in CET one io.open costs about 3 ms of the game thread, os.rename about 4.8 ms and
// os.remove about 1.2 ms (perf probe 2026-10-11). Here the game thread only takes a mutex and
// copies a string; one worker thread does every disk operation.
//
// Model:
//   - Write/Remove/Rename/Append are queued and return at once. The worker runs them in order.
//     A Write replaces the file atomically (temp file + a POSIX-semantics rename, which works
//     while a reader holds the old file open; then MoveFileExW; in-place only as a last resort),
//     so a reader never sees a torn file. Two queued writes to one channel collapse into the last;
//     a Remove followed by a Write collapses into the Write (an atomic replace needs no remove).
//   - Read returns the worker's latest copy of a watched file. The worker polls each watched
//     file at its own period (stat first; it reads only when size or time changed, while the
//     last write is under 50 ms old, and on a forced re-read every 1 s), and bumps the channel's
//     revision when the bytes change. Unread channels back off to a 500 ms poll after 3 s.
//     A channel's first Read is synchronous (one direct read), every later Read is a copy.
//   - Writes are write-through: a Read after a Write on the same channel returns the written
//     bytes at once, and the poller leaves a channel alone while it has queued operations.
//   - A JSON channel only publishes bytes that parse, so Lua never sees a half-written file.
//     After 4 failed parses of the same bytes it publishes them anyway (the Lua side has always
//     coped with bad JSON; this only filters torn reads).
//   - Appends are buffered per channel and flushed every 0.5 s, at 64 KB, and on Stop.
//
// Thread safety: every public method may be called from any thread. Disk IO never happens
// under the mutex except the synchronous first read of a channel.

namespace convai
{
struct FileIoStats
{
    uint64_t writes = 0;
    uint64_t writesSkippedIdentical = 0;
    uint64_t writesCoalesced = 0;
    uint64_t writeFallbacks = 0; // atomic replace failed, wrote in place
    uint64_t writeFailures = 0;
    uint64_t removes = 0;
    uint64_t renames = 0;
    uint64_t appendsFlushed = 0;
    uint64_t polls = 0;
    uint64_t reads = 0;
    uint64_t publishes = 0;
    uint64_t jsonRejected = 0;
    uint64_t mainThreadReads = 0; // synchronous first reads
    uint64_t maxOpMicros = 0;     // slowest single disk operation on the worker
    uint64_t pending = 0;
};

class FileIo
{
public:
    struct Snapshot
    {
        bool exists = false;
        int32_t revision = 0;
        std::string content;
    };

    FileIo() = default;
    ~FileIo();
    FileIo(const FileIo&) = delete;
    FileIo& operator=(const FileIo&) = delete;

    // aRuntimeDirectory must exist or be creatable. Returns false if the worker could not start.
    bool Start(const std::wstring& aRuntimeDirectory);
    // Runs every queued operation and flushes appends (bounded by aBudgetMs), then joins.
    void Stop(uint32_t aBudgetMs = 2000);
    bool Running() const noexcept;

    bool Write(std::string_view aChannel, std::string aData);
    bool Append(std::string_view aChannel, std::string_view aText);
    bool Remove(std::string_view aChannel);
    bool Rename(std::string_view aFrom, std::string_view aTo);

    // Starts (or retunes) polling. aPeriodMs is clamped to [10, 5000].
    bool Watch(std::string_view aChannel, uint32_t aPeriodMs, bool aJson);
    // Latest content. Watches the channel with the default period if it is not watched yet.
    Snapshot Read(std::string_view aChannel);
    // > 0: exists, at that revision. < 0: missing (negated revision). 0: never seen.
    // Never touches the disk except for the first sight of a channel.
    int32_t Revision(std::string_view aChannel);

    // Blocks until the queue is empty and appends are flushed, at most aTimeoutMs.
    bool Flush(uint32_t aTimeoutMs);

    FileIoStats Stats() const;
    std::wstring RuntimeDirectory() const;

    // Called by the worker about once a second with the content of the control file (empty if
    // missing). The plugin points this at GlobalSwitches().ParseFile.
    using ControlCallback = void (*)(std::string_view aContent);
    void SetControlFile(std::string aChannel, ControlCallback aCallback);

    static constexpr uint32_t kDefaultPeriodMs = 100;
    static constexpr size_t kMaxFileBytes = 16u * 1024u * 1024u;

private:
    enum class OpKind
    {
        Write,
        Remove,
        Rename
    };

    struct Op
    {
        OpKind kind = OpKind::Write;
        std::string channel;
        std::string target; // Rename destination
        std::string data;
    };

    struct Channel
    {
        bool watched = false;
        bool json = false;
        uint32_t periodMs = kDefaultPeriodMs;
        bool exists = false;
        bool seen = false;
        int32_t revision = 0;
        std::string content;
        uint64_t lastReadTick = 0;
        uint64_t nextPollTick = 0;
        uint64_t lastForcedTick = 0;
        uint64_t diskTime = 0;
        uint64_t diskSize = 0;
        bool diskFresh = false; // the last seen write was recent enough for a same-tick rewrite
        uint64_t opSerial = 0;  // bumps when an op is queued or finishes; guards disk reads
        int invalidStreak = 0;
        uint64_t invalidHash = 0;
        int pendingOps = 0;
        // What the worker last wrote, to skip identical rewrites.
        bool wroteKnown = false;
        uint64_t wroteHash = 0;
        uint64_t wroteSize = 0;
        uint64_t wroteTime = 0;
    };

    void WorkerMain();
    void RunOp(Op& aOp);
    void PollDue(uint64_t aNow);
    void FlushAppends(bool aForce);
    void CheckControl(uint64_t aNow);
    uint64_t NextWake(uint64_t aNow);
    // aRetired (optional) receives the replaced bytes, so the caller frees them after unlocking.
    void Publish(Channel& aChannel, bool aExists, std::string aContent, std::string* aRetired = nullptr);
    Channel& ChannelLocked(std::string_view aChannel);
    void NoteOpTime(uint64_t aStartMicros);

    std::wstring Path(std::string_view aChannel) const;

    mutable std::mutex m_mutex;
    std::condition_variable m_wake;
    std::condition_variable m_idle;
    std::deque<Op> m_queue;
    std::unordered_map<std::string, Channel> m_channels;
    std::unordered_map<std::string, std::string> m_appends;
    size_t m_appendBytes = 0;
    uint64_t m_lastAppendFlush = 0;
    bool m_busy = false;
    bool m_stopping = false;
    bool m_running = false;
    std::thread m_worker;
    std::wstring m_directory;
    FileIoStats m_stats;

    std::string m_controlChannel;
    ControlCallback m_controlCallback = nullptr;
    uint64_t m_nextControlTick = 0;
    uint64_t m_controlTime = 0;
    uint64_t m_controlSize = 0;
    bool m_controlKnown = false;
};

FileIo& GlobalFileIo();

// Disk helpers, exposed for the tests.
namespace fileio
{
bool ReadWhole(const std::wstring& aPath, std::string& aOut, bool& aExists);
bool WriteAtomic(const std::wstring& aPath, std::string_view aData, bool& aUsedFallback);
bool AppendBytes(const std::wstring& aPath, std::string_view aData);
bool RemoveFile(const std::wstring& aPath);
bool RenameFile(const std::wstring& aFrom, const std::wstring& aTo);
bool StatFile(const std::wstring& aPath, uint64_t& aTime, uint64_t& aSize);
uint64_t Hash(std::string_view aData) noexcept;
bool IsJson(std::string_view aData) noexcept;
} // namespace fileio
} // namespace convai
