// Named places of Night City with a world position and a radius (docs/DYNAMIC_INFO.md, "Named places"), so the turn context can say where V is by name
// ("at the Afterlife, a merc bar in Little China, Watson") although the game's district record for V's position is only the neighbourhood (a live test on
// 2026-10-30: V stood in the Afterlife, the context said Watson / Little China, and Judy answered "but I thought we were in Watson").
//
//   id         also the id of the developer probe that records the position: "quest capture:<id>" writes V's position to runtime/quest-place-capture.json,
//              and the bridge reads it from there (bridge/named-places.mjs), so a place is measured by standing in it
//   phrase     how the place is worded after "at" / "inside": the name, what it is, the neighbourhood and the district
//   root       the root district record the game reports there, when it is certain (Watson: the live test above): a match needs the same district
//   x, y, z    the world position (metres, +y north, +x east, z up) of a point in the middle of the place, or null while it is not measured
//   radius     metres from that point (horizontal) within which V counts as being at the place
//   dz         metres up or down within which V counts as being at the place (another floor of a tower is another place)
//   home       true for V's own flat: always "inside"
//   approx     true when the position is the centre of the game's streaming cell (about 20 m off), not a point: such a place is never matched while the game says V
//              is outdoors (indoors false), because its radius would reach the street
//   source     where the position comes from
//
// THREE KINDS OF POSITION (all offline, none measured by us in the game yet, so a live check is still owed):
//  - repo: V's apartment in Megabuilding H10, from the interior box of docs/HOUSEMATES.md (x -1395 to -1375, y 1260 to 1280, floor z 123.06, archive research on game 2.31).
//  - teleport: the coordinates the console guides of beebom.com and games.gg give for a fast-travel/teleport command (the two guides agree to the digit). The point is where
//    the player is put, so it can be at the door and not in the middle: the radius is the size of the place. Cross-check against the repo: the survey entry points of
//    mod/housemate-survey.lua are 12 m (Corpo Plaza flat) and 4 m (Northside flat) from the guides' teleports of the same flats, and the Time Machine teleport of the guides
//    (-1843.7, -575.3, 7.8) is 59 m from the Embers cell below.
//  - sector grid: the name of the game's interior streaming sector, interior_<X>_<Y>_<Z>_<level> (wiki.redmodding.org "Reference: World Sectors"), is a cell of 32 m
//    (64 m at level 1): x from X*32, y from Y*32, z from Z*32 up. It was checked against H10 (box x -1395..-1375, y 1260..1280, z 123 = interior_-44_39_3_0). A place that
//    spans several cells is the centre of their union. Accuracy about 20 m, so approx is true and the radius is the size of the cells. The height is the least certain
//    part (the cell of a tall building spans its floors), hence the wide dz.
// DROPPED: Embers (interior_-57_-17_2_0, z 64 to 96): the guides' Time Machine teleport 59 m away is at z 7.8 on the street, so the height index does not fit that area.
//
// STILL UNKNOWN (null, never matched, to be measured in the game with "quest capture:<id>"): Misty's Esoterica, Viktor's clinic, Tom's Diner, the Sunset Motel.
// A measured position is copied here with its source. A radius is a first guess for the size of the place.
export const NAMED_PLACES = Object.freeze([
  {id: 'v-apartment-h10', phrase: "V's apartment in Megabuilding H10, Little China, Watson", root: 'Watson', home: true, x: -1385, y: 1270, z: 123.06, radius: 14.5, dz: 5,
    source: 'repo: docs/HOUSEMATES.md, the H10 interior box x -1395 to -1375, y 1260 to 1280, floor z 123.06 (archive research on game 2.31)'},
  {id: 'afterlife', phrase: 'the Afterlife, a merc bar in Little China, Watson', root: 'Watson', x: -1455.068, y: 1010.975, z: 17.824, radius: 25, dz: 8,
    source: 'teleport: beebom.com and games.gg console guides, Afterlife (-1455.068, 1010.975, 17.824)'},
  {id: 'clouds', phrase: 'Clouds, a club in Japantown, Westbrook', x: -625.404, y: 794.564, z: 132.252, radius: 20, dz: 8,
    source: 'teleport: beebom.com and games.gg console guides, Clouds (-625.404, 794.564, 132.252)'},
  {id: 'v-apartment-corpo', phrase: "V's apartment at Corpo Plaza, City Center", home: true, x: -1607.948, y: 350.182, z: 50.997, radius: 18, dz: 6,
    source: 'teleport: beebom.com and games.gg console guides, the Corpo Plaza apartment (-1607.948, 350.182, 50.997), 12 m from the repo survey entry (-1606.33, 362.66, 49.21)'},
  {id: 'v-apartment-northside', phrase: "V's apartment in Northside, Watson", root: 'Watson', home: true, x: -1504.078, y: 2228.468, z: 23.798, radius: 14, dz: 6,
    source: 'teleport: beebom.com and games.gg console guides, the Northside motel apartment (-1504.078, 2228.468, 23.798), 4 m from the repo survey entry (-1503.80, 2224.92, 22.20)'},
  {id: 'arasaka-tower-ceo', phrase: 'the CEO level of Arasaka Tower, Corpo Plaza, City Center', x: -1437.788, y: 157.247, z: 565.346, radius: 25, dz: 15,
    source: 'teleport: beebom.com and games.gg console guides, Arasaka Tower CEO level (-1437.788, 157.247, 565.346)'},
  {id: 'lizzies-bar', phrase: "Lizzie's Bar, a club in Kabuki, Watson", root: 'Watson', x: -1184, y: 1568, z: 16, radius: 35, dz: 40, approx: true,
    source: 'sector grid: interior_-38/-37_48/49_0 (x -1216..-1152, y 1536..1600, z 0..32), centre of the cells, about 20 m'},
  {id: 'el-coyote-cojo', phrase: 'El Coyote Cojo, a bar in Vista del Rey, Heywood', x: -1248, y: -992, z: 16, radius: 35, dz: 40, approx: true,
    source: 'sector grid: interior_-40/-39_-32/-31_0 (x -1280..-1216, y -1024..-960, z 0..32), centre of the cells, about 20 m'},
  {id: 'judys-apartment', phrase: "Judy's apartment in Kabuki, Watson", root: 'Watson', x: -896, y: 1856, z: 48, radius: 35, dz: 40, approx: true,
    source: 'sector grid: interior_-29/-28_57/58_1 (x -928..-864, y 1824..1888, z 32..64), centre of the cells, about 20 m'},
  {id: 'totentanz', phrase: 'the Totentanz, a club in Northside, Watson', root: 'Watson', x: -1712, y: 2224, z: 96, radius: 50, dz: 50, approx: true,
    source: 'sector grid: interior_-55..-53_68..70_2..3 (x -1760..-1664, y 2176..2272, z 64..128), centre of the cells, about 20 m'},
  {id: 'wakakos-office', phrase: "Wakako's office in Japantown, Westbrook", x: -672, y: 800, z: 32, radius: 35, dz: 40, approx: true,
    source: 'sector grid: interior_-11_12_0 at level 1 (64 m cell: x -704..-640, y 768..832, z 0..64), centre of the cell, about 20 m'},
  {id: 'mistys-esoterica', phrase: "Misty's Esoterica, a shop in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'victors-clinic', phrase: "Viktor's clinic, a ripperdoc's clinic in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'toms-diner', phrase: "Tom's Diner, a diner in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'sunset-motel', phrase: 'the Sunset Motel', x: null, y: null, z: null, radius: 25, dz: 8},
]);
