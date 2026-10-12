#include "systems/vehicles/VehiclesGame.hpp"

#include "core/Log.hpp"

#include <RED4ext/CName.hpp>
#include <RED4ext/NativeTypes.hpp>
#include <RED4ext/RTTITypes.hpp>
#include <RED4ext/Scripting/Natives/Generated/ent/EntityID.hpp>
#include <RED4ext/Scripting/Natives/Generated/game/mounting/MountingInfo.hpp>
#include <RED4ext/Scripting/Natives/Generated/game/mounting/MountingSlotId.hpp>
#include <RED4ext/Scripting/Natives/Vector4.hpp>

#include <cstring>

namespace convai::vehicles::game
{
namespace
{
using namespace convai::vreflect;

// Lua: TweakDBID.new('Vehicle.v_standard3_thorton_mackinaw_ncu_player'), computed at compile time.
constexpr RED4ext::TweakDBID kMackinaw(kMackinawRecord);

// One slot per call site; the car classes differ (bike, car, truck) but each call site sees mostly
// one class, and a different class re-resolves.
Slot g_attached, g_isVehicle, g_destroyed, g_ai, g_recordId, g_record, g_package, g_seatSet, g_seats, g_seatName,
    g_hasSlot, g_entityId, g_reserved, g_velocity, g_gap, g_playerMounted, g_scene, g_mountObjects, g_mountIds;

// Lua `set and set:VehSeats() or {}`: the seat records of the car's record, as handles. A missing
// link in the chain (no record, no package, no seat set) is an empty list, like the Lua's {}.
bool ReadSeatRecords(const Object& aEntity, RED4ext::CRTTIBaseArrayType*& aType, uint64_t* aStorage, bool& aOut)
{
    aOut = false;
    Object record;
    if (!CallObject(g_record, aEntity, "GetRecord", record))
    {
        return false;
    }
    if (!record)
    {
        return true;
    }
    Object package;
    if (!CallObject(g_package, record, "VehDataPackage", package))
    {
        return false;
    }
    if (!package)
    {
        return true;
    }
    Object seatSet;
    if (!CallObject(g_seatSet, package, "VehSeatSet", seatSet))
    {
        return false;
    }
    if (!seatSet)
    {
        return true;
    }
    RED4ext::CBaseFunction* function = Find(g_seats, seatSet.instance, "VehSeats", 1);
    if (!function || function->params.Size() != 1 || !function->params[0] || !function->params[0]->type ||
        function->params[0]->type->GetType() != RED4ext::rtti::ERTTIType::Array)
    {
        return false;
    }
    aType = static_cast<RED4ext::CRTTIBaseArrayType*>(function->params[0]->type);
    aType->Construct(aStorage);
    if (!Invoke(seatSet.instance, function, nullptr, {aStorage}))
    {
        aType->Destruct(aStorage);
        aType = nullptr;
        return false;
    }
    aOut = true;
    return true;
}

// The array of seat records, built and torn down by the array type itself.
struct SeatList
{
    SeatList() = default;
    ~SeatList()
    {
        if (type && built)
        {
            type->Destruct(storage);
        }
    }
    SeatList(const SeatList&) = delete;
    SeatList& operator=(const SeatList&) = delete;

    RED4ext::CRTTIBaseArrayType* type = nullptr;
    alignas(8) uint64_t storage[4] = {}; // a DynArray is 16 bytes
    bool built = false;
};

Object ElementOf(const SeatList& aList, uint32_t aIndex)
{
    Object seat;
    void* element = aList.type->GetElement(const_cast<uint64_t*>(aList.storage), aIndex);
    if (!element || !aList.type->innerType)
    {
        return seat;
    }
    // The element is weak<VehicleSeat_Record> (or a strong handle in some builds): both are 16 bytes.
    if (aList.type->innerType->GetType() == RED4ext::rtti::ERTTIType::WeakHandle)
    {
        seat = Object(*static_cast<const RED4ext::WeakHandle<RED4ext::IScriptable>*>(element));
    }
    else if (aList.type->innerType->GetType() == RED4ext::rtti::ERTTIType::Handle)
    {
        seat = *static_cast<const Object*>(element);
    }
    return seat;
}
} // namespace

bool ReadEntityHash(const Object& aEntity, uint64_t& aOut)
{
    return CallId(g_entityId, aEntity, "GetEntityID", aOut);
}

bool ReadInspect(const Object& aEntity, bool aOwned, InspectRaw& aRaw)
{
    aRaw = InspectRaw{};
    if (!aEntity || !aEntity.instance)
    {
        return false;
    }
    bool flag = false;
    if (!CallBool(g_attached, aEntity, "IsAttached", flag))
    {
        return false;
    }
    aRaw.attached = flag;
    if (!flag)
    {
        return true;
    }
    if (!CallBool(g_isVehicle, aEntity, "IsVehicle", flag))
    {
        return false;
    }
    aRaw.isVehicle = flag;
    if (!flag)
    {
        return true;
    }
    aRaw.owned = aOwned;
    if (!CallBool(g_destroyed, aEntity, "IsDestroyed", flag))
    {
        return false;
    }
    aRaw.destroyed = flag;

    Object ai;
    if (!CallObject(g_ai, aEntity, "GetAIComponent", ai))
    {
        return false;
    }
    aRaw.aiPresent = static_cast<bool>(ai) && ai.instance != nullptr;
    if (aOwned && !aRaw.aiPresent)
    {
        // Lua: {ready=false, error=...}; nothing after this is used.
        return true;
    }

    uint64_t recordId = 0;
    if (!CallId(g_recordId, aEntity, "GetRecordID", recordId))
    {
        return false;
    }
    aRaw.mackinaw = recordId == kMackinaw.value;

    uint64_t carHash = 0;
    SeatList list;
    {
        bool built = false;
        // Reading the seat set needs the car's own entity hash for the occupant lookups.
        if (!ReadSeatRecords(aEntity, list.type, list.storage, built))
        {
            return false;
        }
        list.built = built;
    }
    if (list.built)
    {
        if (!ReadEntityHash(aEntity, carHash))
        {
            return false;
        }
        const uint32_t count = list.type->GetLength(list.storage);
        Object facility; // GameInstance.GetMountingFacility(), asked once for the first kept seat
        RED4ext::EntityID emptyChild{};
        RED4ext::EntityID parent{};
        parent.hash = carHash;
        for (uint32_t index = 0; index < count; ++index)
        {
            Object seatRecord = ElementOf(list, index);
            if (!seatRecord || !seatRecord.instance)
            {
                return false;
            }
            RED4ext::CName seatName;
            {
                Value value;
                static Slot nameSlot;
                if (!Call(nameSlot, seatRecord, "SeatName", &value) || !value.Name(seatName))
                {
                    return false;
                }
            }
            SeatRead seat;
            seat.name = seatName.ToString();
            if (!CallBool(g_hasSlot, aEntity, "HasOccupantSlot", flag, {&seatName}))
            {
                return false;
            }
            seat.hasSlot = flag;
            if (KeepSeat(seat.name, seat.hasSlot, aRaw.mackinaw))
            {
                // Lua: GetMountingInfoSingleWithIds(EntityID.new(), carId, slot); childId is the occupant.
                if (!facility)
                {
                    facility = GlobalSystem("GetMountingFacility;GameInstance");
                    if (!facility || !facility.instance)
                    {
                        return false;
                    }
                }
                RED4ext::MountingSlotId slot{};
                slot.id = seatName;
                RED4ext::CBaseFunction* function = Find(g_mountIds, facility.instance, "GetMountingInfoSingleWithIds", 3);
                Value info;
                if (!function || !Invoke(facility.instance, function, &info, {&emptyChild, &parent, &slot}) ||
                    info.TypeName() != "gamemountingMountingInfo")
                {
                    return false;
                }
                seat.occupant = static_cast<const RED4ext::MountingInfo*>(info.Data())->childId.hash;
                if (aRaw.aiPresent)
                {
                    if (!CallBool(g_reserved, ai, "IsSeatReserved", flag, {&seatName}))
                    {
                        return false;
                    }
                    seat.reserved = flag;
                }
            }
            aRaw.seats.push_back(std::move(seat));
        }
    }

    // speed(entity): the linear velocity, float32 components.
    {
        Value velocity;
        if (!Call(g_velocity, aEntity, "GetLinearVelocity", &velocity) ||
            velocity.TypeName() != "Vector4")
        {
            return false;
        }
        const auto* v = static_cast<const RED4ext::Vector4*>(velocity.Data());
        aRaw.velocityX = v->X;
        aRaw.velocityY = v->Y;
        aRaw.velocityZ = v->Z;
    }
    double gap = 0.0;
    if (!CallNumber(g_gap, aEntity, "GetDistanceToPlayerSquared", gap))
    {
        return false;
    }
    aRaw.distanceSquared = gap;
    if (!CallBool(g_playerMounted, aEntity, "IsPlayerMounted", flag))
    {
        return false;
    }
    aRaw.playerMounted = flag;
    if (!CallBool(g_scene, aEntity, "IsPerformingSceneAnimation", flag))
    {
        return false;
    }
    aRaw.scene = flag;
    return true;
}

bool ReadMounting(const Object& aNpc, MountRead& aOut)
{
    aOut = MountRead{};
    if (!aNpc || !aNpc.instance)
    {
        return false;
    }
    bool attached = false;
    if (!CallBool(g_attached, aNpc, "IsAttached", attached))
    {
        return false;
    }
    if (!attached)
    {
        return true;
    }
    Object facility = GlobalSystem("GetMountingFacility;GameInstance");
    if (!facility || !facility.instance)
    {
        return false;
    }
    RED4ext::CBaseFunction* function = Find(g_mountObjects, facility.instance, "GetMountingInfoSingleWithObjects", 3);
    if (!function)
    {
        return false;
    }
    // Lua passes only the child; the optional parent and slot are left empty.
    Object child = aNpc;
    Object noParent;
    RED4ext::MountingSlotId noSlot{};
    Value info;
    if (!Invoke(facility.instance, function, &info, {&child, &noParent, &noSlot}) ||
        info.TypeName() != "gamemountingMountingInfo")
    {
        return false;
    }
    const auto* mount = static_cast<const RED4ext::MountingInfo*>(info.Data());
    if (mount->parentId.hash != 0)
    {
        aOut.mounted = true;
        aOut.parent = mount->parentId.hash;
        aOut.seat = mount->slotId.id.ToString();
    }
    return true;
}
} // namespace convai::vehicles::game
