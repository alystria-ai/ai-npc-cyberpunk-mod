-- Place words for a meeting (docs/IMMERSIVE_INVITATIONS.md): the game's district records as a phrase the character can use.
-- The same table as bridge/place-names.mjs (INTERIORS, HOME_PLACES), which words the place V is at for every turn; bridge/immersive-place-words.test.mjs
-- keeps the two in step. Pure: no game calls.
local M = {}
M.NAMES = {JapanTown = 'Japantown'}
M.HOME = {
    LittleChina_VApartment = "V's apartment in Megabuilding H10",
    Northside_Apartment = "V's apartment in Northside",
    JapanTown_Apartment = "V's apartment in Japantown",
    Glen_Apartment = "V's apartment in the Glen",
    CorpoPlaza_Apartment = "V's apartment at Corpo Plaza",
}
M.INTERIORS = {
    LittleChina_Afterlife = "the Afterlife",
    LittleChina_MistysShop = "Misty's Esoterica",
    LittleChina_RiotClub = "the Riot Club",
    LittleChina_TomsDiner = "Tom's Diner",
    LittleChina_VictorsClinic = "Viktor's clinic",
    Kabuki_LizziesBar = "Lizzie's Bar",
    Kabuki_NoTellMotel = "the No-Tell Motel",
    Kabuki_JudysApartment = "Judy's apartment",
    JapanTown_HiromisApartment = "Hiromi's apartment",
    JapanTown_Clouds = "Clouds",
    JapanTown_DarkMatter = "Dark Matter",
    JapanTown_Fingers = "Fingers",
    JapanTown_FourthWallBdStudio = "the Fourth Wall braindance studio",
    JapanTown_Wakakos_Pachinko_Parlor = "Wakako's Pachinko Parlor",
    Arroyo_ClairesGarage = "Claire's garage",
    Arroyo_TireEmpire = "Tire Empire",
    Arroyo_KenmoreCafe = "the Kenmore Cafe",
    Glen_NCPDLab = "the NCPD lab",
    Glen_MusicStore = "a music store",
    Glen_WichedTires = "a tire shop",
    Glen_Embers = "Embers",
    Northside_CleanCut = "Clean Cut",
    Northside_Totentaz = "the Totentanz",
    Northside_All_Foods = "All Foods",
    Coastview_BattysHotel = "Batty's hotel",
    Coastview_ButcherShop = "a butcher shop",
    Coastview_GrandImperialMall = "the Grand Imperial Mall",
    Coastview_RundownApartment = "a run-down apartment",
    Coastview_VDBChapel = "the Valentinos chapel",
    Downtown_TheHammer = "the Hammer",
    NorthOaks_Columbarium = "the columbarium",
    RanchoCoronado_GunORama = "Gun-O-Rama",
    Vista_del_Rey_LaCatrina = "La Catrina",
    Vista_del_rey_ElCoyoteCojo = "El Coyote Cojo",
    Dogtown_Hideout = "a hideout",
}

-- "SantoDomingo" -> "Santo Domingo", "Badlands_RockyRidge" -> "Rocky Ridge" (placeName in bridge/protocol.mjs).
function M.words(value)
    if type(value) ~= 'string' or value == '' then return nil end
    local last = value:match('([^_]+)$') or value
    last = last:gsub('(%l)(%u)', '%1 %2'):gsub('(%u+)(%u%l)', '%1 %2')
    last = last:match('^%s*(.-)%s*$')
    return last ~= '' and last or nil
end

-- The place as a phrase that follows "at": "Lizzie's Bar, Kabuki, Watson", "V's apartment in Megabuilding H10", "Arroyo, Santo Domingo".
function M.text(district, area)
    if type(district) ~= 'string' or district == '' then return nil end
    local root = M.NAMES[district] or M.words(district) or district
    local sub = type(area) == 'string' and area ~= '' and area ~= district and area or nil
    if not sub then return root end
    if M.HOME[sub] then return M.HOME[sub] end
    if sub:match('^%a+_Apartment$') or sub:match('^%a+_VApartment$') then return 'an apartment in ' .. root end
    if M.INTERIORS[sub] then return M.INTERIORS[sub] .. ', ' .. root end
    if sub:match('^CorpoPlaza_ArasakaTower') then return (M.words(sub) or sub) .. ', ' .. root end
    return (M.NAMES[sub] or M.words(sub) or sub) .. ', ' .. root
end

-- Eight-point compass word for a bearing from north (game y) clockwise.
function M.compass(dx, dy)
    local names = {'north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'}
    local angle = math.atan2 and math.atan2(dx, dy) or math.atan(dx, dy)
    local degrees = math.deg(angle) % 360
    return names[math.floor((degrees + 22.5) / 45) % 8 + 1]
end

return M
