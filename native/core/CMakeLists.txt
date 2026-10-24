cmake_minimum_required(VERSION 3.21)

# CyberpunkConvaiNative: the RED4ext plugin that moves the mod's hot game-thread work out of CET
# Lua. See docs/NATIVE_REWRITE_PLAN.md. Build: scripts/Build-NativeCore.ps1 (MSVC 2022, x64).

project(CyberpunkConvaiNative VERSION 0.1.0 LANGUAGES C CXX)

if(NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "CyberpunkConvaiNative builds with MSVC for x64 only.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the DLL needs no Visual C++ redistributable on the player's machine.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# --- RED4ext.SDK, pinned per game variant ------------------------------------------------------
# Two variants are built from this one source tree (CONVAI_GAME), each with its own SDK pin and
# declaring only its own game runtime, so RED4ext refuses the wrong one without a message:
#   2.31 (default): the SDK commit with RED4EXT_V1_RUNTIME_VERSION_2_31 = 3.0.80.51928.
#   2.5:            the 2.5 fork commit (official #227 plus the #228 generated layouts, KelpHect/RED4ext.SDK-psiberx),
#                   RED4EXT_V1_RUNTIME_VERSION_2_50 = 3.0.88.46235. The 2.5 engine layouts differ (Callback 32 -> 64
#                   bytes, CBaseFunction, CStackFrame, ...), so a plugin must be built against this SDK for 2.5.
# Changing a pin is a deliberate act: bump it, rebuild, and run the in-game check in docs/NATIVE_REWRITE_PLAN.md.
set(CONVAI_GAME "2.31" CACHE STRING "Game variant to build for: 2.31 or 2.5")
set_property(CACHE CONVAI_GAME PROPERTY STRINGS "2.31" "2.5")
if(CONVAI_GAME STREQUAL "2.31")
  set(RED4EXT_SDK_COMMIT "ad7277714ad30d6885d7050c5ba24fa0102f6920")
  set(RED4EXT_SDK_REPOSITORY "https://github.com/WopsS/RED4ext.SDK.git")
elseif(CONVAI_GAME STREQUAL "2.5")
  set(RED4EXT_SDK_COMMIT "b139fcbd51b1c391399662f9fbfc00c5977f7231")
  set(RED4EXT_SDK_REPOSITORY "https://github.com/KelpHect/RED4ext.SDK-psiberx.git")
else()
  message(FATAL_ERROR "CONVAI_GAME must be 2.31 or 2.5, not '${CONVAI_GAME}'.")
endif()
set(RED4EXT_SDK_DIR "" CACHE PATH "A RED4ext.SDK checkout at the pinned commit (else it is fetched)")
set(RED4EXT_HEADER_ONLY ON CACHE BOOL "" FORCE)

if(RED4EXT_SDK_DIR)
  if(NOT EXISTS "${RED4EXT_SDK_DIR}/include/RED4ext/RED4ext.hpp")
    message(FATAL_ERROR "RED4EXT_SDK_DIR does not look like a RED4ext.SDK checkout: ${RED4EXT_SDK_DIR}")
  endif()
  add_subdirectory("${RED4EXT_SDK_DIR}" red4ext-sdk EXCLUDE_FROM_ALL)
else()
  include(FetchContent)
  FetchContent_Declare(
    red4ext_sdk
    GIT_REPOSITORY "${RED4EXT_SDK_REPOSITORY}"
    GIT_TAG "${RED4EXT_SDK_COMMIT}"
    GIT_SHALLOW FALSE
  )
  FetchContent_MakeAvailable(red4ext_sdk)
endif()

set(CONVAI_COMPILE_OPTIONS /W4 /permissive- /utf-8 /Zc:__cplusplus /Brepro /GS /guard:cf
    # /EHa: catch(...) in rtti::Guard also catches structured exceptions (access violations), so
    # a bad game pointer trips the system's kill switch instead of crashing the game.
    /EHa)
set(CONVAI_LINK_OPTIONS /Brepro /guard:cf /DYNAMICBASE /NXCOMPAT)

# --- Core library: no RED4ext dependency, so the headless tests run it without the game ---------
# A ported system keeps its game-free logic in src/systems/<name>/core/; it lands here, so its
# tests (tests/<name>_tests.cpp) link it without the SDK.
file(GLOB_RECURSE CONVAI_SYSTEM_CORE_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/systems/*/core/*.cpp")
add_library(convai_core STATIC
  src/core/FileIo.cpp
  src/core/Log.cpp
  src/core/Paths.cpp
  src/core/ScriptNames.cpp
  src/core/Signatures.cpp
  src/core/Switches.cpp
  ${CONVAI_SYSTEM_CORE_SOURCES}
  third_party/yyjson/yyjson.c
)
target_include_directories(convai_core PUBLIC src third_party/yyjson)
target_compile_definitions(convai_core PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
if(CONVAI_GAME STREQUAL "2.5")
  target_compile_definitions(convai_core PUBLIC CONVAI_GAME_2_5)
endif()
target_compile_options(convai_core PRIVATE $<$<COMPILE_LANGUAGE:CXX>:${CONVAI_COMPILE_OPTIONS}>
                                           $<$<COMPILE_LANGUAGE:C>:/Brepro /GS /guard:cf>)

# --- The plugin ---------------------------------------------------------------------------------
# Each system lives in src/systems/<name>/ and registers itself (plugin/Systems.hpp), so porting a
# new system never edits this file.
file(GLOB CONVAI_SYSTEM_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/systems/*/*.cpp")
add_library(CyberpunkConvaiNative SHARED
  src/plugin/Main.cpp
  src/plugin/Rtti.cpp
  src/plugin/CheckedCall.cpp
  src/plugin/GameAccess.cpp
  ${CONVAI_SYSTEM_SOURCES}
)
target_link_libraries(CyberpunkConvaiNative PRIVATE convai_core RED4ext::SDK)
target_compile_options(CyberpunkConvaiNative PRIVATE ${CONVAI_COMPILE_OPTIONS})
target_link_options(CyberpunkConvaiNative PRIVATE ${CONVAI_LINK_OPTIONS})

# --- Headless tests -----------------------------------------------------------------------------
enable_testing()
file(GLOB CONVAI_TEST_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tests/*_tests.cpp")
add_executable(convai_core_tests tests/TestMain.cpp ${CONVAI_TEST_SOURCES})
target_link_libraries(convai_core_tests PRIVATE convai_core)
# Parity fixtures recorded from the Lua implementations (tests/Fixture.hpp).
target_compile_definitions(convai_core_tests PRIVATE CONVAI_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
target_compile_options(convai_core_tests PRIVATE ${CONVAI_COMPILE_OPTIONS})
add_test(NAME core COMMAND convai_core_tests)

# Loads the DLL as RED4ext does up to Query (Main needs the game), and checks the exports.
add_executable(convai_plugin_host tests/plugin_host.cpp)
target_compile_options(convai_plugin_host PRIVATE ${CONVAI_COMPILE_OPTIONS})
add_test(NAME plugin_host COMMAND convai_plugin_host $<TARGET_FILE:CyberpunkConvaiNative>)
