#pragma once

// Self-registering systems. Each ported system adds one translation unit under
// src/systems/<name>/ that declares itself with CONVAI_SYSTEM; nothing shared needs editing, so
// several systems can be ported in parallel without merge conflicts. CMake globs the folder.
//
//   CONVAI_SYSTEM(example, {
//       .name = "example",                       // kill-switch name, Lua: convaiNative.use('example')
//       .registerTypes = &RegisterTypes,         // RTTI register callback (classes)
//       .postRegisterTypes = &PostRegisterTypes, // RTTI post-register callback (functions)
//       .start = &Start,                         // optional, after the core services start
//       .stop = &Stop,                           // optional, before they stop (reverse order)
//   });

#include <vector>

namespace convai::systems
{
struct System
{
    const char* name = nullptr;
    void (*registerTypes)() = nullptr;
    void (*postRegisterTypes)() = nullptr;
    void (*start)() = nullptr;
    void (*stop)() = nullptr;
};

std::vector<System>& All();

struct Registrar
{
    explicit Registrar(const System& aSystem)
    {
        All().push_back(aSystem);
    }
};
} // namespace convai::systems

#define CONVAI_SYSTEM(id, ...) static const ::convai::systems::Registrar g_convaiSystem_##id{::convai::systems::System __VA_ARGS__}
