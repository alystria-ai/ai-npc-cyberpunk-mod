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
-- `base` is what the copy wears when nothing chooses for it (the template's default, or the one appearance companion-records.lua selects at creation:
-- Kerry). It is the look the character's appearance text describes, so a base row is never flagged as a change of clothes. Every list holds its base row.
-- `explicit = true`: the template's default is 'random', so the copy is always created with a named appearance (its base when nothing else is due).
-- Left out on purpose, by name: nude, underwear, shower and other undress, blood, wounds, burns and corpses, cyberspace, braindance and hologram looks, blendable
-- (fading) variants, other ages and years, funeral and epilogue looks, boss-fight stages, and the quest disguises that are another person's clothes. A look whose
-- only change is a removed accessory the character is known by (glasses, a mask) is not an outfit either.
-- Not listed at all: characters whose template offers one suitable look, characters whose template is shared with crowd members (Dennis Cranmer, Coach Fred,
-- Steven Santos, Pedro Aimar: their appearances belong to other people), Johnny (his phantom controller maps the physical copy to one solid look) and every
-- model record this table does not name.
return {
    version = 1,
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
            {'jackie_welles_valentino', 'night'},
            {'jackie_welles__q005_suit', 'night'},
            {'jackie_welles__q000_lizzies_club_no_jacket', 'night'},
        }},
        ['Character.Rogue'] = {base = 'rogue_rogue_old', outfits = {
            {'rogue_rogue_old', 'any'},
            {'rogue_rogue_old_solo', 'day'},
            {'rogue_rogue_date', 'night'},
        }},
        ['Character.reed'] = {base = 'reed_default', outfits = {   -- Solomon Reed
            {'reed_default', 'any'},
            {'reed_tshirt', 'day'},
            {'reed_vest', 'day'},
            {'reed_paradise', 'night'},
        }},
        ['Character.alex'] = {base = 'alex_default', outfits = {
            {'alex_default', 'any'},
            {'alex_bartender', 'night'},
            {'alex__q304__date', 'night'},
        }},
        ['Character.Evelyn'] = {base = 'evelyn_default', outfits = {
            {'evelyn_default', 'any'},
            {'evelyn_no_coat', 'home'},                     -- the dress without the fur coat
        }},
        ['Character.Takemura'] = {base = 'goro_takemura_ronin_shirt', outfits = {
            {'goro_takemura_ronin_shirt', 'any'},
            {'goro_takemura_ronin_trench', 'any'},
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
    },
}
