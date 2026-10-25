-- V's flats and the places a housemate can sit, stand, lean or sleep in them (docs/HOUSEMATES.md, "Apartments and spots").
--
-- Data only. Loaded when somebody lives in a flat, dropped 30 s after V leaves it. Coordinates are world metres. The archive research that
-- produced the seeds was done on the 2.31 install (the 2.5 sectors cannot be read by the tool), so every position without `conf = 'M'` is a
-- seed: the housemate controller snaps it to the real furniture with raycasts before anyone uses it (mod/housemate-world.lua `snap`), and
-- drops it for the session when nothing seat-like is found there. The development recorder (mod/housemate-survey.lua) turns seeds into
-- measured spots; promote a recording by copying its line here and giving it conf = 'M'.
--
-- A spot:
--   id         unique
--   kind       couch | chair | bar | stool | lean | stand | window | sink | bed
--   x y z      where she sits (the root of the sit workspot), stands, or lies down
--   yaw        the direction she faces, degrees (game Euler yaw), when known; nil: found by the snap (the backrest or the window)
--   conf       M measured on the game, A archive furniture position, Q a quest marker an NPC used in the game's own scene, I inferred
--   group      seats of one piece of furniture (they sit side by side)
--   maybeV     this seat may be V's own seat (V's sit interaction plays at a fixed root): it is not given to anyone until V's seat in this flat
--              is known (V sat once and the seating controller learned it, or a recording named it)
--   vslot      this IS V's own root: never given to anyone
--   usable     false: kept here for the recorder, not used
--   face       {x, y} a point she looks toward (a window)
--   fitsTwo    bed only: measured to hold V and her; with width = the span measured across the bed
--   note       free text
--
-- The kind 'bed' needs `anchor` (V's lying root), `across` (yaw of the line across the bed) and `sides` (the offsets from the anchor, metres).
local D = {version = 1}

-- The quest facts that mean "the game is directing this flat": a flat with one of them above 0 hosts no housemate (read at 1 Hz at most,
-- docs/HOUSEMATES.md "Quest and scene safety"). Regenerated from the cooked quest phases by scripts/Extract-ApartmentFacts.mjs.
D.reservedFacts = {
    any = {'mq055_02_active', 'mq055_apt_interactions_off', 'mq055_04_intimate_action_on', 'web_apartment_website_start'},
    -- q001_in_v_room is deliberately not listed: nobody can be invited in the prologue, and whether that fact is reset afterwards is not known.
    h10 = {'q305_johnny_scene_active', 'mq055_02_megabuilding_active', 'mq055_megabuilding_partner_on_sofa'},
    corpo = {'dlc6_apart_cct_dtn_purchase', 'dlc6_apart_cct_dtn_purchase_setup', 'mq055_02_downtown_active', 'mq055_05_downtown_activities_off'},
    glen = {'dlc6_apart_hey_gle_purchase', 'dlc6_apart_hey_gle_purchase_setup', 'mq055_02_heywood_active'},
    japan = {'dlc6_apart_wbr_jpn_purchase', 'dlc6_apart_wbr_jpn_purchase_setup', 'mq055_02_japantown_active'},
    north = {'dlc6_apart_wat_nid_purchase', 'dlc6_apart_wat_nid_purchase_setup', 'mq055_02_northside_active', 'mq055_northside_shower'},
}

D.apartments = {
    h10 = {id = 'h10', name = 'Megabuilding H10', district = 'LittleChina_VApartment', fact = nil, floor = 123.06,
        spots = {
            -- The L-shaped couch (quest sectors): a corner piece, a long arm along x -1376.3 and a short arm along y 1266. Each piece is 1.0 m wide.
            {id = 'h10-couch-short-1', kind = 'couch', x = -1378.59, y = 1266.00, z = 122.7, conf = 'A', group = 'h10-couch-short'},
            {id = 'h10-couch-short-2', kind = 'couch', x = -1379.58, y = 1266.09, z = 122.7, conf = 'A', group = 'h10-couch-short'},
            {id = 'h10-couch-long-1', kind = 'couch', x = -1376.34, y = 1268.79, z = 122.7, conf = 'A', group = 'h10-couch-long', maybeV = true},
            {id = 'h10-couch-long-2', kind = 'couch', x = -1376.25, y = 1269.78, z = 122.7, conf = 'A', group = 'h10-couch-long', maybeV = true},
            {id = 'h10-couch-corner', kind = 'couch', x = -1376.41, y = 1267.79, z = 122.7, conf = 'A', group = 'h10-couch-corner', maybeV = true},
            -- The desk and the low stool.
            {id = 'h10-desk-chair', kind = 'chair', x = -1386.05, y = 1274.38, z = 123.06, conf = 'A', note = 'chair variants are swapped by the decorations phase'},
            {id = 'h10-stool', kind = 'stool', x = -1385.95, y = 1274.98, z = 123.06, conf = 'A', usable = false, note = 'a 0.45 m utility stool'},
            -- Where Johnny stood in the flat (his AI spots): open floor.
            {id = 'h10-stand-1', kind = 'stand', x = -1385.26, y = 1272.44, z = 123.07, yaw = -104, conf = 'Q'},
            {id = 'h10-stand-2', kind = 'stand', x = -1389.25, y = 1268.10, z = 123.08, yaw = 86, conf = 'Q'},
            -- The bedroom window at the head of the bed and the mq055 markers (window, shelves, bathroom): stand spots whose facing is measured live.
            {id = 'h10-window-bed', kind = 'window', x = -1376.9, y = 1277.3, z = 123.06, conf = 'A', face = {x = -1375.75, y = 1277.79}, usable = false},
            {id = 'h10-window-living', kind = 'window', x = -1377.6, y = 1271.25, z = 123.06, conf = 'Q', usable = false},
            {id = 'h10-shelves', kind = 'stand', x = -1384.84, y = 1270.41, z = 123.06, conf = 'Q', usable = false},
            -- The bed: a 2.50 x 2.20 m mattress at (-1377.33, 1276.14), yaw 174.8. V's lying root and the head direction are not known.
            {id = 'h10-bed', kind = 'bed', x = -1377.33, y = 1276.14, z = 123.29, conf = 'A', usable = false,
                anchor = {x = -1377.33, y = 1276.14, z = 123.29}, across = 84.8, sides = {-0.6, 0.6}, fitsTwo = nil,
                note = 'mattress 2.50 x 2.20 (fits two by size); head direction and V\'s root to be recorded'},
        }},
    corpo = {id = 'corpo', name = 'Corpo Plaza', district = 'CorpoPlaza_Apartment', fact = 'dlc6_apart_cct_dtn_purchased', floor = 49.2,
        spots = {
            -- The couch: V's seat root was measured on the game; the next seat is 0.66 m to V's left (docs/COMPANION_SEATING.md).
            {id = 'corpo-couch-v', kind = 'couch', x = -1602.30, y = 356.20, z = 48.62, yaw = 18.5, conf = 'M', vslot = true, group = 'corpo-couch'},
            {id = 'corpo-couch-2', kind = 'couch', x = -1602.93, y = 355.99, z = 48.62, yaw = 18.5, conf = 'M', group = 'corpo-couch'},
            -- The L section of the sofa: where the game's own visit scene seated a partner.
            {id = 'corpo-couch-3', kind = 'couch', x = -1601.09, y = 358.73, z = 48.62, conf = 'Q', group = 'corpo-couch-l'},
            {id = 'corpo-couch-4', kind = 'couch', x = -1602.12, y = 358.71, z = 48.62, conf = 'Q', group = 'corpo-couch-l'},
            -- The counter stools (three; one is V's) and the two office chairs.
            {id = 'corpo-bar-1', kind = 'bar', x = -1607.53, y = 352.05, z = 49.40, conf = 'A', group = 'corpo-bar', maybeV = true},
            {id = 'corpo-bar-2', kind = 'bar', x = -1608.61, y = 351.91, z = 49.40, conf = 'A', group = 'corpo-bar', maybeV = true},
            {id = 'corpo-bar-3', kind = 'bar', x = -1610.13, y = 351.88, z = 49.40, conf = 'A', group = 'corpo-bar'},
            {id = 'corpo-chair-1', kind = 'chair', x = -1598.91, y = 357.46, z = 48.63, conf = 'A'},
            {id = 'corpo-chair-2', kind = 'chair', x = -1614.48, y = 351.22, z = 49.44, conf = 'A'},
            -- The bed: a raised platform about 5.0 x 2.9 m, V lies near (-1614.31, 358.39) with the head toward +y (nine pillows at y 359.5).
            {id = 'corpo-bed', kind = 'bed', x = -1614.31, y = 358.39, z = 49.07, conf = 'I', usable = false,
                anchor = {x = -1614.31, y = 358.39, z = 49.07}, across = 120, sides = {-1.0, 1.0}, fitsTwo = nil,
                note = 'platform 5.0 x 2.9 (fits two by size); head direction and V\'s root to be recorded'},
            {id = 'corpo-counter', kind = 'lean', x = -1608.8, y = 350.2, z = 49.4, conf = 'A', usable = false,
                note = 'in front of the coffee machine at (-1608.81, 349.09); facing to be recorded'},
        }},
    glen = {id = 'glen', name = 'Heywood Glen', district = 'Glen_Apartment', fact = 'dlc6_apart_hey_gle_purchased', floor = 86.95,
        spots = {
            -- Seeds from the 2.31 sectors, partly fitted; none is used until a recording confirms the floor and the facing.
            {id = 'glen-chair', kind = 'chair', x = -1520.95, y = -977.6, z = 86.9, conf = 'I', usable = false},
            {id = 'glen-office-chair', kind = 'chair', x = -1518.97, y = -969.92, z = 86.95, conf = 'A', usable = false},
            {id = 'glen-couch', kind = 'couch', x = -1519.34, y = -977.76, z = 86.78, conf = 'A', usable = false, note = 'bar_sofa_01_o_small'},
            {id = 'glen-stool-1', kind = 'stool', x = -1522.31, y = -984.21, z = 86.95, conf = 'A', usable = false},
            {id = 'glen-stool-2', kind = 'stool', x = -1533.54, y = -969.8, z = 86.96, conf = 'A', usable = false},
            {id = 'glen-bed', kind = 'bed', x = -1524.34, y = -977.02, z = 90.97, conf = 'I', usable = false,
                anchor = {x = -1524.3, y = -977.0, z = 91.19}, across = 85, sides = {-0.8, 0.8},
                note = 'the mattress mesh was reported as 2.04 x 0.69 x 0.28: not known to fit two'},
        }},
    japan = {id = 'japan', name = 'Westbrook Japantown', district = 'JapanTown_Apartment', fact = 'dlc6_apart_wbr_jpn_purchased',
        spots = {
            -- A multi-floor block: which floor is V's flat is not known, so nothing here is used until it is recorded.
            {id = 'japan-couch', kind = 'couch', x = -783.71, y = 977.22, z = 28.21, conf = 'A', usable = false},
            {id = 'japan-stool-1', kind = 'stool', x = -784.24, y = 972.88, z = 28.21, conf = 'A', usable = false},
            {id = 'japan-stool-2', kind = 'stool', x = -782.23, y = 981.61, z = 28.20, conf = 'A', usable = false},
            {id = 'japan-bed', kind = 'bed', x = -782.33, y = 988.53, z = 16.21, conf = 'A', usable = false,
                anchor = {x = -781.15, y = 986.65, z = 16.73}, across = 0, sides = {-0.8, 0.8}},
        }},
    north = {id = 'north', name = 'Watson Northside', district = 'Northside_Apartment', fact = 'dlc6_apart_wat_nid_purchased',
        spots = {}},
}

D.order = {'h10', 'corpo', 'glen', 'japan', 'north'}

-- The district record name -> flat id.
D.byDistrict = {}
for id, apartment in pairs(D.apartments) do D.byDistrict[apartment.district] = id end

return D
