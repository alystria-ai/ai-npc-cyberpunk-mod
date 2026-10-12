// Inspects CyberpunkConvaiNative.dll WITHOUT running any of its code.
//
// The DLL is mapped as an image resource (LOAD_LIBRARY_AS_IMAGE_RESOURCE): no DllMain, no static
// initializers, no RED4ext address resolution, so no "Address Resolver" message box can appear.
// Running the plugin needs the game; this test checks what can be checked from the file:
//   - it exports Supports, Query and Main (what RED4ext looks up);
//   - it imports only system DLLs (static CRT, no Visual C++ redistributable needed);
//   - it carries the RED4ext v1 PluginInfo name string.
// The declared game runtime (2.31) is a compile-time constant in src/plugin/Main.cpp.
//
// Usage: convai_plugin_host <CyberpunkConvaiNative.dll>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace
{
int failures = 0;

void Check(bool aOk, const char* aWhat)
{
    std::printf("  %s %s\n", aOk ? "ok  " : "FAIL", aWhat);
    failures += aOk ? 0 : 1;
}

const IMAGE_NT_HEADERS64* Headers(const uint8_t* aBase)
{
    auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(aBase);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE)
    {
        return nullptr;
    }
    auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(aBase + dos->e_lfanew);
    return nt->Signature == IMAGE_NT_SIGNATURE && nt->FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 ? nt : nullptr;
}

std::vector<std::string> Exports(const uint8_t* aBase, const IMAGE_NT_HEADERS64* aNt)
{
    std::vector<std::string> names;
    const auto& directory = aNt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (!directory.VirtualAddress)
    {
        return names;
    }
    auto* exports = reinterpret_cast<const IMAGE_EXPORT_DIRECTORY*>(aBase + directory.VirtualAddress);
    auto* nameRvas = reinterpret_cast<const DWORD*>(aBase + exports->AddressOfNames);
    for (DWORD i = 0; i < exports->NumberOfNames; ++i)
    {
        names.emplace_back(reinterpret_cast<const char*>(aBase + nameRvas[i]));
    }
    return names;
}

std::string Imports(const uint8_t* aBase, const IMAGE_NT_HEADERS64* aNt)
{
    const auto& directory = aNt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    std::string names;
    if (!directory.VirtualAddress)
    {
        return names;
    }
    for (auto* entry = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(aBase + directory.VirtualAddress); entry->Name;
         ++entry)
    {
        names += reinterpret_cast<const char*>(aBase + entry->Name);
        names += ' ';
    }
    return names;
}

bool ContainsWide(const uint8_t* aBase, size_t aSize, const wchar_t* aText)
{
    const size_t bytes = std::wcslen(aText) * sizeof(wchar_t);
    for (size_t i = 0; i + bytes <= aSize; i += 2)
    {
        if (std::memcmp(aBase + i, aText, bytes) == 0)
        {
            return true;
        }
    }
    return false;
}
} // namespace

int wmain(int argc, wchar_t** argv)
{
    if (argc != 2)
    {
        std::printf("usage: convai_plugin_host <dll>\n");
        return 2;
    }
    HMODULE mapped = LoadLibraryExW(argv[1], nullptr, LOAD_LIBRARY_AS_IMAGE_RESOURCE);
    Check(mapped != nullptr, "map the DLL as an image resource (no code runs)");
    if (!mapped)
    {
        return 1;
    }
    // The loader tags resource mappings in the low bits of the handle.
    auto* base = reinterpret_cast<const uint8_t*>(reinterpret_cast<uintptr_t>(mapped) & ~static_cast<uintptr_t>(3));
    const IMAGE_NT_HEADERS64* nt = Headers(base);
    Check(nt != nullptr, "x64 PE image");
    if (nt)
    {
        const auto exports = Exports(base, nt);
        auto has = [&](const char* aName) {
            for (const auto& name : exports)
            {
                if (name == aName)
                {
                    return true;
                }
            }
            return false;
        };
        Check(has("Supports") && has("Query") && has("Main"), "exports Supports, Query, Main");
        const std::string imports = Imports(base, nt);
        std::printf("  imports: %s\n", imports.c_str());
        const bool crtFree = imports.find("VCRUNTIME") == std::string::npos &&
                             imports.find("MSVCP") == std::string::npos &&
                             imports.find("api-ms-win-crt") == std::string::npos;
        Check(crtFree, "static CRT (no VCRUNTIME/MSVCP/ucrt imports)");
        Check(imports.find("RED4ext") == std::string::npos, "no load-time import of RED4ext.dll");
        Check(ContainsWide(base, nt->OptionalHeader.SizeOfImage, L"CyberpunkConvaiNative"), "plugin name string");
        Check((nt->OptionalHeader.DllCharacteristics & IMAGE_DLLCHARACTERISTICS_GUARD_CF) != 0, "control flow guard");
    }
    FreeLibrary(mapped);
    std::printf("%s\n", failures ? "FAILED" : "passed");
    return failures ? 1 : 0;
}
