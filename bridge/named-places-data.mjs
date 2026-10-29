// Named places of Night City with a world position and a radius (docs/DYNAMIC_INFO.md, "Named places"), so the turn context can say where V is by name
// ("at the Afterlife, a merc bar in Little China, Watson") although the game's district record for V's position is only the neighbourhood (a live test on
// 2026-10-30: V stood in the Afterlife, the context said Watson / Little China, and Judy answered "but I thought we were in Watson").
//
//   id         also the id of the developer probe that records the position: "quest capture:<id>" writes V's position to runtime/quest-place-capture.json,
//              and the bridge reads it from there (bridge/named-places.mjs), so a place is measured by standing in it
//   phrase     how the place is worded after "at" / "inside": the name, what it is, the neighbourhood and the district
//   root       the root district record the game reports there (Watson, Heywood, Westbrook), when it is known: a match needs the same district
//   x, y, z    the world position (metres, +y north, +x east, z up) of a point in the middle of the place, or null while it is not measured
//   radius     metres from that point (horizontal) within which V counts as being at the place
//   dz         metres up or down within which V counts as being at the place (another floor of a tower is another place)
//   home       true for V's own flat: always "inside"
//   source     where the position comes from (only a position a file ties to the place by name counts as verified)
//
// VERIFIED: V's apartment in Megabuilding H10 (docs/HOUSEMATES.md: the interior spans x -1395 to -1375, y 1260 to 1280, floor z 123.06; the centre and the
// radius are the box's own). Every other place has no measured position anywhere in the repo yet: x, y and z are null, such a place is never matched, and each is
// listed for the owner to measure in the game with "quest capture:<id>". A radius here is a first guess for the size of the place.
export const NAMED_PLACES = Object.freeze([
  {id: 'v-apartment-h10', phrase: "V's apartment in Megabuilding H10, Little China, Watson", root: 'Watson', home: true, x: -1385, y: 1270, z: 123.06, radius: 14.5, dz: 5,
    source: 'docs/HOUSEMATES.md: the H10 interior box x -1395 to -1375, y 1260 to 1280, floor z 123.06 (archive research on game 2.31)'},
  {id: 'afterlife', phrase: 'the Afterlife, a merc bar in Little China, Watson', root: 'Watson', x: null, y: null, z: null, radius: 25, dz: 8},
  {id: 'lizzies-bar', phrase: "Lizzie's Bar, a club in Kabuki, Watson", root: 'Watson', x: null, y: null, z: null, radius: 20, dz: 8},
  {id: 'mistys-esoterica', phrase: "Misty's Esoterica, a shop in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'victors-clinic', phrase: "Viktor's clinic, a ripperdoc's clinic in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'toms-diner', phrase: "Tom's Diner, a diner in Little China, Watson", root: 'Watson', x: null, y: null, z: null, radius: 12, dz: 6},
  {id: 'el-coyote-cojo', phrase: 'El Coyote Cojo, a bar in Vista del Rey, Heywood', root: 'Heywood', x: null, y: null, z: null, radius: 20, dz: 8},
  {id: 'sunset-motel', phrase: 'the Sunset Motel', x: null, y: null, z: null, radius: 25, dz: 8},
  {id: 'clouds', phrase: 'Clouds, a club in Japantown, Westbrook', root: 'Westbrook', x: null, y: null, z: null, radius: 20, dz: 8},
]);
