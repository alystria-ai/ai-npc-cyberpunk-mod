/*
 * Test stand-in for Cyberpunk2077.exe. It is a GUI-subsystem program without a
 * console, like the game, and loads the launcher exactly as RED4ext does:
 * Supports, Query, then Main(Load) and, on a normal exit, Main(Unload).
 *
 * Usage: Cyberpunk2077.exe <plugin.dll> <result.json> <hold-milliseconds>
 * Creating <result.json>.exit ends the hold early (a normal game exit).
 * Place it at <fake game>\bin\x64\Cyberpunk2077.exe; the plugin derives the
 * game directory from this executable's path.
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { uint32_t type; uint32_t number; } R4ePrerelease;
typedef struct { uint8_t major; uint16_t minor; uint32_t patch; R4ePrerelease prerelease; } R4eSemVer;
typedef struct { uint16_t major; uint16_t minor; uint16_t build; uint16_t revision; } R4eFileVer;
typedef struct { R4eSemVer sdk; const wchar_t *name; const wchar_t *author; R4eSemVer version; R4eFileVer runtime; } R4ePluginInfo;
typedef uint32_t (*SupportsFn)(void);
typedef void (*QueryFn)(R4ePluginInfo *);
typedef bool (*MainFn)(HMODULE, uint8_t, const void *);

static void write_result(const wchar_t *path, const char *json) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(file, json, (DWORD)strlen(json), &written, NULL);
    CloseHandle(file);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR line, int show) {
    (void)instance; (void)previous; (void)line; (void)show;
    int count = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!argv || count != 4) return 2;
    HMODULE plugin = LoadLibraryExW(argv[1], NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!plugin) { write_result(argv[2], "{\"error\":\"load-library\"}"); return 3; }
    SupportsFn supports = (SupportsFn)GetProcAddress(plugin, "Supports");
    QueryFn query = (QueryFn)GetProcAddress(plugin, "Query");
    MainFn main_fn = (MainFn)GetProcAddress(plugin, "Main");
    if (!supports || !query || !main_fn) { write_result(argv[2], "{\"error\":\"exports\"}"); return 4; }
    R4ePluginInfo info;
    memset(&info, 0xCD, sizeof(info));
    query(&info);
    char name[128] = "", author[128] = "";
    WideCharToMultiByte(CP_UTF8, 0, info.name, -1, name, sizeof(name), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, info.author, -1, author, sizeof(author), NULL, NULL);
    uint32_t api = supports();
    bool loaded = main_fn(plugin, 0, NULL);
    char json[1024];
    _snprintf_s(json, sizeof(json), _TRUNCATE,
        "{\"api\":%u,\"sdk\":[%u,%u,%u,%u,%u],\"name\":\"%s\",\"author\":\"%s\",\"version\":[%u,%u,%u,%u,%u],"
        "\"runtime\":[%u,%u,%u,%u],\"load\":%s,\"pid\":%lu}",
        api, info.sdk.major, info.sdk.minor, info.sdk.patch, info.sdk.prerelease.type, info.sdk.prerelease.number,
        name, author, info.version.major, info.version.minor, info.version.patch, info.version.prerelease.type,
        info.version.prerelease.number, info.runtime.major, info.runtime.minor, info.runtime.build,
        info.runtime.revision, loaded ? "true" : "false", GetCurrentProcessId());
    write_result(argv[2], json);
    /* Exit normally after hold-milliseconds, or earlier once <result>.exit exists. */
    wchar_t stop[1024];
    _snwprintf_s(stop, _countof(stop), _TRUNCATE, L"%ls.exit", argv[2]);
    for (ULONGLONG end = GetTickCount64() + (ULONGLONG)_wtoi(argv[3]); GetTickCount64() < end;) {
        if (GetFileAttributesW(stop) != INVALID_FILE_ATTRIBUTES) break;
        Sleep(50);
    }
    main_fn(plugin, 1, NULL);
    FreeLibrary(plugin);
    LocalFree(argv);
    return 0;
}
