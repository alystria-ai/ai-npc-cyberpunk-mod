/*
 * AI NPC Cyberpunk Mod launcher: a RED4ext plugin that starts the conversation
 * service supervisor when Cyberpunk 2077 starts with the mod installed.
 *
 * RED4ext is used only as a loader. The plugin reads no game memory, installs
 * no hooks and declares itself runtime independent, so game patches do not
 * affect it. It never fails the game: every problem is logged next to the DLL
 * and published to the mod's runtime folder, then Main returns true.
 *
 * Lifetime: the supervisor's stdin is the read end of an anonymous pipe whose
 * write end stays open, non-inheritable, inside the game process. Windows
 * closes it when the game exits for any reason (quit, crash, kill), so the
 * supervisor sees end-of-file immediately and stops the bridge. No polling,
 * no process-name lookup, and no PID-reuse ambiguity.
 *
 * launcher.ini (UTF-16LE with BOM, next to the DLL):
 *   [launch]
 *   enabled=1
 *   program=<absolute path to node.exe>          (%GAME% and %PLUGIN% expand)
 *   arg1=<supervisor script>  arg2=... argN=...   (each value is one argument)
 *   working_directory=<optional absolute path>
 * The plugin appends: --game-pid <pid> --game-root <root> --lifeline stdin
 *
 * The file is optional. A Vortex install (a 0.2.3 report: "launcher-not-configured") can end up with the DLL in the plugin folder and no
 * launcher.ini beside it (a partial update, a purge, a deployment that missed it). Without the file, or with one that names no program,
 * the launcher starts the Runtime exactly as the shipped launcher.ini says (the DEFAULT_* values below, kept equal to
 * packaging/lib/launcher-ini.mjs by bridge/autostart-plugin.test.mjs). enabled=0 still turns it off when the file is there.
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* RED4ext.SDK API v1 (include/RED4ext/Api/v1). Layouts must stay identical. */
typedef struct { uint32_t type; uint32_t number; } R4ePrerelease;
typedef struct { uint8_t major; uint16_t minor; uint32_t patch; R4ePrerelease prerelease; } R4eSemVer;
typedef struct { uint16_t major; uint16_t minor; uint16_t build; uint16_t revision; } R4eFileVer;
typedef struct {
    R4eSemVer sdk;
    const wchar_t *name;
    const wchar_t *author;
    R4eSemVer version;
    R4eFileVer runtime;
} R4ePluginInfo;

_Static_assert(sizeof(R4eSemVer) == 16, "SemVer size");
_Static_assert(offsetof(R4eSemVer, minor) == 2 && offsetof(R4eSemVer, patch) == 4
    && offsetof(R4eSemVer, prerelease) == 8, "SemVer fields");
_Static_assert(sizeof(R4eFileVer) == 8, "FileVer size");
_Static_assert(offsetof(R4ePluginInfo, name) == 16 && offsetof(R4ePluginInfo, author) == 24
    && offsetof(R4ePluginInfo, version) == 32 && offsetof(R4ePluginInfo, runtime) == 48
    && sizeof(R4ePluginInfo) == 56, "PluginInfo layout");

#define LAUNCHER_VERSION_MAJOR 1
#define LAUNCHER_VERSION_MINOR 0
#define LAUNCHER_VERSION_PATCH 1
#define PATH_CAP 1024
#define VALUE_CAP 1024
#define COMMAND_CAP 16384
#define MAX_ARGS 24
#define MOD_RELATIVE L"\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\AiNpcCyberpunkMod"

/* What the shipped launcher.ini says (packaging/lib/launcher-ini.mjs); used when launcher.ini is missing or names no program. */
#define DEFAULT_PROGRAM L"%PLUGIN%\\app\\node\\node.exe"
#define DEFAULT_ARG_COUNT 3
#define DEFAULT_ARG1 L"--eval"
#define DEFAULT_ARG2 L"const f=require('node:fs');let p=process.argv[1];try{f.statSync(p)}catch{try{p=f.realpathSync.native(p)}catch{}}" \
    L"import(require('node:url').pathToFileURL(p).href)"
#define DEFAULT_ARG3 L"%PLUGIN%\\app\\launcher\\start-service.mjs"
#define DEFAULT_DIRECTORY L"%PLUGIN%\\app"
static const wchar_t *const DEFAULT_ARGS[DEFAULT_ARG_COUNT] = {DEFAULT_ARG1, DEFAULT_ARG2, DEFAULT_ARG3};

static HANDLE g_lifeline = NULL; /* Write end. Deliberately never closed. */
static bool g_started = false;
static HANDLE g_log = INVALID_HANDLE_VALUE;

static void log_line(const wchar_t *format, ...) {
    if (g_log == INVALID_HANDLE_VALUE) return;
    wchar_t text[2048];
    SYSTEMTIME now;
    GetLocalTime(&now);
    int prefix = _snwprintf_s(text, _countof(text), _TRUNCATE, L"%04u-%02u-%02u %02u:%02u:%02u ",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    if (prefix < 0) return;
    va_list args;
    va_start(args, format);
    int body = _vsnwprintf_s(text + prefix, _countof(text) - prefix, _TRUNCATE, format, args);
    va_end(args);
    if (body < 0) body = (int)wcslen(text + prefix);
    size_t length = (size_t)prefix + (size_t)body;
    if (length + 2 < _countof(text)) { text[length++] = L'\r'; text[length++] = L'\n'; }
    char utf8[6144];
    int bytes = WideCharToMultiByte(CP_UTF8, 0, text, (int)length, utf8, (int)sizeof(utf8), NULL, NULL);
    DWORD written = 0;
    if (bytes > 0) WriteFile(g_log, utf8, (DWORD)bytes, &written, NULL);
}

/* File APIs reject paths of MAX_PATH or more unless they use the \\?\ form. */
static const wchar_t *native_path(const wchar_t *path, wchar_t *buffer, size_t capacity) {
    if (wcslen(path) < MAX_PATH - 12) return path;
    if (path[0] && path[1] == L':' && path[2] == L'\\') {
        if (_snwprintf_s(buffer, capacity, _TRUNCATE, L"\\\\?\\%ls", path) >= 0) return buffer;
    } else if (path[0] == L'\\' && path[1] == L'\\' && path[2] != L'?') {
        if (_snwprintf_s(buffer, capacity, _TRUNCATE, L"\\\\?\\UNC\\%ls", path + 2) >= 0) return buffer;
    }
    return path;
}
#define NATIVE(path, buffer) native_path((path), (buffer), _countof(buffer))

static bool file_exists(const wchar_t *path) {
    wchar_t buffer[PATH_CAP + 16];
    DWORD attributes = GetFileAttributesW(NATIVE(path, buffer));
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static bool directory_exists(const wchar_t *path) {
    wchar_t buffer[PATH_CAP + 16];
    DWORD attributes = GetFileAttributesW(NATIVE(path, buffer));
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static bool strip_component(wchar_t *path) {
    wchar_t *slash = wcsrchr(path, L'\\');
    if (!slash || slash == path) return false;
    *slash = L'\0';
    return true;
}

static bool join(wchar_t *out, size_t capacity, const wchar_t *left, const wchar_t *right) {
    return _snwprintf_s(out, capacity, _TRUNCATE, L"%ls%ls", left, right) >= 0;
}

/* Replace %GAME% and %PLUGIN% tokens. Returns false when the result is too long. */
static bool expand(const wchar_t *value, const wchar_t *game, const wchar_t *plugin, wchar_t *out, size_t capacity) {
    size_t used = 0;
    for (const wchar_t *cursor = value; *cursor;) {
        const wchar_t *insert = NULL;
        size_t skip = 0;
        if (wcsncmp(cursor, L"%GAME%", 6) == 0) { insert = game; skip = 6; }
        else if (wcsncmp(cursor, L"%PLUGIN%", 8) == 0) { insert = plugin; skip = 8; }
        if (insert) {
            size_t length = wcslen(insert);
            if (used + length >= capacity) return false;
            wmemcpy(out + used, insert, length);
            used += length; cursor += skip;
        } else {
            if (used + 1 >= capacity) return false;
            out[used++] = *cursor++;
        }
    }
    out[used] = L'\0';
    return true;
}

/* Append one argument using the MSVC runtime quoting rules (CommandLineToArgvW). */
static bool append_argument(wchar_t *command, size_t capacity, const wchar_t *argument) {
    size_t used = wcslen(command);
    bool quote = argument[0] == L'\0' || wcspbrk(argument, L" \t\n\v\"") != NULL;
#define PUT(ch) do { if (used + 1 >= capacity) return false; command[used++] = (ch); } while (0)
    if (used > 0) PUT(L' ');
    if (!quote) {
        for (const wchar_t *c = argument; *c; ++c) PUT(*c);
    } else {
        PUT(L'"');
        for (const wchar_t *c = argument;; ++c) {
            size_t slashes = 0;
            while (*c == L'\\') { ++slashes; ++c; }
            if (*c == L'\0') { for (size_t i = 0; i < slashes * 2; ++i) PUT(L'\\'); break; }
            if (*c == L'"') { for (size_t i = 0; i < slashes * 2 + 1; ++i) PUT(L'\\'); PUT(L'"'); }
            else { for (size_t i = 0; i < slashes; ++i) PUT(L'\\'); PUT(*c); }
        }
        PUT(L'"');
    }
#undef PUT
    command[used] = L'\0';
    return true;
}

static uint64_t epoch_milliseconds(void) {
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER value;
    value.LowPart = now.dwLowDateTime; value.HighPart = now.dwHighDateTime;
    return (value.QuadPart - 116444736000000000ULL) / 10000ULL;
}

/* The mod reads this file to explain a missing service in game. Plain ASCII codes only. */
static void publish_status(const wchar_t *mod, const char *state, const char *code, DWORD pid, DWORD error) {
    wchar_t runtime[PATH_CAP], target[PATH_CAP], temporary[PATH_CAP];
    wchar_t nativeRuntime[PATH_CAP + 16], nativeTarget[PATH_CAP + 16], nativeTemporary[PATH_CAP + 16];
    if (!join(runtime, PATH_CAP, mod, L"\\runtime")) return;
    if (!directory_exists(runtime) && !CreateDirectoryW(NATIVE(runtime, nativeRuntime), NULL)) return;
    if (!join(target, PATH_CAP, runtime, L"\\bridge-service.json")) return;
    if (_snwprintf_s(temporary, PATH_CAP, _TRUNCATE, L"%ls.launcher-%lu.tmp", target, GetCurrentProcessId()) < 0) return;
    uint64_t now = epoch_milliseconds();
    char json[512];
    int length = _snprintf_s(json, sizeof(json), _TRUNCATE,
        "{\"version\":1,\"state\":\"%s\",\"code\":\"%s\",\"source\":\"launcher\",\"supervisorPid\":%lu,"
        "\"error\":%lu,\"gamePid\":%lu,\"since\":%llu,\"updated\":%llu}",
        state, code, pid, error, GetCurrentProcessId(), (unsigned long long)now, (unsigned long long)now);
    if (length <= 0) return;
    const wchar_t *temporaryPath = NATIVE(temporary, nativeTemporary);
    HANDLE file = CreateFileW(temporaryPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    BOOL ok = WriteFile(file, json, (DWORD)length, &written, NULL) && written == (DWORD)length;
    CloseHandle(file);
    if (!ok || !MoveFileExW(temporaryPath, NATIVE(target, nativeTarget), MOVEFILE_REPLACE_EXISTING)) DeleteFileW(temporaryPath);
}

static void launch(HMODULE self) {
    wchar_t game[PATH_CAP], plugin[PATH_CAP], mod[PATH_CAP], path[PATH_CAP], ini[PATH_CAP];
    DWORD length = GetModuleFileNameW(NULL, game, PATH_CAP);
    if (length == 0 || length >= PATH_CAP) return;
    /* <game>\bin\x64\Cyberpunk2077.exe -> <game> */
    if (!strip_component(game) || !strip_component(game) || !strip_component(game)) return;
    length = GetModuleFileNameW(self, plugin, PATH_CAP);
    if (length == 0 || length >= PATH_CAP || !strip_component(plugin)) return;
    wchar_t nativeLog[PATH_CAP + 16];
    if (!join(path, PATH_CAP, plugin, L"\\launcher.log")) return;
    g_log = CreateFileW(NATIVE(path, nativeLog), GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL);
    log_line(L"CyberpunkConvaiLauncher %d.%d.%d in game process %lu", LAUNCHER_VERSION_MAJOR,
        LAUNCHER_VERSION_MINOR, LAUNCHER_VERSION_PATCH, GetCurrentProcessId());
    log_line(L"Game directory: %ls", game);

    /* Start only when the mod can actually run: CET and the CyberpunkConvai mod are installed. */
    if (!join(mod, PATH_CAP, game, MOD_RELATIVE)) return;
    if (!join(path, PATH_CAP, mod, L"\\init.lua") || !file_exists(path)) {
        log_line(L"Skipped: the CyberpunkConvai CET mod is not installed (%ls).", path);
        return;
    }
    if (!join(path, PATH_CAP, game, L"\\bin\\x64\\plugins\\cyber_engine_tweaks.asi") || !file_exists(path)) {
        log_line(L"Skipped: Cyber Engine Tweaks is not installed, so the mod cannot run.");
        return;
    }

    /* launcher.ini is optional (see the top of this file): without it the shipped settings apply, and the first line of the log says so. */
    bool built_in = !join(ini, PATH_CAP, plugin, L"\\launcher.ini") || !file_exists(ini);
    if (built_in) {
        log_line(L"launcher.ini is missing next to the launcher: using the built-in settings (the Runtime's own node and service).");
    } else if (GetPrivateProfileIntW(L"launch", L"enabled", 1, ini) == 0) {
        log_line(L"Not started: disabled in launcher.ini (enabled=0).");
        return;
    }

    wchar_t raw[VALUE_CAP], program[PATH_CAP], directory[PATH_CAP], argument[VALUE_CAP];
    DWORD read = 0;
    if (!built_in) {
        read = GetPrivateProfileStringW(L"launch", L"program", L"", raw, VALUE_CAP, ini);
        if (read == 0) {
            built_in = true;
            log_line(L"launcher.ini names no program: using the built-in settings (the Runtime's own node and service).");
        }
    }
    if (built_in) wcscpy_s(raw, VALUE_CAP, DEFAULT_PROGRAM);
    if (read >= VALUE_CAP - 1 || !expand(raw, game, plugin, program, PATH_CAP)
        || wcschr(program, L'"') || !file_exists(program)) {
        log_line(L"Not started: the configured program is missing or invalid (%ls).", raw);
        publish_status(mod, "failed", "launcher-program-missing", 0, ERROR_FILE_NOT_FOUND);
        return;
    }
    directory[0] = L'\0';
    if (built_in) { read = 0; wcscpy_s(raw, VALUE_CAP, DEFAULT_DIRECTORY); }
    else read = GetPrivateProfileStringW(L"launch", L"working_directory", L"", raw, VALUE_CAP, ini);
    if (read >= VALUE_CAP - 1 || ((built_in || read > 0) && (!expand(raw, game, plugin, directory, PATH_CAP)
        || !directory_exists(directory)))) {
        log_line(L"Not started: the configured working directory is missing (%ls).", raw);
        publish_status(mod, "failed", "launcher-directory-missing", 0, ERROR_PATH_NOT_FOUND);
        return;
    }

    static wchar_t command[COMMAND_CAP];
    command[0] = L'\0';
    if (!append_argument(command, COMMAND_CAP, program)) return;
    for (int index = 1; index <= MAX_ARGS; ++index) {
        wchar_t key[16];
        _snwprintf_s(key, _countof(key), _TRUNCATE, L"arg%d", index);
        if (built_in) {
            if (index > DEFAULT_ARG_COUNT) break;
            wcscpy_s(raw, VALUE_CAP, DEFAULT_ARGS[index - 1]);
            read = (DWORD)wcslen(raw);
        } else {
            read = GetPrivateProfileStringW(L"launch", key, L"", raw, VALUE_CAP, ini);
            if (read == 0) break;
        }
        if (read >= VALUE_CAP - 1 || !expand(raw, game, plugin, argument, VALUE_CAP)
            || !append_argument(command, COMMAND_CAP, argument)) {
            log_line(L"Not started: %ls in launcher.ini is too long.", key);
            publish_status(mod, "failed", "launcher-not-configured", 0, ERROR_INVALID_DATA);
            return;
        }
    }
    wchar_t pid[16];
    _snwprintf_s(pid, _countof(pid), _TRUNCATE, L"%lu", GetCurrentProcessId());
    if (!append_argument(command, COMMAND_CAP, L"--game-pid") || !append_argument(command, COMMAND_CAP, pid)
        || !append_argument(command, COMMAND_CAP, L"--game-root") || !append_argument(command, COMMAND_CAP, game)
        || !append_argument(command, COMMAND_CAP, L"--lifeline") || !append_argument(command, COMMAND_CAP, L"stdin")) {
        log_line(L"Not started: the command line is too long.");
        publish_status(mod, "failed", "launcher-not-configured", 0, ERROR_INVALID_DATA);
        return;
    }

    SECURITY_ATTRIBUTES inheritable = {sizeof(inheritable), NULL, TRUE};
    HANDLE readEnd = NULL, writeEnd = NULL, nul = INVALID_HANDLE_VALUE;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    PROCESS_INFORMATION process = {0};
    DWORD error = 0;
    bool started = false, breakaway = true;

    if (!CreatePipe(&readEnd, &writeEnd, &inheritable, 0)) { error = GetLastError(); goto done; }
    /* Only the child's read end is inheritable; the game keeps the only write end. */
    if (!SetHandleInformation(writeEnd, HANDLE_FLAG_INHERIT, 0)) { error = GetLastError(); goto done; }
    nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inheritable, OPEN_EXISTING, 0, NULL);
    if (nul == INVALID_HANDLE_VALUE) { error = GetLastError(); goto done; }

    /* Inherit exactly these two handles, never the game's other inheritable handles. */
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, size);
    if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &size)) {
        error = GetLastError();
        if (attributes) { HeapFree(GetProcessHeap(), 0, attributes); attributes = NULL; }
        goto done;
    }
    HANDLE inherited[2] = {readEnd, nul};
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
        sizeof(inherited), NULL, NULL)) { error = GetLastError(); goto done; }

    STARTUPINFOEXW startup;
    ZeroMemory(&startup, sizeof(startup));
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = readEnd;
    startup.StartupInfo.hStdOutput = nul;
    startup.StartupInfo.hStdError = nul;
    startup.lpAttributeList = attributes;
    /* A hidden console (CREATE_NO_WINDOW) is inherited by every console child, so no window appears. */
    DWORD flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    const wchar_t *workingDirectory = directory[0] ? directory : NULL;
    /* Leave the launcher's job when allowed, so the service never keeps the game "running". */
    if (CreateProcessW(program, command, NULL, NULL, TRUE, flags | CREATE_BREAKAWAY_FROM_JOB, NULL,
        workingDirectory, &startup.StartupInfo, &process)) {
        started = true;
    } else {
        error = GetLastError();
        if (error == ERROR_ACCESS_DENIED) {
            breakaway = false;
            if (CreateProcessW(program, command, NULL, NULL, TRUE, flags, NULL, workingDirectory,
                &startup.StartupInfo, &process)) { started = true; error = 0; }
            else error = GetLastError();
        }
    }

done:
    if (attributes) { DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); }
    if (readEnd) CloseHandle(readEnd);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (started) {
        g_lifeline = writeEnd; /* Closed by Windows when this game process ends. */
        log_line(L"Started the conversation service supervisor (PID %lu, %ls).", process.dwProcessId,
            breakaway ? L"outside the launcher job" : L"inside the launcher job");
        log_line(L"Command: %ls", command);
        publish_status(mod, "starting", "launcher-started", process.dwProcessId, 0);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    } else {
        if (writeEnd) CloseHandle(writeEnd);
        log_line(L"Not started: CreateProcess failed with Windows error %lu. Command: %ls", error, command);
        publish_status(mod, "failed", "launcher-failed", 0, error);
    }
}

__declspec(dllexport) uint32_t Supports(void) {
    /* RED4EXT_API_VERSION_1. With the 0.5.0 SDK field below this matches what the
     * installed audioware plugin reports to RED4ext 1.30, which loads it. */
    return 1;
}

__declspec(dllexport) void Query(R4ePluginInfo *info) {
    const R4eSemVer sdk = {0, 5, 0, {0, 0}}; /* RED4EXT_V1_SDK_VERSION_1_0_0_COMPAT_0_5_0 */
    const R4eSemVer version = {LAUNCHER_VERSION_MAJOR, LAUNCHER_VERSION_MINOR, LAUNCHER_VERSION_PATCH, {0, 0}};
    const R4eFileVer independent = {0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF}; /* RED4EXT_V1_RUNTIME_VERSION_INDEPENDENT */
    info->sdk = sdk;
    info->name = L"CyberpunkConvaiLauncher";
    info->author = L"AI NPC Cyberpunk Mod";
    info->version = version;
    info->runtime = independent;
}

/* EMainReason is an 8-bit enum: Load = 0, Unload = 1. */
__declspec(dllexport) bool Main(HMODULE handle, uint8_t reason, const void *sdk) {
    (void)sdk;
    if (reason == 0 && !g_started) {
        g_started = true;
        launch(handle);
        if (g_log != INVALID_HANDLE_VALUE) { CloseHandle(g_log); g_log = INVALID_HANDLE_VALUE; }
    }
    /* Unload: nothing to do. The lifeline closes when the process exits. */
    return true;
}
