-- The outfits a party companion may change into (docs/COMPANION_OUTFITS.md). Curated by hand, one list per model record, and only appearances
-- that the record's own entity template carries: a name here is a name the template lists, so a character never wears another character's look.
-- Read from the installed game (WolvenKit CLI 9.0.1: the template of each record from the shipped tweak sources, its `appearances` list from the .ent,
-- the clothing meshes of each definition from the .app); game 2.5 and game 2.31 list the same names for every record below
-- (characters/companion-outfit-evidence.json holds the lists, bridge/companion-outfits.test.mjs checks this file against it).
--
-- Each row is {appearance name, kind}. The kinds:
--   'any'    worn day and night
--   'day'    chosen by day (06:00 to 18:59 game time)
--   'night'  chosen at night (19:00 to 05:59)
--   'home'   casual clothes for V's apartment, and only there (and never outside the apartment)
--   'formal' dressed-up clothes for a club, a fancy bar or a Corpo district (mod/companion-outfits.lua FORMAL_PLACES), and only there. At night in such a place the 'night'
--            looks join them (they are the evening looks). A character with no formal row keeps its ordinary rotation there.
-- A situation (home, formal, out) holds all the rows of its kinds as one list that rotates: a new copy and a new in-game day pick another look than the last one worn in that
-- situation (companion-outfits.lua; the last pick is kept in runtime/outfit-rotation.json).
-- `base` is what the copy wears when nothing chooses for it (the template's default, or the one appearance companion-records.lua selects at creation:
-- Kerry). It is the look the character's appearance text describes, so a base row is never flagged as a change of clothes. Every list holds its base row.
-- `explicit = true`: the template's default is 'random', so the copy is always created with a named appearance (its base when nothing else is due).
-- Every look was checked in the .app of its template with scripts/Inspect-OutfitMeshes.mjs: the clothes are listed, so undress (a censored or nude body, underwear only), another
-- person's uniform, a mask or a prop that belongs to a quest are seen there. Looks that were checked and refused, 2026-10-30: Kerry's bathrobe (a censored body and no robe mesh),
-- Rogue's date look without the jacket (a bra top), Reed's bodyguard (a guard cap: a disguise), Judy's diving suits (bare feet, a calf mesh the game marks for deletion),
-- Maiko's casual look (prostitute fashionware parts), Weyland's club look (Jackie's jacket on another man), Voodoo Queen (the template default is a cyberspace look and the chunk
-- masks of her coat and shoe variants cannot be told apart), Alex's second bartender look and Hanako's no-coat look (the same meshes as a look already listed).
-- Left out on purpose, by name: nude, underwear, shower and other undress, blood, wounds, burns and corpses, cyberspace, braindance and hologram looks, blendable
-- (fading) variants, other ages and years, funeral and epilogue looks, boss-fight stages, and the quest disguises that are another person's clothes. A look whose
-- only change is a removed accessory the character is known by (glasses, a mask) is not an outfit either.
-- Not listed at all: characters whose template offers one suitable look, characters whose template is shared with crowd members (Dennis Cranmer, Coach Fred,
-- Steven Santos, Pedro Aimar: their appearances belong to other people), Johnny (his phantom controller maps the physical copy to one solid look) and every
-- model record this table does not name.
return {
    version = 2,
    characters = {
        ['Character.Judy'] = {base = 'judy_default', outfits = {
            {'judy_default', 'any'},
            {'judy__mq055__apartment_01', 'home'},          -- tank top, boxer shorts, flip-flops
        }},
        ['Character.Panam'] = {base = 'panam_default', outfits = {
            {'panam_default', 'any'},
            {'panam_no_jacket', 'day'},
            {'panam_no_jacket_and_harness', 'day'},
            {'panam__mq055__apartment_01', 'home'},         -- shirt and trousers, no jacket (apartment_02 is underwear: left out)
        }},
        ['Character.Sobchak'] = {base = 'river_ward_default', outfits = {   -- River Ward
            {'river_ward_default', 'any'},
            {'river_ward_no_jacket', 'day'},
            {'river_ward__mq055__apartment_01', 'home'},    -- tank top and trousers
        }},
        ['Character.Kerry'] = {base = 'kerry_eurodyne_kerry_eurodyne_old_no_sunglasses', outfits = {
            {'kerry_eurodyne_kerry_eurodyne_old_no_sunglasses', 'any'},
            {'kerry_eurodyne_kerry_eurodyne_undercover', 'night'},   -- hooded jacket
            {'kerry_eurodyne__mq055__apartment_01', 'home'},         -- t-shirt and trousers
        }},
        ['Character.Jackie'] = {base = 'jackie_welles_default', outfits = {
            {'jackie_welles_default', 'any'},
            {'jackie_welles_default_collar_down', 'day'},
            {'jackie_welles_valentino_collar_down', 'night'},        -- the Valentino look with the collar open
            {'jackie_welles__q000_lizzies_club_no_jacket', 'night'},
            {'jackie_welles_valentino', 'formal'},
            {'jackie_welles__q005_suit', 'formal'},
        }},
        ['Character.Rogue'] = {base = 'rogue_rogue_old', outfits = {
            {'rogue_rogue_old', 'any'},
            {'rogue_rogue_old_solo', 'day'},
            {'rogue_rogue_date', 'formal'},                 -- white sweater bodysuit, camo trousers, high heels
        }},
        ['Character.reed'] = {base = 'reed_default', outfits = {   -- Solomon Reed
            {'reed_default', 'any'},
            {'reed_tshirt', 'day'},
            {'reed_vest', 'day'},
            {'reed_vest_with_bag', 'day'},                  -- the vest and a rucksack
            {'reed_paradise', 'formal'},
        }},
        ['Character.alex'] = {base = 'alex_default', outfits = {
            {'alex_default', 'any'},
            {'alex_bartender', 'night'},
            {'alex__q304__date', 'formal'},
        }},
        ['Character.Evelyn'] = {base = 'evelyn_default', outfits = {
            {'evelyn_default', 'any'},
            {'evelyn_no_coat', 'home'},                     -- the dress without the fur coat
        }},
        ['Character.Takemura'] = {base = 'goro_takemura_ronin_shirt', outfits = {
            {'goro_takemura_ronin_shirt', 'any'},
            {'goro_takemura_ronin_trench', 'any'},
            {'goro_takemura_saburo_bodyguard', 'formal'},   -- his Arasaka work clothes: white shirt, suit trousers, dress shoes, gloves
        }},
        ['Character.Thompson'] = {base = 'thompson_coat', outfits = {
            {'thompson_coat', 'any'},
            {'thompson_no_coat', 'home'},
        }},
        ['Character.Yorinobu'] = {base = 'yorinobu_arasaka_yorinobu_default', outfits = {
            {'yorinobu_arasaka_yorinobu_default', 'any'},
            {'yorinobu_arasaka_yorinobu_arasaka_ceo__coat', 'day'},
            {'yorinobu_arasaka_yorinobu_arasaka_ceo', 'night'},
        }},
        ['Character.Claire'] = {base = 'clair_default', outfits = {
            {'clair_default', 'any'},
            {'clair_bartender', 'night'},
        }},
        -- Joss Kutcher. Her template's default appearance is 'random' (the engine picks any listed look), so a copy is always created with a named one.
        ['Character.sq021_joss'] = {base = 'citizen__lowlife_wa__sq029__joss', explicit = true, outfits = {
            {'citizen__lowlife_wa__sq029__joss', 'any'},
            {'citizen__lowlife_wa__sq029__joss_piama', 'home'},     -- pyjamas
        }},
        ['Character.Ozob'] = {base = 'ozob_default', outfits = {
            {'ozob_default', 'any'},
            {'ozob_no_jacket', 'day'},
        }},
        ['Character.Hanako'] = {base = 'hanako_default', outfits = {
            {'hanako_default', 'any'},
            {'hanako_parade', 'formal'},                    -- the red parade dress and shoes
            {'hanako_parade_no_coat', 'formal'},            -- the same with bracelets
        }},
        ['Character.songbird'] = {base = 'songbird_default', outfits = {
            {'songbird_default', 'any'},
            {'songbird_paradise', 'formal'},                -- fur and metal party dress, high heels
        }},
        ['Character.mq306_aaron'] = {base = 'man_big__mq306__aaron_default', outfits = {   -- Aaron McCarlson
            {'man_big__mq306__aaron_default', 'any'},       -- shorts and sneakers
            {'man_big__mq306__aaron_shirt', 'day'},         -- with a tank top
            {'man_big__mq306__aaron_casual', 'any'},        -- straps jacket, T-shirt, trousers, sneakers
        }},
        ['Character.dante'] = {base = 'man_average__mq305__dante', outfits = {
            {'man_average__mq305__dante', 'any'},
            {'man_average__mq305__dante_merc', 'night'},    -- purple croc vest, bolo tie
        }},
    },
}
