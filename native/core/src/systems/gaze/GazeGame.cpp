#include "GazeGame.hpp"

#include "plugin/GameAccess.hpp"

#include "core/Log.hpp"

#include <RED4ext/RTTISystem.hpp>
#include <RED4ext/Scripting/CProperty.hpp>
#include <RED4ext/Scripting/Functions.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>

#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <string>

namespace convai::gaze
{
namespace
{
using RED4ext::CBaseFunction;
using RED4ext::CClass;
using RED4ext::CEnum;
using RED4ext::CName;
using RED4ext::CProperty;
using RED4ext::CRTTIBaseArrayType;
namespace rt = RED4ext::rtti;

// Leaked on purpose: no destructor runs under the loader lock.
std::string& ProblemText()
{
    static std::string* text = new std::string();
    return *text;
}

// Everything the request needs, resolved by name once. A miss anywhere leaves ok=false and the
// reason in ProblemText(); nothing is guessed.
struct Layout
{
    bool resolved = false;
    bool ok = false;

    CClass* eventClass = nullptr;
    CBaseFunction* setTarget = nullptr;
    CBaseFunction* setStyle = nullptr;
    CBaseFunction* setParts = nullptr;
    CProperty* bodyPart = nullptr;
    CProperty* provider = nullptr;

    CProperty* request = nullptr;
    CProperty* limits = nullptr;
    CClass* requestClass = nullptr;
    CClass* limitsClass = nullptr;
    CProperty* soft = nullptr;
    CProperty* hard = nullptr;
    CProperty* back = nullptr;
    CProperty* distance = nullptr;
    CProperty* parentSpace = nullptr; // request.calculatePositionInParentSpace, optional

    CClass* partClass = nullptr;
    CRTTIBaseArrayType* partsType = nullptr;
    CProperty* partName = nullptr;
    CProperty* partWeight = nullptr;
    CProperty* partSuppress = nullptr;
    CProperty* partMode = nullptr;

    CEnum* styleEnum = nullptr;
};

constinit Layout g_layout;

// The names a class really has, written to the log when the layout does not match, so the next
// build can be fixed from one log line instead of a guess. Read-only, bounded.
std::string Describe(const CClass* aClass)
{
    if (!aClass)
    {
        return std::string();
    }
    std::string text = std::string(" [") + aClass->name.ToString() + " props:";
    for (uint32_t i = 0; i < aClass->props.Size() && i < 48; ++i)
    {
        const CProperty* property = aClass->props[i];
        if (property && property->type)
        {
            text += std::string(" ") + property->name.ToString() + "(" + property->type->GetName().ToString() + ")";
        }
    }
    text += " funcs:";
    for (uint32_t i = 0; i < aClass->funcs.Size() && i < 48; ++i)
    {
        const auto* function = aClass->funcs[i];
        if (function)
        {
            text += std::string(" ") + function->shortName.ToString() + "/" + std::to_string(function->params.Size());
        }
    }
    return text + "]";
}

bool Miss(const std::string& aWhat, const CClass* aClass = nullptr)
{
    ProblemText() = aWhat;
    CONVAI_WARN("Gaze: %s%s", aWhat.c_str(), Describe(aClass).c_str());
    return false;
}

CProperty* Property(CClass* aClass, const char* aName)
{
    return aClass ? aClass->GetProperty(aName) : nullptr;
}

CClass* ClassOf(const CProperty* aProperty)
{
    if (!aProperty || !aProperty->type || aProperty->type->GetType() != rt::ERTTIType::Class)
    {
        return nullptr;
    }
    return static_cast<CClass*>(aProperty->type);
}

bool IsFundamental(const rt::IType* aType, const char* aName)
{
    return aType && aType->GetType() == rt::ERTTIType::Fundamental &&
           std::strcmp(aType->GetName().ToString(), aName) == 0;
}

// Numeric fields: Float, Double, the integer types, Bool, and enums (written by their size).
bool IsNumeric(const rt::IType* aType)
{
    if (!aType)
    {
        return false;
    }
    if (aType->GetType() == rt::ERTTIType::Enum)
    {
        return true;
    }
    static const char* const names[] = {"Float", "Double", "Int8",  "Uint8",  "Int16", "Uint16",
                                        "Int32", "Uint32", "Int64", "Uint64", "Bool"};
    for (const char* name : names)
    {
        if (IsFundamental(aType, name))
        {
            return true;
        }
    }
    return false;
}

// A property of a struct stored inline in its parent: the offset applies directly. Scripted
// values held in a value holder are not handled (the lookup then fails and Lua keeps the path).
void* StructField(const CProperty* aProperty, void* aStruct)
{
    if (!aProperty || !aStruct || aProperty->flags.inValueHolder)
    {
        return nullptr;
    }
    return static_cast<unsigned char*>(aStruct) + aProperty->valueOffset;
}

void WriteInt(void* aSlot, uint32_t aSize, int64_t aValue)
{
    switch (aSize)
    {
    case 1:
        *static_cast<int8_t*>(aSlot) = static_cast<int8_t>(aValue);
        break;
    case 2:
        *static_cast<int16_t*>(aSlot) = static_cast<int16_t>(aValue);
        break;
    case 4:
        *static_cast<int32_t*>(aSlot) = static_cast<int32_t>(aValue);
        break;
    default:
        *static_cast<int64_t*>(aSlot) = aValue;
        break;
    }
}

// Stores a Lua number the way CET converts it: into the field's own type.
bool WriteNumber(const CProperty* aProperty, void* aSlot, double aValue)
{
    if (!aProperty || !aSlot || !IsNumeric(aProperty->type))
    {
        return false;
    }
    if (aProperty->type->GetType() == rt::ERTTIType::Enum)
    {
        WriteInt(aSlot, aProperty->type->GetSize(), static_cast<int64_t>(aValue));
        return true;
    }
    const char* name = aProperty->type->GetName().ToString();
    if (std::strcmp(name, "Float") == 0)
    {
        *static_cast<float*>(aSlot) = static_cast<float>(aValue);
    }
    else if (std::strcmp(name, "Double") == 0)
    {
        *static_cast<double*>(aSlot) = aValue;
    }
    else if (std::strcmp(name, "Bool") == 0)
    {
        *static_cast<bool*>(aSlot) = aValue != 0.0;
    }
    else
    {
        WriteInt(aSlot, aProperty->type->GetSize(), static_cast<int64_t>(aValue));
    }
    return true;
}

bool Resolve(Layout& L)
{
    auto* rtti = RED4ext::CRTTISystem::Get();
    if (!rtti)
    {
        return Miss("RTTI unavailable");
    }
    // The game's RTTI name is entLookAtAddEvent; "LookAtAddEvent" is only the script alias CET and
    // redscript use, which GetClass does not know (live 2026-10-13: "class LookAtAddEvent not found").
    L.eventClass = convai::game::Class("entLookAtAddEvent");
    if (!L.eventClass)
    {
        return Miss("class entLookAtAddEvent (script name LookAtAddEvent) not found");
    }
    L.setTarget = L.eventClass->GetFunction("SetEntityTarget");
    L.setStyle = L.eventClass->GetFunction("SetStyle");
    L.setParts = L.eventClass->GetFunction("SetAdditionalPartsArray");
    if (!L.setTarget || !L.setStyle || !L.setParts)
    {
        return Miss("LookAtAddEvent is missing SetEntityTarget, SetStyle or SetAdditionalPartsArray", L.eventClass);
    }
    if (L.setTarget->params.Size() != 3 || L.setStyle->params.Size() != 1 || L.setParts->params.Size() != 1)
    {
        return Miss("LookAtAddEvent setter parameter counts differ from the expected 3, 1 and 1", L.eventClass);
    }

    L.bodyPart = Property(L.eventClass, "bodyPart");
    L.provider = Property(L.eventClass, "targetPositionProvider");
    L.request = Property(L.eventClass, "request");
    if (!L.bodyPart || !L.provider || !L.request)
    {
        return Miss("LookAtAddEvent is missing bodyPart, targetPositionProvider or request", L.eventClass);
    }
    if (L.bodyPart->type->GetType() != rt::ERTTIType::Name || L.provider->type->GetType() != rt::ERTTIType::Handle)
    {
        return Miss("bodyPart is not a CName or targetPositionProvider is not a handle", L.eventClass);
    }

    L.requestClass = ClassOf(L.request);
    L.limits = Property(L.requestClass, "limits");
    L.limitsClass = ClassOf(L.limits);
    L.soft = Property(L.limitsClass, "softLimitDegrees");
    L.hard = Property(L.limitsClass, "hardLimitDegrees");
    L.back = Property(L.limitsClass, "backLimitDegrees");
    L.distance = Property(L.limitsClass, "hardLimitDistance");
    if (!L.soft || !L.hard || !L.back || !L.distance || !IsNumeric(L.soft->type) || !IsNumeric(L.hard->type) ||
        !IsNumeric(L.back->type) || !IsNumeric(L.distance->type))
    {
        return Miss("request.limits does not have the four numeric limit fields", L.limitsClass ? L.limitsClass : L.requestClass);
    }

    // Optional: a game without it only loses the parent-space solve of a seated request.
    L.parentSpace = Property(L.requestClass, "calculatePositionInParentSpace");
    if (L.parentSpace && !IsNumeric(L.parentSpace->type))
    {
        L.parentSpace = nullptr;
    }

    // The parameter types come from the registered signatures, so no type name is guessed.
    auto* styleType = L.setStyle->params[0]->type;
    if (!styleType || styleType->GetType() != rt::ERTTIType::Enum)
    {
        return Miss("SetStyle does not take an enum");
    }
    L.styleEnum = static_cast<CEnum*>(styleType);
    bool hasNormal = false;
    for (uint32_t i = 0; i < L.styleEnum->hashList.Size(); ++i)
    {
        if (L.styleEnum->hashList[i] == CName("Normal"))
        {
            hasNormal = true;
        }
    }
    if (!hasNormal)
    {
        return Miss("animLookAtStyle has no Normal value");
    }

    auto* partsType = L.setParts->params[0]->type;
    if (!partsType || partsType->GetType() != rt::ERTTIType::Array)
    {
        return Miss("SetAdditionalPartsArray does not take an array");
    }
    L.partsType = static_cast<CRTTIBaseArrayType*>(partsType);
    if (!L.partsType->innerType || L.partsType->innerType->GetType() != rt::ERTTIType::Class)
    {
        return Miss("the parts array does not hold structs");
    }
    L.partClass = static_cast<CClass*>(L.partsType->innerType);
    L.partName = Property(L.partClass, "partName");
    L.partWeight = Property(L.partClass, "weight");
    L.partSuppress = Property(L.partClass, "suppress");
    L.partMode = Property(L.partClass, "mode");
    if (!L.partName || !L.partWeight || !L.partSuppress || !L.partMode ||
        L.partName->type->GetType() != rt::ERTTIType::Name || !IsNumeric(L.partWeight->type) ||
        !IsNumeric(L.partSuppress->type) || !IsNumeric(L.partMode->type))
    {
        return Miss("LookAtPartRequest does not have partName, weight, suppress and mode", L.partClass);
    }
    return true;
}

Layout& Get()
{
    if (!g_layout.resolved)
    {
        g_layout.resolved = true;
        ProblemText().clear();
        g_layout.ok = Resolve(g_layout);
        if (g_layout.ok)
        {
            CONVAI_INFO("Gaze: LookAtAddEvent layout resolved");
        }
    }
    return g_layout;
}

// A method call by pointer values, made only when the function takes exactly those (plugin/CheckedCall.hpp:
// parameter count, sizes and types). The setters return nothing; a function that does return a value has it
// constructed and released by its own type.
bool Invoke(void* aInstance, CBaseFunction* aFunction, std::initializer_list<convai::game::TypedArg> aArgs)
{
    return convai::game::Invoke(static_cast<RED4ext::IScriptable*>(aInstance), aFunction, nullptr, aArgs);
}

// A temporary game array, built and torn down by the array type itself like a script local.
struct TempArray
{
    explicit TempArray(CRTTIBaseArrayType* aType) : type(aType)
    {
        type->Construct(storage);
    }
    ~TempArray()
    {
        type->Destruct(storage);
    }
    TempArray(const TempArray&) = delete;
    TempArray& operator=(const TempArray&) = delete;

    CRTTIBaseArrayType* type;
    uint64_t storage[4] = {}; // a DynArray is 16 bytes, 8-aligned
};
} // namespace

const std::string& Problem()
{
    return ProblemText();
}

FillResult Fill(const convai::game::Object& aEvent, const convai::game::Object& aPlayer, const LookPlan& aPlan)
{
    Layout& L = Get();
    if (!L.ok)
    {
        return FillResult::Unavailable;
    }
    auto decline = [](const char* aWhy) {
        ProblemText() = aWhy;
        return FillResult::Declined;
    };
    if (!aEvent || !aEvent.instance || !aPlayer || !aPlayer.instance)
    {
        return decline("event or player handle is empty");
    }
    auto* eventType = aEvent.instance->GetType();
    if (!eventType || !eventType->IsA(L.eventClass))
    {
        return decline("the first argument is not a LookAtAddEvent");
    }
    // SetEntityTarget takes an entity: the player has to be one before it is handed over.
    if (!convai::game::IsA(aPlayer, "entEntity"))
    {
        return decline("the player is not an entEntity");
    }
    void* event = aEvent.instance;
    convai::game::Object player = aPlayer; // an lvalue with the handle layout the call expects

    // 1. SetEntityTarget(player, slot, zero offset)
    {
        CName slot(aPlan.targetSlot);
        RED4ext::Vector4 offset(0.0f, 0.0f, 0.0f, 0.0f);
        if (!Invoke(event, L.setTarget, {&player, &slot, &offset}))
        {
            return decline("SetEntityTarget failed");
        }
    }

    // 2. A non-zero height goes to the target provider's world offset (world-vertical).
    if (aPlan.hasWorldOffset)
    {
        auto* provider = L.provider->GetValuePtr<convai::game::Object>(event);
        if (!provider || !*provider || !provider->instance)
        {
            return decline("the eye-contact target provider is unavailable");
        }
        auto* providerType = provider->instance->GetType();
        auto* setOffset = providerType ? convai::game::Method(providerType, "SetWorldOffset") : nullptr;
        if (!setOffset)
        {
            return decline("the target provider has no SetWorldOffset");
        }
        RED4ext::Vector4 worldOffset(0.0f, 0.0f, static_cast<float>(aPlan.worldOffsetZ), 0.0f);
        if (!Invoke(provider->instance, setOffset, {&worldOffset}))
        {
            return decline("SetWorldOffset failed");
        }
    }

    // 3. SetStyle(Normal)
    {
        alignas(8) unsigned char value[8] = {};
        const auto& names = L.styleEnum->hashList;
        const auto& values = L.styleEnum->valueList;
        bool found = false;
        for (uint32_t i = 0; i < names.Size() && i < values.Size(); ++i)
        {
            if (names[i] == CName(aPlan.styleName))
            {
                WriteInt(value, L.styleEnum->GetSize(), values[i]);
                found = true;
                break;
            }
        }
        if (!found || !Invoke(event, L.setStyle, {convai::game::TypedArg(static_cast<void*>(value), nullptr, L.styleEnum->GetSize())}))
        {
            return decline("SetStyle failed");
        }
    }

    // 4. bodyPart and the four limits
    *L.bodyPart->GetValuePtr<CName>(event) = CName(aPlan.bodyPart);
    void* request = L.request->GetValuePtr<void>(event);
    void* limits = StructField(L.limits, request);
    if (!limits || !WriteNumber(L.soft, StructField(L.soft, limits), aPlan.softLimitDegrees) ||
        !WriteNumber(L.hard, StructField(L.hard, limits), aPlan.hardLimitDegrees) ||
        !WriteNumber(L.back, StructField(L.back, limits), aPlan.backLimitDegrees) ||
        !WriteNumber(L.distance, StructField(L.distance, limits), aPlan.hardLimitDistance))
    {
        return decline("the limits could not be written");
    }

    // A seated request is solved in the car's space (the game's own in-vehicle look-at does the same).
    if (aPlan.parentSpace && L.parentSpace)
    {
        WriteNumber(L.parentSpace, StructField(L.parentSpace, request), 1.0);
    }

    // 5. The additional parts, passed as a game array.
    {
        TempArray parts(L.partsType);
        if (!L.partsType->Resize(parts.storage, static_cast<uint32_t>(aPlan.partCount)))
        {
            return decline("the parts array could not be sized");
        }
        for (int i = 0; i < aPlan.partCount; ++i)
        {
            void* part = L.partsType->GetElement(parts.storage, static_cast<uint32_t>(i));
            const PartPlan& source = aPlan.parts[i];
            if (!part || StructField(L.partName, part) == nullptr)
            {
                return decline("a part could not be reached");
            }
            *static_cast<CName*>(StructField(L.partName, part)) = CName(source.name);
            if (!WriteNumber(L.partWeight, StructField(L.partWeight, part), source.weight) ||
                !WriteNumber(L.partSuppress, StructField(L.partSuppress, part), source.suppress) ||
                !WriteNumber(L.partMode, StructField(L.partMode, part), static_cast<double>(source.mode)))
            {
                return decline("a part field could not be written");
            }
        }
        if (!Invoke(event, L.setParts, {convai::game::TypedArg(static_cast<void*>(parts.storage), nullptr, 16)}))
        {
            return decline("SetAdditionalPartsArray failed");
        }
    }
    ProblemText().clear();
    return FillResult::Built;
}
} // namespace convai::gaze
