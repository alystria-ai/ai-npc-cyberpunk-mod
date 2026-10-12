#pragma once

// Clearance queries, ported from mod/companion-clearance.lua (and the two spatial raycasts of
// mod/companions.lua). Pure logic: no RED4ext include, so the headless tests run it against a fake
// Probe and replay what the Lua module recorded (tests/fixtures/clearance-*.json).
//
// The game side (ClearanceGame.cpp) implements Probe with SpatialQueriesSystem.Overlap and
// SyncRaycastByCollisionGroup. Lua keeps the per-update query budget (a plain table shared by
// several modules); every entry point here takes the budget left ("remaining") and reports the
// queries it issued ("used"), which the Lua shim adds to the budget.
//
// Rules carried over from the Lua (each one is checked by the fixture replay):
//   - a box is certified only with all six collision groups; with fewer than six queries left the
//     box is Deferred (nothing is queried) and the caller retries on a later update;
//   - the groups are queried in a fixed order and the first hit stops the box, so a hit at group g
//     costs g+1 queries;
//   - the Boolean from Overlap means HIT. No other answer (and no trace content) decides clearance;
//   - dimensions that are not finite or out of range make the check Unavailable (the Lua raises an
//     error that its pcall turns into "could not verify");
//   - values reach the game as float32 (Vector4.new / EulerAngles.new), so boxes are rounded to
//     float32 before they are queried and before they are reported in a rejection.

#include <string>

namespace convai::clearance
{
inline constexpr int kGroupCount = 6;
// Overlap groups, in the order the Lua queries them. Rejections carry the 0-based index.
inline constexpr const char* kGroups[kGroupCount] = {"Static", "Dynamic", "Vehicle", "Terrain", "Collider", "Destructible"};
// Raycast groups of companions.lua visibleFromCrosshair, in its order.
inline constexpr const char* kSightGroups[kGroupCount] = {"Static", "Dynamic", "Terrain", "Collider", "Destructible", "Vehicle"};
inline constexpr int kMaxSegmentBoxes = 64;
inline constexpr double kFiniteLimit = 10000000.0;

struct Vec3
{
    double x = 0;
    double y = 0;
    double z = 0;
};

// Standing body: horizontal radius and height, in metres.
struct Shape
{
    double radius = 0.4;
    double height = 2.1;
};

// An oriented query box: half extents, world-space centre, Euler angles in degrees.
struct Box
{
    Vec3 half;
    Vec3 center;
    double roll = 0;
    double pitch = 0;
    double yaw = 0;
};

// What the game said about one query. Error means the call itself failed (no spatial system, the
// function missing, the invoker refusing): never a statement about the world.
enum class Hit
{
    Free,
    Blocked,
    Error
};

class Probe
{
public:
    virtual ~Probe() = default;
    // Overlap of aBox against collision group kGroups[aGroup].
    virtual Hit Overlap(const Box& aBox, int aGroup) = 0;
    // SyncRaycastByCollisionGroup(aFrom, aTo, aGroup, ...). On a hit aHitZ receives the Z of the
    // trace position (may be null).
    virtual Hit Ray(const Vec3& aFrom, const Vec3& aTo, const char* aGroup, double* aHitZ) = 0;
    // Why the last Error happened (small positive code, for the log).
    virtual int ErrorCode() const
    {
        return 0;
    }
};

enum class Status
{
    Clear = 0,       // free of every group (a visible ray; a floor was found)
    Blocked = 1,     // a hit: group and box say where
    Deferred = 2,    // not enough budget left; retry on a later update (segment: from nextBox)
    Unavailable = 3, // invalid input: the Lua reports "could not verify companion body clearance"
    Fallback = 4,    // the game call failed: the Lua shim runs its own path instead
    Geometry = 5     // segment refused before any query (route-size or step-slope)
};

enum class GeometryKind
{
    None = 0,
    RouteSize = 1,
    StepSlope = 2
};

struct Outcome
{
    Status status = Status::Clear;
    int used = 0;     // queries issued, counting the one that hit or failed
    int group = 0;    // Blocked: index into kGroups (or kSightGroups for a ray)
    Box box;          // Blocked: the box, as float32
    int boxIndex = 0; // Blocked segment: 1-based box that hit
    int boxCount = 0; // segment: number of boxes
    int nextBox = 0;  // Deferred segment: 1-based box to resume at
    int code = 0;     // Fallback: Probe::ErrorCode
    GeometryKind kind = GeometryKind::None;
    double length = 0;
    double rise = 0;
    double deltaZ = 0;
    double allowedRise = 0;
    double z = 0; // CheckFloor: Z of the floor when Clear
};

// --- math (ClearanceMath.cpp) -----------------------------------------------------------------

// Lua: type(v)=='number' and v==v and math.abs(v)<10000000.
bool IsFinite(double aValue);
bool IsPoint(const Vec3& aPoint);
// Lua shape(): radius in [0.2, 3], height in [0.5, 6], both finite.
bool ValidShape(const Shape& aShape);
// Lua M.segmentBoxes: max(1, ceil(horizontal length / 2), ceil(|dz| / 0.2)).
int SegmentBoxes(const Vec3& aFrom, const Vec3& aTo);
// A double rounded to float32 and back: what Vector4.new / EulerAngles.new keep.
double ToFloat32(double aValue);
Box RoundToFloat32(const Box& aBox);

struct Euler
{
    double roll = 0;
    double pitch = 0;
    double yaw = 0;
};
// Quaternion.ToEulerAngles(Quaternion.BuildFromDirectionVector(Vector4.new(dx, dy, 0, 0))) for a
// unit horizontal direction: roll 0, pitch 0, yaw = atan2(-dx, dy) in degrees (+Y is forward and a
// positive yaw turns left). The Lua shim checks this against the game's own functions before it
// lets the native path run.
Euler OrientationOf(double aDx, double aDy);

// --- checks (ClearanceCore.cpp) ---------------------------------------------------------------

// Lua overlap(): the six groups of one box. aRemaining is the budget left.
Outcome CheckBox(Probe& aProbe, const Box& aBox, int aRemaining);
// Lua M.body(feet, dimensions).
Outcome CheckBody(Probe& aProbe, const Vec3& aFeet, const Shape& aShape, int aRemaining);
// Lua M.recheck(rejection): a rejected box again, with the Lua's range checks on the box.
Outcome CheckRecheck(Probe& aProbe, const Box& aRejected, int aRemaining);
// Lua M.segment(from, to, dimensions, progress, nativeOriginProjection). aStartBox is
// progress.next or 1.
Outcome CheckSegment(Probe& aProbe, const Vec3& aFrom, const Vec3& aTo, const Shape& aShape, int aStartBox,
                     bool aNativeOriginProjection, int aRemaining);
// companions.lua visibleFromCrosshair: six rays, Clear means no group is hit.
Outcome CheckSight(Probe& aProbe, const Vec3& aFrom, const Vec3& aTo, int aRemaining);
// companions.lua floorBelow: one Static ray from 0.6 m above to 0.8 m below aAt. Clear and
// Outcome::z hold the floor Z when it lies between 0.05 m and aMaxDrop below aAt; Blocked means no
// usable floor. The Lua takes its single budget unit itself, so used is 0.
Outcome CheckFloor(Probe& aProbe, const Vec3& aAt, double aMaxDrop);

// --- wire format (ClearanceFormat.cpp) --------------------------------------------------------
//
// The natives return one String of space-separated numbers; the Lua shim splits it with
// string.gmatch and rebuilds the tuple the original function returned.
//
//   "<status> <used>" then, by status:
//     0 Clear        nothing
//     1 Blocked      <group 1-based> <cx> <cy> <cz> <hx> <hy> <hz> <roll> <pitch> <yaw>
//                    and for a segment also <box> <boxes>
//     2 Deferred     segment only: <nextBox>
//     3 Unavailable  nothing
//     4 Fallback     <code>
//     5 Geometry     <kind 1 route-size, 2 step-slope> <length> <rise> <deltaZ> <allowedRise> <boxes>
//   Sight: "<status> <used>", blocked adds " <group 1-based>", fallback adds " <code>"
//   Floor: "1 <z>" found, "0 0" no usable floor, "-1 <code>" fallback
//   Doubles use %.17g, so the Lua side reads back the exact value.
std::string FormatOutcome(const Outcome& aOutcome, bool aSegment);
std::string FormatSight(const Outcome& aOutcome);
std::string FormatFloor(const Outcome& aOutcome);
} // namespace convai::clearance
