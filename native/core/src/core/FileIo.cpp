#include "FileIo.hpp"

#include "Log.hpp"
#include "Paths.hpp"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <yyjson.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <vector>

namespace convai
{
namespace
{
uint64_t NowMs() noexcept
{
    return GetTickCount64();
}

uint64_t NowMicros() noexcept
{
    static const uint64_t frequency = [] {
        LARGE_INTEGER value;
        QueryPerformanceFrequency(&value);
        return static_cast<uint64_t>(value.QuadPart);
    }();
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return static_cast<uint64_t>(counter.QuadPart) * 1000000ull / frequency;
}

bool Transient(DWORD aError) noexcept
{
    return aError == ERROR_SHARING_VIOLATION || aError == ERROR_ACCESS_DENIED || aError == ERROR_LOCK_VIOLATION;
}

constexpr uint64_t kIdleAfterMs = 3000;
constexpr uint32_t kIdlePeriodMs = 500;
constexpr uint64_t kForcedRereadMs = 1000;
constexpr uint64_t kFreshTicks = 50ull * 10000ull; // 50 ms in FILETIME units

// True when a file last written at aWriteTime could still be rewritten within the same file-time
// tick without its stat changing.
bool Fresh(uint64_t aWriteTime) noexcept
{
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    const uint64_t current = (static_cast<uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
    return current < aWriteTime + kFreshTicks;
}
constexpr uint64_t kAppendFlushMs = 500;
constexpr size_t kAppendFlushBytes = 64 * 1024;
constexpr uint64_t kControlPeriodMs = 1000;
constexpr int kJsonPatience = 4;
} // namespace

namespace fileio
{
uint64_t Hash(std::string_view aData) noexcept
{
    uint64_t hash = 1469598103934665603ull;
    for (const char c : aData)
    {
        hash ^= static_cast<unsigned char>(c);
        hash *= 1099511628211ull;
    }
    return hash;
}

bool IsJson(std::string_view aData) noexcept
{
    if (aData.empty())
    {
        return false;
    }
    yyjson_doc* doc = yyjson_read(aData.data(), aData.size(), YYJSON_READ_NOFLAG);
    if (!doc)
    {
        return false;
    }
    yyjson_doc_free(doc);
    return true;
}

bool StatFile(const std::wstring& aPath, uint64_t& aTime, uint64_t& aSize)
{
    WIN32_FILE_ATTRIBUTE_DATA data{};
    if (!GetFileAttributesExW(aPath.c_str(), GetFileExInfoStandard, &data) ||
        (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
    {
        return false;
    }
    aTime = (static_cast<uint64_t>(data.ftLastWriteTime.dwHighDateTime) << 32) | data.ftLastWriteTime.dwLowDateTime;
    aSize = (static_cast<uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
    return true;
}

bool ReadWhole(const std::wstring& aPath, std::string& aOut, bool& aExists)
{
    aOut.clear();
    aExists = false;
    HANDLE file = CreateFileW(aPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE)
    {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    }
    aExists = true;
    LARGE_INTEGER size{};
    bool ok = GetFileSizeEx(file, &size) != 0 && size.QuadPart >= 0 &&
              static_cast<uint64_t>(size.QuadPart) <= FileIo::kMaxFileBytes;
    if (ok)
    {
        aOut.resize(static_cast<size_t>(size.QuadPart));
        size_t offset = 0;
        while (ok && offset < aOut.size())
        {
            DWORD got = 0;
            const DWORD want = static_cast<DWORD>(std::min<size_t>(aOut.size() - offset, 1u << 20));
            ok = ReadFile(file, aOut.data() + offset, want, &got, nullptr) != 0;
            if (got == 0)
            {
                break; // shrank while reading; keep what we have
            }
            offset += got;
        }
        aOut.resize(offset);
    }
    CloseHandle(file);
    return ok;
}

namespace
{
bool WriteHandle(HANDLE aFile, std::string_view aData)
{
    size_t offset = 0;
    while (offset < aData.size())
    {
        DWORD wrote = 0;
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(aData.size() - offset, 1u << 20));
        if (!WriteFile(aFile, aData.data() + offset, chunk, &wrote, nullptr) || wrote == 0)
        {
            return false;
        }
        offset += wrote;
    }
    return true;
}

bool PosixReplace(HANDLE aFile, const std::wstring& aTarget)
{
    // FILE_RENAME_INFO with the Flags member (FileRenameInfoEx), built by hand so the code does
    // not depend on the SDK's _WIN32_WINNT selection.
    constexpr DWORD kReplaceIfExists = 0x1;
    constexpr DWORD kPosixSemantics = 0x2;
    constexpr int kFileRenameInfoEx = 22;
    const size_t nameBytes = aTarget.size() * sizeof(wchar_t);
    std::vector<uint8_t> buffer(sizeof(FILE_RENAME_INFO) + nameBytes + sizeof(wchar_t), 0);
    auto* info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    *reinterpret_cast<DWORD*>(info) = kReplaceIfExists | kPosixSemantics;
    info->RootDirectory = nullptr;
    info->FileNameLength = static_cast<DWORD>(nameBytes);
    std::memcpy(info->FileName, aTarget.c_str(), nameBytes);
    for (int attempt = 0; attempt < 4; ++attempt)
    {
        if (SetFileInformationByHandle(aFile, static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileRenameInfoEx), info,
                                       static_cast<DWORD>(buffer.size())))
        {
            return true;
        }
        if (!Transient(GetLastError()))
        {
            return false;
        }
        Sleep(1 + attempt);
    }
    return false;
}

bool WriteInPlace(const std::wstring& aPath, std::string_view aData)
{
    for (int attempt = 0; attempt < 5; ++attempt)
    {
        HANDLE file = CreateFileW(aPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                                  CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE)
        {
            const bool ok = WriteHandle(file, aData);
            CloseHandle(file);
            return ok;
        }
        if (!Transient(GetLastError()))
        {
            return false;
        }
        Sleep(1 + attempt);
    }
    return false;
}
} // namespace

bool WriteAtomic(const std::wstring& aPath, std::string_view aData, bool& aUsedFallback)
{
    aUsedFallback = false;
    const std::wstring temp = aPath + L".native-tmp";
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE | DELETE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                              nullptr);
    if (file != INVALID_HANDLE_VALUE)
    {
        const bool wrote = WriteHandle(file, aData);
        // POSIX-semantics replace (Windows 10 1809+): succeeds even while a reader holds the old
        // file open with FILE_SHARE_DELETE (Node and this worker both do), and that reader keeps
        // the old bytes. A plain MoveFileEx fails with access denied in that case.
        if (wrote && PosixReplace(file, aPath))
        {
            CloseHandle(file);
            return true;
        }
        CloseHandle(file);
        if (wrote)
        {
            for (int attempt = 0; attempt < 8; ++attempt)
            {
                if (MoveFileExW(temp.c_str(), aPath.c_str(), MOVEFILE_REPLACE_EXISTING))
                {
                    return true;
                }
                if (!Transient(GetLastError()))
                {
                    break;
                }
                Sleep(1 + attempt);
            }
        }
        DeleteFileW(temp.c_str());
    }
    // A reader holding the file without FILE_SHARE_DELETE blocks the replace. Writing in place is
    // what the Lua path did for most of these files, and every bridge reader copes with it.
    aUsedFallback = true;
    return WriteInPlace(aPath, aData);
}

bool AppendBytes(const std::wstring& aPath, std::string_view aData)
{
    for (int attempt = 0; attempt < 5; ++attempt)
    {
        HANDLE file = CreateFileW(aPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE)
        {
            const bool ok = WriteHandle(file, aData);
            CloseHandle(file);
            return ok;
        }
        if (!Transient(GetLastError()))
        {
            return false;
        }
        Sleep(1 + attempt);
    }
    return false;
}

bool RemoveFile(const std::wstring& aPath)
{
    for (int attempt = 0; attempt < 5; ++attempt)
    {
        if (DeleteFileW(aPath.c_str()))
        {
            return true;
        }
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
        {
            return true;
        }
        if (!Transient(error))
        {
            return false;
        }
        Sleep(1 + attempt);
    }
    return false;
}

bool RenameFile(const std::wstring& aFrom, const std::wstring& aTo)
{
    for (int attempt = 0; attempt < 5; ++attempt)
    {
        if (MoveFileExW(aFrom.c_str(), aTo.c_str(), MOVEFILE_REPLACE_EXISTING))
        {
            return true;
        }
        if (!Transient(GetLastError()))
        {
            return false;
        }
        Sleep(1 + attempt);
    }
    return false;
}
} // namespace fileio

FileIo& GlobalFileIo()
{
    // Leaked on purpose: a destructor at DLL detach would run under the loader lock, and a worker
    // killed by ExitProcess may have died holding the mutex.
    static FileIo* io = new FileIo();
    return *io;
}

FileIo::~FileIo()
{
    if (m_worker.joinable())
    {
        Stop(500);
    }
}

bool FileIo::Start(const std::wstring& aRuntimeDirectory)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_running)
    {
        return true;
    }
    if (aRuntimeDirectory.empty())
    {
        CONVAI_ERROR("File IO: no runtime folder");
        return false;
    }
    m_directory = aRuntimeDirectory;
    m_stopping = false;
    try
    {
        m_worker = std::thread([this] { WorkerMain(); });
    }
    catch (...)
    {
        CONVAI_ERROR("File IO: the worker thread could not start");
        return false;
    }
    m_running = true;
    const DWORD attributes = GetFileAttributesW(paths::LongPath(m_directory).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY))
    {
        CONVAI_WARN("File IO: runtime folder %s does not exist yet", paths::WideToUtf8(m_directory).c_str());
    }
    return true;
}

void FileIo::Stop(uint32_t aBudgetMs)
{
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running)
        {
            return;
        }
        m_stopping = true;
    }
    m_wake.notify_all();
    // The worker drains the queue and flushes appends before it exits. Each operation is bounded
    // (a few retries of a few ms), so this cannot hang on a stuck file.
    const uint64_t deadline = NowMs() + aBudgetMs;
    while (NowMs() < deadline)
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (!m_running)
            {
                break;
            }
        }
        Sleep(2);
    }
    bool finished = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        finished = !m_running;
    }
    if (finished)
    {
        if (m_worker.joinable())
        {
            m_worker.join();
        }
    }
    else
    {
        CONVAI_WARN("File IO: the worker did not finish within %u ms; leaving it", aBudgetMs);
        m_worker.detach();
    }
}

bool FileIo::Running() const noexcept
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_running && !m_stopping;
}

std::wstring FileIo::RuntimeDirectory() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_directory;
}

std::wstring FileIo::Path(std::string_view aChannel) const
{
    return paths::Join(m_directory, aChannel);
}

FileIo::Channel& FileIo::ChannelLocked(std::string_view aChannel)
{
    return m_channels[std::string(aChannel)];
}

void FileIo::Publish(Channel& aChannel, bool aExists, std::string aContent)
{
    if (aChannel.seen && aChannel.exists == aExists && aChannel.content == aContent)
    {
        return;
    }
    aChannel.seen = true;
    aChannel.exists = aExists;
    aChannel.content = std::move(aContent);
    aChannel.revision = aChannel.revision >= 0x7ffffff0 ? 1 : aChannel.revision + 1;
    ++m_stats.publishes;
}

bool FileIo::Write(std::string_view aChannel, std::string aData)
{
    if (!paths::IsValidChannel(aChannel) || aData.size() > kMaxFileBytes)
    {
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running || m_stopping)
        {
            return false;
        }
        // Write-through, watched or not: a Read right after this Write sees these bytes.
        Channel& channel = ChannelLocked(aChannel);
        Publish(channel, true, aData);
        bool merged = false;
        for (auto it = m_queue.rbegin(); it != m_queue.rend(); ++it)
        {
            if (it->channel == aChannel || (it->kind == OpKind::Rename && it->target == aChannel))
            {
                if (it->channel == aChannel && (it->kind == OpKind::Write || it->kind == OpKind::Remove))
                {
                    it->kind = OpKind::Write;
                    it->data = std::move(aData);
                    merged = true;
                    ++m_stats.writesCoalesced;
                }
                break;
            }
        }
        if (!merged)
        {
            m_queue.push_back(Op{OpKind::Write, std::string(aChannel), {}, std::move(aData)});
            ++channel.pendingOps;
        }
        ++channel.opSerial;
    }
    m_wake.notify_one();
    return true;
}

bool FileIo::Remove(std::string_view aChannel)
{
    if (!paths::IsValidChannel(aChannel))
    {
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running || m_stopping)
        {
            return false;
        }
        Channel& channel = ChannelLocked(aChannel);
        Publish(channel, false, {});
        bool merged = false;
        for (auto it = m_queue.rbegin(); it != m_queue.rend(); ++it)
        {
            if (it->channel == aChannel || (it->kind == OpKind::Rename && it->target == aChannel))
            {
                if (it->channel == aChannel && (it->kind == OpKind::Write || it->kind == OpKind::Remove))
                {
                    it->kind = OpKind::Remove;
                    it->data.clear();
                    merged = true;
                }
                break;
            }
        }
        if (!merged)
        {
            m_queue.push_back(Op{OpKind::Remove, std::string(aChannel), {}, {}});
            ++channel.pendingOps;
        }
        ++channel.opSerial;
    }
    m_wake.notify_one();
    return true;
}

bool FileIo::Rename(std::string_view aFrom, std::string_view aTo)
{
    if (!paths::IsValidChannel(aFrom) || !paths::IsValidChannel(aTo) || aFrom == aTo)
    {
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running || m_stopping)
        {
            return false;
        }
        Channel& from = ChannelLocked(aFrom);
        Channel& to = ChannelLocked(aTo);
        if (from.seen)
        {
            Publish(to, from.exists, from.content);
        }
        Publish(from, false, {});
        // Force a fresh look at the destination once the rename lands.
        to.diskTime = 0;
        to.nextPollTick = 0;
        m_queue.push_back(Op{OpKind::Rename, std::string(aFrom), std::string(aTo), {}});
        ++from.pendingOps;
        ++to.pendingOps;
        ++from.opSerial;
        ++to.opSerial;
    }
    m_wake.notify_one();
    return true;
}

bool FileIo::Append(std::string_view aChannel, std::string_view aText)
{
    if (!paths::IsValidChannel(aChannel))
    {
        return false;
    }
    if (aText.empty())
    {
        return true;
    }
    bool wake = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running || m_stopping || m_appendBytes + aText.size() > kMaxFileBytes)
        {
            return false;
        }
        m_appends[std::string(aChannel)].append(aText);
        m_appendBytes += aText.size();
        wake = m_appendBytes >= kAppendFlushBytes;
    }
    if (wake)
    {
        m_wake.notify_one();
    }
    return true;
}

bool FileIo::Watch(std::string_view aChannel, uint32_t aPeriodMs, bool aJson)
{
    if (!paths::IsValidChannel(aChannel))
    {
        return false;
    }
    const uint32_t period = std::clamp<uint32_t>(aPeriodMs, 10, 5000);
    std::wstring path;
    uint64_t serial = 0;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_running || m_stopping)
        {
            return false;
        }
        Channel& channel = ChannelLocked(aChannel);
        channel.periodMs = period;
        channel.json = aJson;
        if (channel.watched)
        {
            return true;
        }
        channel.watched = true;
        channel.lastReadTick = NowMs();
        serial = channel.opSerial;
        path = Path(aChannel);
    }

    // First sight: one direct read so the caller gets real content on its first Read.
    std::string content;
    bool exists = false;
    uint64_t time = 0;
    uint64_t size = 0;
    const bool statted = fileio::StatFile(path, time, size);
    const bool read = fileio::ReadWhole(path, content, exists);
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(aChannel);
        ++m_stats.mainThreadReads;
        // Publish only if no operation was queued or finished while we read: otherwise the disk
        // bytes may predate a Write/Remove the caller already sees through the write-through copy.
        const bool undisturbed = channel.pendingOps == 0 && channel.opSerial == serial;
        if (undisturbed && read && (!aJson || !exists || fileio::IsJson(content)))
        {
            channel.diskTime = statted ? time : 0;
            channel.diskSize = statted ? size : 0;
            channel.diskFresh = statted && Fresh(time);
            Publish(channel, exists, std::move(content));
        }
        else if (!channel.seen && undisturbed)
        {
            // Torn or locked on first sight: report missing now, the worker retries at once.
            Publish(channel, false, {});
            channel.diskTime = 0;
        }
        channel.nextPollTick = NowMs() + std::min<uint32_t>(period, 15);
    }
    m_wake.notify_one();
    return true;
}

FileIo::Snapshot FileIo::Read(std::string_view aChannel)
{
    if (!paths::IsValidChannel(aChannel))
    {
        return {};
    }
    bool needsWatch = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_channels.find(std::string(aChannel));
        needsWatch = it == m_channels.end() || !it->second.watched;
    }
    if (needsWatch && !Watch(aChannel, kDefaultPeriodMs, false))
    {
        return {};
    }
    bool wake = false;
    Snapshot snapshot;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(aChannel);
        const uint64_t now = NowMs();
        if (now - channel.lastReadTick > kIdleAfterMs && channel.nextPollTick > now)
        {
            // Back from idle: poll now; this Read returns the last copy, the next one is fresh.
            channel.nextPollTick = now;
            wake = true;
        }
        channel.lastReadTick = now;
        snapshot.exists = channel.exists;
        snapshot.revision = channel.revision;
        snapshot.content = channel.content;
        ++m_stats.reads;
    }
    if (wake)
    {
        m_wake.notify_one();
    }
    return snapshot;
}

int32_t FileIo::Revision(std::string_view aChannel)
{
    if (!paths::IsValidChannel(aChannel))
    {
        return 0;
    }
    bool needsWatch = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        auto it = m_channels.find(std::string(aChannel));
        needsWatch = it == m_channels.end() || !it->second.watched;
    }
    if (needsWatch && !Watch(aChannel, kDefaultPeriodMs, false))
    {
        return 0;
    }
    bool wake = false;
    int32_t revision = 0;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(aChannel);
        const uint64_t now = NowMs();
        if (now - channel.lastReadTick > kIdleAfterMs && channel.nextPollTick > now)
        {
            channel.nextPollTick = now;
            wake = true;
        }
        channel.lastReadTick = now;
        revision = channel.exists ? channel.revision : -channel.revision;
    }
    if (wake)
    {
        m_wake.notify_one();
    }
    return revision;
}

bool FileIo::Flush(uint32_t aTimeoutMs)
{
    std::unique_lock<std::mutex> lock(m_mutex);
    if (!m_running)
    {
        return false;
    }
    m_lastAppendFlush = 0; // make the worker flush appends now
    m_wake.notify_one();
    return m_idle.wait_for(lock, std::chrono::milliseconds(aTimeoutMs),
                           [this] { return !m_running || (m_queue.empty() && !m_busy && m_appends.empty()); });
}

FileIoStats FileIo::Stats() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    FileIoStats stats = m_stats;
    stats.pending = m_queue.size();
    return stats;
}

void FileIo::SetControlFile(std::string aChannel, ControlCallback aCallback)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_controlChannel = std::move(aChannel);
    m_controlCallback = aCallback;
    m_controlKnown = false;
    m_nextControlTick = 0;
}

void FileIo::NoteOpTime(uint64_t aStartMicros)
{
    const uint64_t spent = NowMicros() - aStartMicros;
    std::lock_guard<std::mutex> lock(m_mutex);
    m_stats.maxOpMicros = std::max(m_stats.maxOpMicros, spent);
}

void FileIo::RunOp(Op& aOp)
{
    const uint64_t started = NowMicros();
    const std::wstring path = Path(aOp.channel);
    switch (aOp.kind)
    {
    case OpKind::Write:
    {
        const uint64_t hash = fileio::Hash(aOp.data);
        bool known = false;
        uint64_t wroteHash = 0;
        uint64_t wroteSize = 0;
        uint64_t wroteTime = 0;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            const Channel& channel = ChannelLocked(aOp.channel);
            known = channel.wroteKnown;
            wroteHash = channel.wroteHash;
            wroteSize = channel.wroteSize;
            wroteTime = channel.wroteTime;
        }
        uint64_t time = 0;
        uint64_t size = 0;
        if (known && wroteHash == hash && wroteSize == aOp.data.size() && fileio::StatFile(path, time, size) &&
            time == wroteTime && size == wroteSize)
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            ++m_stats.writesSkippedIdentical;
            return;
        }
        bool fallback = false;
        const bool ok = fileio::WriteAtomic(path, aOp.data, fallback);
        const bool statted = ok && fileio::StatFile(path, time, size);
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(aOp.channel);
        ++m_stats.writes;
        if (fallback)
        {
            ++m_stats.writeFallbacks;
        }
        if (!ok)
        {
            ++m_stats.writeFailures;
            channel.wroteKnown = false;
            CONVAI_WARN("File IO: write of %s failed (error %lu)", aOp.channel.c_str(), GetLastError());
        }
        else
        {
            channel.wroteKnown = statted;
            channel.wroteHash = hash;
            channel.wroteSize = aOp.data.size();
            channel.wroteTime = time;
            if (statted)
            {
                channel.diskTime = time;
                channel.diskSize = size;
            }
        }
        break;
    }
    case OpKind::Remove:
    {
        const bool ok = fileio::RemoveFile(path);
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(aOp.channel);
        ++m_stats.removes;
        channel.wroteKnown = false;
        channel.diskTime = 0;
        channel.diskSize = 0;
        if (!ok)
        {
            CONVAI_WARN("File IO: remove of %s failed", aOp.channel.c_str());
        }
        break;
    }
    case OpKind::Rename:
    {
        const bool ok = fileio::RenameFile(path, Path(aOp.target));
        std::lock_guard<std::mutex> lock(m_mutex);
        ++m_stats.renames;
        ChannelLocked(aOp.channel).wroteKnown = false;
        ChannelLocked(aOp.target).wroteKnown = false;
        ChannelLocked(aOp.target).diskTime = 0;
        if (!ok)
        {
            CONVAI_WARN("File IO: rename of %s to %s failed", aOp.channel.c_str(), aOp.target.c_str());
        }
        break;
    }
    }
    NoteOpTime(started);
}

void FileIo::PollDue(uint64_t aNow)
{
    struct Due
    {
        std::string name;
        bool json;
        bool force;
        uint64_t time;
        uint64_t size;
        bool fresh;
        uint64_t serial;
    };
    std::vector<Due> due;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        for (auto& [name, channel] : m_channels)
        {
            if (!channel.watched || channel.pendingOps > 0 || channel.nextPollTick > aNow)
            {
                continue;
            }
            const bool idle = aNow - channel.lastReadTick > kIdleAfterMs;
            const bool force = !idle && aNow - channel.lastForcedTick >= kForcedRereadMs;
            due.push_back(
                Due{name, channel.json, force, channel.diskTime, channel.diskSize, channel.diskFresh, channel.opSerial});
            channel.nextPollTick = aNow + (idle ? std::max<uint32_t>(channel.periodMs, kIdlePeriodMs) : channel.periodMs);
            if (force)
            {
                channel.lastForcedTick = aNow;
            }
        }
    }

    for (const Due& item : due)
    {
        const std::wstring path = Path(item.name);
        uint64_t time = 0;
        uint64_t size = 0;
        const bool present = fileio::StatFile(path, time, size);
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            ++m_stats.polls;
        }
        if (!present)
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            Channel& channel = ChannelLocked(item.name);
            if (channel.pendingOps == 0 && channel.opSerial == item.serial)
            {
                channel.diskTime = 0;
                channel.diskSize = 0;
                Publish(channel, false, {});
            }
            continue;
        }
        // An unchanged stat means unchanged bytes, unless the last write was so recent that a rewrite
        // could land in the same file-time tick (about 16 ms) with the same size.
        if (!item.force && !item.fresh && time == item.time && size == item.size && item.time != 0)
        {
            continue;
        }
        const uint64_t started = NowMicros();
        std::string content;
        bool exists = false;
        const bool read = fileio::ReadWhole(path, content, exists);
        NoteOpTime(started);
        std::lock_guard<std::mutex> lock(m_mutex);
        Channel& channel = ChannelLocked(item.name);
        if (channel.pendingOps > 0 || channel.opSerial != item.serial || !read)
        {
            channel.nextPollTick = aNow + 5; // our own op intervened, or a writer locked it: retry soon
            continue;
        }
        if (!exists)
        {
            channel.diskTime = 0;
            Publish(channel, false, {});
            continue;
        }
        if (item.json && !fileio::IsJson(content))
        {
            const uint64_t hash = fileio::Hash(content);
            channel.invalidStreak = hash == channel.invalidHash ? channel.invalidStreak + 1 : 1;
            channel.invalidHash = hash;
            ++m_stats.jsonRejected;
            if (channel.invalidStreak < kJsonPatience)
            {
                channel.diskTime = 0; // re-read next time even if the stat is unchanged
                channel.nextPollTick = aNow + std::min<uint32_t>(channel.periodMs, 15);
                continue;
            }
        }
        channel.invalidStreak = 0;
        channel.diskTime = time;
        channel.diskSize = size;
        channel.diskFresh = Fresh(time);
        Publish(channel, true, std::move(content));
    }
}

void FileIo::FlushAppends(bool aForce)
{
    std::unordered_map<std::string, std::string> appends;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        const uint64_t now = NowMs();
        if (m_appends.empty() ||
            (!aForce && m_appendBytes < kAppendFlushBytes && now - m_lastAppendFlush < kAppendFlushMs))
        {
            return;
        }
        appends.swap(m_appends);
        m_appendBytes = 0;
        m_lastAppendFlush = now;
    }
    for (const auto& [name, text] : appends)
    {
        const uint64_t started = NowMicros();
        const bool ok = fileio::AppendBytes(Path(name), text);
        NoteOpTime(started);
        std::lock_guard<std::mutex> lock(m_mutex);
        ++m_stats.appendsFlushed;
        if (!ok)
        {
            CONVAI_WARN("File IO: append to %s failed", name.c_str());
        }
    }
}

void FileIo::CheckControl(uint64_t aNow)
{
    std::string channel;
    ControlCallback callback = nullptr;
    uint64_t knownTime = 0;
    uint64_t knownSize = 0;
    bool known = false;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (!m_controlCallback || m_controlChannel.empty() || aNow < m_nextControlTick)
        {
            return;
        }
        m_nextControlTick = aNow + kControlPeriodMs;
        channel = m_controlChannel;
        callback = m_controlCallback;
        knownTime = m_controlTime;
        knownSize = m_controlSize;
        known = m_controlKnown;
    }
    const std::wstring path = Path(channel);
    uint64_t time = 0;
    uint64_t size = 0;
    const bool present = fileio::StatFile(path, time, size);
    if (known && ((present && time == knownTime && size == knownSize) || (!present && knownTime == 0)))
    {
        return;
    }
    std::string content;
    bool exists = false;
    if (present && !fileio::ReadWhole(path, content, exists))
    {
        return; // locked; try again next second
    }
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_controlKnown = true;
        m_controlTime = present ? time : 0;
        m_controlSize = present ? size : 0;
    }
    callback(content);
}

uint64_t FileIo::NextWake(uint64_t aNow)
{
    uint64_t wait = 250;
    for (const auto& [name, channel] : m_channels)
    {
        if (channel.watched && channel.pendingOps == 0)
        {
            wait = std::min(wait, channel.nextPollTick > aNow ? channel.nextPollTick - aNow : 1);
        }
    }
    if (!m_appends.empty())
    {
        const uint64_t due = m_lastAppendFlush + kAppendFlushMs;
        wait = std::min(wait, due > aNow ? due - aNow : 1);
    }
    if (m_controlCallback)
    {
        wait = std::min(wait, m_nextControlTick > aNow ? m_nextControlTick - aNow : 1);
    }
    return std::max<uint64_t>(wait, 1);
}

void FileIo::WorkerMain()
{
    SetThreadDescription(GetCurrentThread(), L"CyberpunkConvai file IO");
    // Below the game's threads: this work is never urgent at the millisecond scale.
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);

    std::unique_lock<std::mutex> lock(m_mutex);
    while (true)
    {
        if (!m_queue.empty())
        {
            Op op = std::move(m_queue.front());
            m_queue.pop_front();
            m_busy = true;
            lock.unlock();
            try
            {
                RunOp(op);
            }
            catch (...)
            {
                CONVAI_ERROR("File IO: an operation on %s threw", op.channel.c_str());
            }
            lock.lock();
            m_busy = false;
            auto release = [this](const std::string& aName) {
                auto it = m_channels.find(aName);
                if (it != m_channels.end())
                {
                    if (it->second.pendingOps > 0)
                    {
                        --it->second.pendingOps;
                    }
                    ++it->second.opSerial;
                }
            };
            release(op.channel);
            if (op.kind == OpKind::Rename)
            {
                release(op.target);
            }
            if (m_queue.empty() && m_appends.empty())
            {
                m_idle.notify_all();
            }
            continue;
        }

        const bool stopping = m_stopping;
        lock.unlock();
        try
        {
            const uint64_t now = NowMs();
            if (!stopping)
            {
                PollDue(now);
                CheckControl(now);
            }
            FlushAppends(stopping);
        }
        catch (...)
        {
            CONVAI_ERROR("File IO: the worker loop threw");
        }
        lock.lock();
        if (stopping && m_queue.empty() && m_appends.empty())
        {
            break;
        }
        if (!m_queue.empty())
        {
            continue;
        }
        if (m_appends.empty())
        {
            m_idle.notify_all();
        }
        if (m_stopping)
        {
            continue;
        }
        const uint64_t wait = NextWake(NowMs());
        m_wake.wait_for(lock, std::chrono::milliseconds(wait));
    }
    m_running = false;
    m_idle.notify_all();
}
} // namespace convai
