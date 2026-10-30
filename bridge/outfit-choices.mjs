// The looks a player can pick for a character in the editor (docs/CHARACTER_EDITOR.md, "Look and moves").
//
// These are the appearances of the curated list the game side already changes companions into (mod/companion-outfits-data.lua,
// docs/COMPANION_OUTFITS.md): every name is an appearance that the character's own entity template lists, read from the installed game
// (characters/companion-outfit-evidence.json), so a character is never given another person's clothes. Undress, damage, other ages and
// disguises are left out of that list on purpose, and so they are here. The mod's Lua cannot be read by the service (it lives in the game
// folder), so this is a copy of it with a short English label for each look; bridge/character-options.test.mjs reads the Lua file as text
// and fails when the two differ.
//
//   record   the model record the game spawns for the character ("Character.Judy")
//   base     the look the character wears when nothing chooses for it (the one its appearance text describes)
//   looks    [name, kind, label], kind is the list's own (any, day, night, home, formal), label the English sentence the page translates
//
// Only a copy the mod itself made (a party companion, a resident of V's flat) is ever dressed. A character the game placed is never changed.
export const OUTFITS = Object.freeze({
  'Character.Judy': {base: 'judy_default', looks: [
    ['judy_default', 'any', 'Usual look'],
    ['judy__mq055__apartment_01', 'home', 'Home clothes: tank top, boxer shorts, flip-flops'],
  ]},
  'Character.Panam': {base: 'panam_default', looks: [
    ['panam_default', 'any', 'Usual look'],
    ['panam_no_jacket', 'day', 'No jacket'],
    ['panam_no_jacket_and_harness', 'day', 'No jacket and harness'],
    ['panam__mq055__apartment_01', 'home', 'Home clothes: shirt and trousers'],
  ]},
  'Character.Sobchak': {base: 'river_ward_default', looks: [
    ['river_ward_default', 'any', 'Usual look'],
    ['river_ward_no_jacket', 'day', 'No jacket'],
    ['river_ward__mq055__apartment_01', 'home', 'Home clothes: tank top and trousers'],
  ]},
  'Character.Kerry': {base: 'kerry_eurodyne_kerry_eurodyne_old_no_sunglasses', looks: [
    ['kerry_eurodyne_kerry_eurodyne_old_no_sunglasses', 'any', 'Usual look'],
    ['kerry_eurodyne_kerry_eurodyne_undercover', 'night', 'Hooded jacket'],
    ['kerry_eurodyne__mq055__apartment_01', 'home', 'Home clothes: t-shirt and trousers'],
  ]},
  'Character.Jackie': {base: 'jackie_welles_default', looks: [
    ['jackie_welles_default', 'any', 'Usual look'],
    ['jackie_welles_default_collar_down', 'day', 'Collar down'],
    ['jackie_welles_valentino_collar_down', 'night', 'Valentino look, collar open'],
    ['jackie_welles__q000_lizzies_club_no_jacket', 'night', 'Club night, no jacket'],
    ['jackie_welles_valentino', 'formal', 'Valentino look'],
    ['jackie_welles__q005_suit', 'formal', 'Suit'],
  ]},
  'Character.Rogue': {base: 'rogue_rogue_old', looks: [
    ['rogue_rogue_old', 'any', 'Usual look'],
    ['rogue_rogue_old_solo', 'day', 'Solo look'],
    ['rogue_rogue_date', 'formal', 'Date night'],
  ]},
  'Character.reed': {base: 'reed_default', looks: [
    ['reed_default', 'any', 'Usual look'],
    ['reed_tshirt', 'day', 'T-shirt'],
    ['reed_vest', 'day', 'Vest'],
    ['reed_vest_with_bag', 'day', 'Vest and rucksack'],
    ['reed_paradise', 'formal', 'Paradise look'],
  ]},
  'Character.alex': {base: 'alex_default', looks: [
    ['alex_default', 'any', 'Usual look'],
    ['alex_bartender', 'night', 'Bartender'],
    ['alex__q304__date', 'formal', 'Date night'],
  ]},
  'Character.Evelyn': {base: 'evelyn_default', looks: [
    ['evelyn_default', 'any', 'Usual look'],
    ['evelyn_no_coat', 'home', 'Dress without the fur coat'],
  ]},
  'Character.Takemura': {base: 'goro_takemura_ronin_shirt', looks: [
    ['goro_takemura_ronin_shirt', 'any', 'Usual look'],
    ['goro_takemura_ronin_trench', 'any', 'Trench coat'],
    ['goro_takemura_saburo_bodyguard', 'formal', 'Arasaka work clothes, no jacket'],
  ]},
  'Character.Thompson': {base: 'thompson_coat', looks: [
    ['thompson_coat', 'any', 'Usual look'],
    ['thompson_no_coat', 'home', 'Without the coat'],
  ]},
  'Character.Yorinobu': {base: 'yorinobu_arasaka_yorinobu_default', looks: [
    ['yorinobu_arasaka_yorinobu_default', 'any', 'Usual look'],
    ['yorinobu_arasaka_yorinobu_arasaka_ceo__coat', 'day', 'CEO look with coat'],
    ['yorinobu_arasaka_yorinobu_arasaka_ceo', 'night', 'CEO look'],
  ]},
  'Character.Claire': {base: 'clair_default', looks: [
    ['clair_default', 'any', 'Usual look'],
    ['clair_bartender', 'night', 'Bartender'],
  ]},
  'Character.sq021_joss': {base: 'citizen__lowlife_wa__sq029__joss', looks: [
    ['citizen__lowlife_wa__sq029__joss', 'any', 'Usual look'],
    ['citizen__lowlife_wa__sq029__joss_piama', 'home', 'Pyjamas'],
  ]},
  'Character.Ozob': {base: 'ozob_default', looks: [
    ['ozob_default', 'any', 'Usual look'],
    ['ozob_no_jacket', 'day', 'No jacket'],
  ]},
  'Character.Hanako': {base: 'hanako_default', looks: [
    ['hanako_default', 'any', 'Usual look'],
    ['hanako_parade', 'formal', 'Red parade dress'],
    ['hanako_parade_no_coat', 'formal', 'Red parade dress with bracelets'],
  ]},
  'Character.songbird': {base: 'songbird_default', looks: [
    ['songbird_default', 'any', 'Usual look'],
    ['songbird_paradise', 'formal', 'Party dress'],
  ]},
  'Character.mq306_aaron': {base: 'man_big__mq306__aaron_default', looks: [
    ['man_big__mq306__aaron_default', 'any', 'Usual look'],
    ['man_big__mq306__aaron_shirt', 'day', 'Tank top'],
    ['man_big__mq306__aaron_casual', 'any', 'Street clothes'],
  ]},
  'Character.dante': {base: 'man_average__mq305__dante', looks: [
    ['man_average__mq305__dante', 'any', 'Usual look'],
    ['man_average__mq305__dante_merc', 'night', 'Merc look'],
  ]},
});

/** The record of the first of `records` that has looks, or null. */
export function outfitRecord(records) {
  for (const record of Array.isArray(records) ? records : []) if (Object.hasOwn(OUTFITS, record)) return record;
  return null;
}

/** What the page offers for a character with these model records: {record, base, looks: [{name, kind, label}]}, or null when it has one look only. */
export function outfitsFor(records) {
  const record = outfitRecord(records);
  if (!record) return null;
  const {base, looks} = OUTFITS[record];
  return {record, base, looks: looks.map(([name, kind, label]) => ({name, kind, label}))};
}

/** True when `name` is one of the looks of `record`. */
export const isOutfitOf = (record, name) => Object.hasOwn(OUTFITS, record) && typeof name === 'string' && OUTFITS[record].looks.some(([look]) => look === name);
