// Where V and a companion really are, in words (docs/DYNAMIC_CONTEXT_AUDIT.md, "Where V is").
//
// The game side sends the district V is in (mod/init.lua currentDistrict: the root district such as SantoDomingo, and the most specific
// gamedataDistrict record, such as Arroyo, Kabuki_LizziesBar or LittleChina_VApartment). Most records are plain neighbourhoods, but a
// handful are named interiors (a bar, a clinic, V's own apartment) and the Badlands records are open country. This module words each
// kind differently, so a companion is never left to guess:
//   - a named place is stated only when the game's own record says V is there;
//   - an apartment or a named interior says "inside";
//   - the Badlands say "outdoors";
//   - a plain neighbourhood says only the neighbourhood, and (when the game can say) whether V is in a building or out in the open.
// The record names below were read from the game's own gamedataDistrict enum (final.redscripts, 2026-10-15).
import {placeName} from './protocol.mjs';

// V's homes (gamedataDistrict names the game reports for the apartment interiors; checked in final.redscripts 2026-10-14).
export const HOME_PLACES = Object.freeze({
  LittleChina_VApartment: "V's apartment in Megabuilding H10", Northside_Apartment: "V's apartment in Northside",
  JapanTown_Apartment: "V's apartment in Japantown", Glen_Apartment: "V's apartment in the Glen",
  CorpoPlaza_Apartment: "V's apartment at Corpo Plaza"});

const PLACE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,63}$/;

// Root districts and neighbourhoods whose enum spelling reads badly when split on capitals.
const NAMES = Object.freeze({JapanTown: 'Japantown'});

// Named interiors: enum name -> how to say it. All of these are inside a building the game's own record names.
export const INTERIORS = Object.freeze({
  LittleChina_Afterlife: 'the Afterlife', LittleChina_MistysShop: "Misty's Esoterica", LittleChina_RiotClub: 'the Riot Club',
  LittleChina_TomsDiner: "Tom's Diner", LittleChina_VictorsClinic: "Viktor's clinic",
  Kabuki_LizziesBar: "Lizzie's Bar", Kabuki_NoTellMotel: 'the No-Tell Motel', Kabuki_JudysApartment: "Judy's apartment",
  JapanTown_HiromisApartment: "Hiromi's apartment", JapanTown_Clouds: 'Clouds', JapanTown_DarkMatter: 'Dark Matter', JapanTown_Fingers: 'Fingers',
  JapanTown_FourthWallBdStudio: 'the Fourth Wall braindance studio', JapanTown_Wakakos_Pachinko_Parlor: "Wakako's Pachinko Parlor",
  Arroyo_ClairesGarage: "Claire's garage", Arroyo_TireEmpire: 'Tire Empire', Arroyo_KenmoreCafe: 'the Kenmore Cafe',
  Glen_NCPDLab: 'the NCPD lab', Glen_MusicStore: 'a music store', Glen_WichedTires: 'a tire shop', Glen_Embers: 'Embers',
  Northside_CleanCut: 'Clean Cut', Northside_Totentaz: 'the Totentanz', Northside_All_Foods: 'All Foods',
  Coastview_BattysHotel: "Batty's hotel", Coastview_ButcherShop: 'a butcher shop', Coastview_GrandImperialMall: 'the Grand Imperial Mall',
  Coastview_RundownApartment: 'a run-down apartment', Coastview_VDBChapel: 'the Valentinos chapel',
  Downtown_TheHammer: 'the Hammer', NorthOaks_Columbarium: 'the columbarium', RanchoCoronado_GunORama: 'Gun-O-Rama',
  Vista_del_Rey_LaCatrina: 'La Catrina', Vista_del_rey_ElCoyoteCojo: 'El Coyote Cojo', Dogtown_Hideout: 'a hideout'});
const INTERIOR_PREFIX = /^CorpoPlaza_ArasakaTower/;
const APARTMENT = /^[A-Za-z]+_(?:Apartment|VApartment)$/;

/**
 * Where V is, for one turn: {text, inside, kind} or null.
 *   text    the place as a phrase that follows "in" or "through": "Arroyo, Santo Domingo", "Lizzie's Bar, Kabuki, Watson"
 *   inside  true when the game's own record names an interior, false in the Badlands (open country), else the game's interior reading
 *           (`indoors`, true or false) or null when nothing says
 *   kind    'home' | 'venue' | 'wild' | 'neighborhood' | 'district' | 'named'
 * `named`: a place found from V's world position (bridge/named-places.mjs namedPlaceAt). It names the spot when the game's own record for V's position does
 * not (a record of the neighbourhood only, or none); a record that names an interior or a flat is kept as it is.
 */
export function describePlace({district, area, indoors, named = null} = {}) {
  if (typeof district !== 'string' || !PLACE.test(district)) return null;
  const root = NAMES[district] ?? placeName(district) ?? district;
  const sub = typeof area === 'string' && PLACE.test(area) && area !== district ? area : null;
  const reading = typeof indoors === 'boolean' ? indoors : null;
  const fromPosition = () => named && typeof named.phrase === 'string' ? {text: named.phrase, inside: named.home === true ? true : reading, kind: named.home === true ? 'home' : 'named'} : null;
  if (!sub) return fromPosition() ?? {text: root, inside: reading, kind: 'district'};
  if (Object.hasOwn(HOME_PLACES, sub)) return {text: HOME_PLACES[sub], inside: true, kind: 'home'};
  if (APARTMENT.test(sub)) return {text: `an apartment in ${root}`, inside: true, kind: 'venue'};
  if (Object.hasOwn(INTERIORS, sub)) return {text: `${INTERIORS[sub]}, ${root}`, inside: true, kind: 'venue'};
  if (INTERIOR_PREFIX.test(sub)) return {text: `${placeName(sub) ?? sub}, ${root}`, inside: true, kind: 'venue'};
  const name = NAMES[sub] ?? placeName(sub) ?? sub;
  if (/^(?:Badlands|NorthBadlands|SouthBadlands|MorroRock)(?:_|$)/.test(sub) || district === 'Badlands') {
    return {text: `${name}, ${root}`, inside: reading === true ? true : false, kind: 'wild'};
  }
  // A sub-record the table does not know by name: stated as it is, with whatever the game says about being indoors. A named place found by position is better than a bare neighbourhood.
  if (!sub.includes('_')) { const spot = fromPosition(); if (spot) return spot; }
  return {text: `${name}, ${root}`, inside: reading, kind: sub.includes('_') ? 'venue' : 'neighborhood'};
}
