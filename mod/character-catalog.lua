-- Resolve a named actor before considering a generic crowd voice. Body type
-- alone is never an identity for a quest character or a managed companion.
--
-- Order (docs/NPC_ARCHETYPES.md): a managed copy's assigned profile, then a
-- named roster profile (record or name), then a generic NPC archetype chosen
-- from the actor's TweakDB facts (vendor type, affiliation, police flag, crowd
-- record), then the two ambient resident profiles for any other crowd member.
local M = {}
local function normalized(value)
    return tostring(value or ''):lower():gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', '')
end

-- BEGIN GENERATED ARCHETYPES (node scripts/Build-ArchetypeProfiles.mjs; source characters/archetypes.json)
M.ARCHETYPES = {
    version = 1,
    bases = {
        ['aldecaldos'] = {category = 'gang', title = 'Aldecaldos nomad', affiliations = {'Aldecaldos'}},
        ['animals'] = {category = 'gang', title = 'Animals ganger', affiliations = {'Animals'}},
        ['barghest'] = {category = 'gang', title = 'Barghest soldier', affiliations = {'Barghest'}},
        ['bartender'] = {category = 'vendor', title = 'bartender', vendorTypes = {'Food', 'Drinks'}, records = {'Character.bls_ina_se1_foodshop_01', 'Character.cct_dtn_food_02', 'Character.cz_con_foodshop_01', 'Character.cz_monument_foodshop_01', 'Character.cz_stadium_food_03', 'Character.hey_rey_foodshop_02', 'Character.wat_kab_foodshop_02', 'Character.wat_kab_foodshop_04', 'Character.wbr_hil_foodshop_02', 'Character.lizzies_barman'}, recordTokens = {'barman', 'bartender'}},
        ['biotechnica'] = {category = 'faction', title = 'Biotechnica employee', affiliations = {'Biotechnica'}, recordTokens = {'biotechnica'}},
        ['clothing-vendor'] = {category = 'vendor', title = 'clothing vendor', vendorTypes = {'Clothing', 'Clothes', 'Armorsmith'}},
        ['corpo-resident'] = {category = 'resident', title = 'corporate worker', crowd = true, records = {'Character.CorpoMan', 'Character.CorpoManCorporat', 'Character.CorpoManAfterWork', 'Character.CorpoManNoReaction', 'Character.CorpoManBig', 'Character.CorpoManCigarette', 'Character.CorpoManBraindance', 'Character.CorpoManCoffee', 'Character.CorpoManCellphone', 'Character.CorpoManLaptopBag', 'Character.CorpoManArasaka', 'Character.CorpoManDE', 'Character.CorpoManAfterWorkDE', 'Character.CorpoWoman', 'Character.CorpoWomanCorporat', 'Character.CorpoWomanAfterWork', 'Character.CorpoWomanBag', 'Character.CorpoWomanArasaka', 'Character.CorpoWomanDE', 'Character.CorpoWomanAfterWorkDE', 'Character.WomanChubbyCorpo', 'Character.ObeseMaleCorpo', 'Character.NonBinaryMaleBodyCorpo', 'Character.NonBinaryFemaleBodyCorpo', 'Character.CitizenRichMale', 'Character.CitizenRichMaleCasual', 'Character.CitizenRichMaleUmbrella', 'Character.CitizenRichMaleDE', 'Character.CitizenRichFemale', 'Character.CitizenRichFemaleCasual', 'Character.CitizenArasakaHatoCorpoMale', 'Character.LightCrowd_corpoplaza_ma', 'Character.LightCrowd_corpoplaza_wa', 'Character.LightCrowd_downtown_ma', 'Character.LightCrowd_downtown_wa', 'Character.LightCrowd_charterhill_ma', 'Character.LightCrowd_charterhill_wa', 'Character.LightCrowd_northoaks_ma', 'Character.LightCrowd_northoaks_wa', 'Character.ep1_combat_zone_citizen_business_ma'}, recordPrefixes = {'CorpoMan', 'CorpoWoman', 'CitizenRich'}},
        ['corpo-security'] = {category = 'corpo-security', title = 'corporate security officer', affiliations = {'Arasaka', 'Zetatech', 'Corpbud'}, recordPrefixes = {'security_', 'civilianguard_'}},
        ['dogtown-resident'] = {category = 'resident', title = 'Dogtown resident', crowd = true, records = {'Character.ep1_combat_zone_citizen_stacks_ma', 'Character.ep1_combat_zone_citizen_stacks_wa', 'Character.ep1_combat_zone_citizen_stacks_mb', 'Character.ep1_combat_zone_citizen_stacks_lowlife_ma', 'Character.ep1_combat_zone_citizen_stacks_lowlife_wa', 'Character.ep1_combat_zone_citizen_stacks_elder_ma', 'Character.ep1_combat_zone_citizen_stacks_elder_wa', 'Character.ep1_combat_zone_citizen_pacific_ma', 'Character.ep1_combat_zone_citizen_pacific_wa', 'Character.ep1_combat_zone_citizen_pacific_mb', 'Character.ep1_combat_zone_citizen_obese_mf', 'Character.ep1_combat_zone_citizen_obese_pacific_mf', 'Character.ep1_combat_zone_citizen_obese_waf', 'Character.ep1_combat_zone_service_vendor_ma', 'Character.ep1_combat_zone_service_vendor_wa', 'Character.ep1_combat_zone_service_medical_ma', 'Character.ep1_combat_zone_service_medical_wa', 'Character.tga_trailer_ma', 'Character.tga_trailer_wa'}, recordPrefixes = {'ep1_combat_zone_citizen_stacks', 'ep1_combat_zone_citizen_pacific', 'ep1_combat_zone_citizen_obese'}},
        ['food-vendor'] = {category = 'vendor', title = 'food and drink vendor', vendorTypes = {'Food', 'GrilledFood', 'PackedFood', 'Drinks'}},
        ['homeless'] = {category = 'resident', title = 'person living rough', crowd = true, records = {'Character.HomelessMan', 'Character.HobotownHomelessMan', 'Character.HomelessFemale', 'Character.HobotownHomelessWoman', 'Character.HomelessManBig', 'Character.HomelessManBackpack', 'Character.HomelessManDE', 'Character.HomelessFemaleDE', 'Character.ep1_combat_zone_citizen_outcast_ma', 'Character.ep1_combat_zone_citizen_outcast_wa'}, recordPrefixes = {'Homeless', 'HobotownHomeless'}},
        ['joytoy'] = {category = 'faction', title = 'joytoy', recordTokens = {'prostitute', 'sexworker'}},
        ['junk-dealer'] = {category = 'vendor', title = 'junk dealer', vendorTypes = {'Junk', 'TechJunk'}},
        ['kang-tao'] = {category = 'faction', title = 'Kang Tao soldier', affiliations = {'KangTao'}, recordTokens = {'kangtao', 'kang_tao'}},
        ['maelstrom'] = {category = 'gang', title = 'Maelstrom ganger', affiliations = {'Maelstrom', 'MaelstromAndroid'}},
        ['market-stall'] = {category = 'vendor', title = 'market stall vendor', vendorTypes = {'Kiosk', 'Market'}},
        ['maxtac'] = {category = 'police', title = 'MaxTac officer', recordTokens = {'maxtac'}},
        ['medic-vendor'] = {category = 'vendor', title = 'medic shop vendor', vendorTypes = {'Medical'}},
        ['melee-vendor'] = {category = 'vendor', title = 'melee weapons dealer', vendorTypes = {'SkillTrainer'}, recordTokens = {'melee'}},
        ['merc'] = {category = 'faction', title = 'mercenary', affiliations = {'AfterlifeMercs', 'AfterlifeMercRogue'}, recordTokens = {'afterlife_merc', 'afterlife_rare', 'afterlife_netrunner', 'afterlife_base', 'generic_merc'}},
        ['militech'] = {category = 'faction', title = 'Militech soldier', affiliations = {'Militech'}, recordTokens = {'militech'}},
        ['mox'] = {category = 'gang', title = 'Mox member', affiliations = {'TheMox'}},
        ['ncpd'] = {category = 'police', title = 'NCPD officer', affiliations = {'NCPD'}, police = true, excludeRecordPrefixes = {'maxtac'}},
        ['netrunner-vendor'] = {category = 'vendor', title = 'netrunner vendor', vendorTypes = {'SkillTrainer'}, recordTokens = {'netrun', 'techstore'}},
        ['netwatch'] = {category = 'faction', title = 'NetWatch agent', affiliations = {'NetWatch'}, recordTokens = {'netwatch'}},
        ['nightlife-resident'] = {category = 'resident', title = 'club-goer', crowd = true, records = {'Character.NightlifeMale', 'Character.NightlifeMaleBig', 'Character.NightlifeWoman', 'Character.ObeseMaleNightlife', 'Character.NonBinaryMaleBodyNightlife', 'Character.NonBinaryFemaleBodyNightlife', 'Character.HoodHottie', 'Character.ServiceDancerFemale', 'Character.ServiceTubeDancerFemale', 'Character.Bouncer', 'Character.ep1_combat_zone_citizen_nightlife_ma', 'Character.ep1_combat_zone_citizen_nightlife_wa', 'Character.ep1_combat_zone_citizen_nightlife_crowd_ma', 'Character.ep1_combat_zone_citizen_nightlife_crowd_wa'}, recordPrefixes = {'Nightlife'}},
        ['nomad-resident'] = {category = 'resident', title = 'nomad', crowd = true, records = {'Character.CitizenAldecaldosMale', 'Character.CitizenAldecaldosMaleFarmer', 'Character.CitizenAldecaldosMaleMechanic', 'Character.CitizenAldecaldosMaleNomad', 'Character.CitizenAldecaldosMaleTeenager', 'Character.CitizenAldecaldosMaleBig', 'Character.CitizenAldecaldosFemale', 'Character.CitizenAldecaldosFemaleNomad', 'Character.CitizenAldecaldosFemaleTeenager', 'Character.CitizenAldecaldosMaleDE', 'Character.CitizenAldecaldosFemaleDE', 'Character.AldecaldosMale', 'Character.AldecaldosFemale', 'Character.ObeseMaleNomad'}, recordPrefixes = {'CitizenAldecaldos', 'AldecaldosMale', 'AldecaldosFemale'}},
        ['nusa'] = {category = 'faction', title = 'NUSA agent or soldier', affiliations = {'NUSA', 'NUSA_Myers'}},
        ['ripperdoc'] = {category = 'vendor', title = 'ripperdoc', vendorTypes = {'RipperDoc'}},
        ['scavengers'] = {category = 'gang', title = 'Scavenger', affiliations = {'Scavengers', 'ScavengersAndroid'}},
        ['sixth-street'] = {category = 'gang', title = '6th Street member', affiliations = {'SixthStreet', 'SixthStreetAndroid'}},
        ['street-goon'] = {category = 'faction', title = 'street goon', recordTokens = {'street_goon', 'street_big_goon', 'generic_grunt', 'generic_shotgun', 'generic_fast_', 'generic_gunner', 'generic_sniper', 'generic_netrunner'}},
        ['street-resident'] = {category = 'resident', title = 'street local', crowd = true, records = {'Character.LowlifeMale', 'Character.LowlifeMaleRedneck', 'Character.LowlifeMaleBig', 'Character.LowlifeWoman', 'Character.LowlifeWomanNoTalk', 'Character.LowlifeWomanRedneck', 'Character.LowlifeMaleDE', 'Character.LowlifeMaleDEfriendly', 'Character.LowlifeWomanDE', 'Character.LowlifeWomanDEfriendly', 'Character.LowlifeWomanRedneckDE', 'Character.SlackerMale', 'Character.SlackerMaleCigarette', 'Character.SlackerMaleCoffee', 'Character.SlackerMaleBig', 'Character.SlackerMaleBurger', 'Character.SlackerMaleCellphone', 'Character.SlackerMaleDuffelBag', 'Character.SlackerFemale', 'Character.SlackerMaleDE', 'Character.SlackerFemaleDE', 'Character.HobotownSlackerMale', 'Character.HobotownSlackerFemale', 'Character.StoopKing', 'Character.StoopKingNoReaction', 'Character.StoopKingBig', 'Character.StoopQueen', 'Character.StoopQueenNoReaction', 'Character.YoungsterMale', 'Character.YoungsterMaleBig', 'Character.YoungsterFemale', 'Character.YoungsterMaleDE', 'Character.YoungsterFemaleDE', 'Character.ObeseMaleLowlife'}, recordPrefixes = {'Lowlife', 'Slacker', 'Stoop', 'Youngster', 'HobotownSlacker'}},
        ['trauma-team'] = {category = 'faction', title = 'Trauma Team responder', affiliations = {'TraumaTeam'}, recordTokens = {'trauma_'}},
        ['tyger-claws'] = {category = 'gang', title = 'Tyger Claws ganger', affiliations = {'TygerClaws'}},
        ['valentinos'] = {category = 'gang', title = 'Valentinos ganger', affiliations = {'Valentinos'}},
        ['voodoo-boys'] = {category = 'gang', title = 'Voodoo Boys member', affiliations = {'VoodooBoys'}},
        ['weapons-dealer'] = {category = 'vendor', title = 'weapons dealer', vendorTypes = {'Gunsmith'}},
        ['worker-resident'] = {category = 'resident', title = 'city worker', crowd = true, records = {'Character.WorkerMale', 'Character.WorkerMaleDE', 'Character.WorkerSpecialistMale', 'Character.WorkerSpecialistMaleDE', 'Character.MunicipialMale', 'Character.ServiceSpecialistMale', 'Character.CookMale', 'Character.Waitress', 'Character.ServiceDiningWoman', 'Character.ServiceDiningMale', 'Character.ep1_combat_zone_citizen_stacks_worker_ma', 'Character.ep1_combat_zone_citizen_stacks_worker_wa', 'Character.ep1_combat_zone_citizen_carrying_ma', 'Character.ep1_combat_zone_citizen_carrying_wa', 'Character.ep1_combat_zone_service_dining_ma', 'Character.ep1_combat_zone_service_dining_wa', 'Character.MorningCrowdMan', 'Character.MorningCrowdManCigarette', 'Character.MorningCrowdManCoffee', 'Character.MorningCrowdWoman'}, recordPrefixes = {'Worker', 'MorningCrowd'}},
        ['wraiths'] = {category = 'gang', title = 'Wraith raider', affiliations = {'Wraiths', 'WraithsAndroid'}},
    },
    variants = {
        {key = 'npc-maelstrom-male', base = 'maelstrom', gender = 'MALE'},
        {key = 'npc-maelstrom-female', base = 'maelstrom', gender = 'FEMALE'},
        {key = 'npc-tyger-claws-male', base = 'tyger-claws', gender = 'MALE'},
        {key = 'npc-tyger-claws-female', base = 'tyger-claws', gender = 'FEMALE'},
        {key = 'npc-valentinos-male', base = 'valentinos', gender = 'MALE'},
        {key = 'npc-valentinos-female', base = 'valentinos', gender = 'FEMALE'},
        {key = 'npc-sixth-street-male', base = 'sixth-street', gender = 'MALE'},
        {key = 'npc-sixth-street-female', base = 'sixth-street', gender = 'FEMALE'},
        {key = 'npc-animals-male', base = 'animals', gender = 'MALE'},
        {key = 'npc-animals-female', base = 'animals', gender = 'FEMALE'},
        {key = 'npc-voodoo-boys-male', base = 'voodoo-boys', gender = 'MALE'},
        {key = 'npc-voodoo-boys-female', base = 'voodoo-boys', gender = 'FEMALE'},
        {key = 'npc-scavengers-male', base = 'scavengers', gender = 'MALE'},
        {key = 'npc-scavengers-female', base = 'scavengers', gender = 'FEMALE'},
        {key = 'npc-wraiths-male', base = 'wraiths', gender = 'MALE'},
        {key = 'npc-wraiths-female', base = 'wraiths', gender = 'FEMALE'},
        {key = 'npc-mox-male', base = 'mox', gender = 'MALE'},
        {key = 'npc-mox-female', base = 'mox', gender = 'FEMALE'},
        {key = 'npc-aldecaldos-male', base = 'aldecaldos', gender = 'MALE'},
        {key = 'npc-aldecaldos-female', base = 'aldecaldos', gender = 'FEMALE'},
        {key = 'npc-barghest-male', base = 'barghest', gender = 'MALE'},
        {key = 'npc-barghest-female', base = 'barghest', gender = 'FEMALE'},
        {key = 'npc-ncpd-male', base = 'ncpd', gender = 'MALE'},
        {key = 'npc-ncpd-female', base = 'ncpd', gender = 'FEMALE'},
        {key = 'npc-corpo-security-male', base = 'corpo-security', gender = 'MALE'},
        {key = 'npc-corpo-security-female', base = 'corpo-security', gender = 'FEMALE'},
        {key = 'npc-ripperdoc-male', base = 'ripperdoc', gender = 'MALE'},
        {key = 'npc-ripperdoc-female', base = 'ripperdoc', gender = 'FEMALE'},
        {key = 'npc-weapons-dealer-male', base = 'weapons-dealer', gender = 'MALE'},
        {key = 'npc-weapons-dealer-female', base = 'weapons-dealer', gender = 'FEMALE'},
        {key = 'npc-food-vendor-male', base = 'food-vendor', gender = 'MALE'},
        {key = 'npc-food-vendor-female', base = 'food-vendor', gender = 'FEMALE'},
        {key = 'npc-bartender-male', base = 'bartender', gender = 'MALE'},
        {key = 'npc-bartender-female', base = 'bartender', gender = 'FEMALE'},
        {key = 'npc-clothing-vendor-male', base = 'clothing-vendor', gender = 'MALE'},
        {key = 'npc-clothing-vendor-female', base = 'clothing-vendor', gender = 'FEMALE'},
        {key = 'npc-corpo-resident-male', base = 'corpo-resident', gender = 'MALE'},
        {key = 'npc-corpo-resident-female', base = 'corpo-resident', gender = 'FEMALE'},
        {key = 'npc-street-resident-male', base = 'street-resident', gender = 'MALE'},
        {key = 'npc-street-resident-female', base = 'street-resident', gender = 'FEMALE'},
        {key = 'npc-nomad-resident-male', base = 'nomad-resident', gender = 'MALE'},
        {key = 'npc-nomad-resident-female', base = 'nomad-resident', gender = 'FEMALE'},
        {key = 'npc-homeless-male', base = 'homeless', gender = 'MALE'},
        {key = 'npc-homeless-female', base = 'homeless', gender = 'FEMALE'},
        {key = 'npc-medic-vendor-male', base = 'medic-vendor', gender = 'MALE'},
        {key = 'npc-medic-vendor-female', base = 'medic-vendor', gender = 'FEMALE'},
        {key = 'npc-junk-dealer-male', base = 'junk-dealer', gender = 'MALE'},
        {key = 'npc-junk-dealer-female', base = 'junk-dealer', gender = 'FEMALE'},
        {key = 'npc-melee-vendor-male', base = 'melee-vendor', gender = 'MALE'},
        {key = 'npc-melee-vendor-female', base = 'melee-vendor', gender = 'FEMALE'},
        {key = 'npc-netrunner-vendor-male', base = 'netrunner-vendor', gender = 'MALE'},
        {key = 'npc-netrunner-vendor-female', base = 'netrunner-vendor', gender = 'FEMALE'},
        {key = 'npc-market-stall-male', base = 'market-stall', gender = 'MALE'},
        {key = 'npc-market-stall-female', base = 'market-stall', gender = 'FEMALE'},
        {key = 'npc-militech-male', base = 'militech', gender = 'MALE'},
        {key = 'npc-militech-female', base = 'militech', gender = 'FEMALE'},
        {key = 'npc-kang-tao-male', base = 'kang-tao', gender = 'MALE'},
        {key = 'npc-kang-tao-female', base = 'kang-tao', gender = 'FEMALE'},
        {key = 'npc-netwatch-male', base = 'netwatch', gender = 'MALE'},
        {key = 'npc-netwatch-female', base = 'netwatch', gender = 'FEMALE'},
        {key = 'npc-trauma-team-male', base = 'trauma-team', gender = 'MALE'},
        {key = 'npc-trauma-team-female', base = 'trauma-team', gender = 'FEMALE'},
        {key = 'npc-biotechnica-male', base = 'biotechnica', gender = 'MALE'},
        {key = 'npc-biotechnica-female', base = 'biotechnica', gender = 'FEMALE'},
        {key = 'npc-merc-male', base = 'merc', gender = 'MALE'},
        {key = 'npc-merc-female', base = 'merc', gender = 'FEMALE'},
        {key = 'npc-street-goon-male', base = 'street-goon', gender = 'MALE'},
        {key = 'npc-street-goon-female', base = 'street-goon', gender = 'FEMALE'},
        {key = 'npc-nightlife-resident-male', base = 'nightlife-resident', gender = 'MALE'},
        {key = 'npc-nightlife-resident-female', base = 'nightlife-resident', gender = 'FEMALE'},
        {key = 'npc-worker-resident-male', base = 'worker-resident', gender = 'MALE'},
        {key = 'npc-worker-resident-female', base = 'worker-resident', gender = 'FEMALE'},
        {key = 'npc-dogtown-resident-male', base = 'dogtown-resident', gender = 'MALE'},
        {key = 'npc-dogtown-resident-female', base = 'dogtown-resident', gender = 'FEMALE'},
        {key = 'npc-maxtac-male', base = 'maxtac', gender = 'MALE'},
        {key = 'npc-maxtac-female', base = 'maxtac', gender = 'FEMALE'},
        {key = 'npc-nusa-male', base = 'nusa', gender = 'MALE'},
        {key = 'npc-nusa-female', base = 'nusa', gender = 'FEMALE'},
        {key = 'npc-joytoy-male', base = 'joytoy', gender = 'MALE'},
        {key = 'npc-joytoy-female', base = 'joytoy', gender = 'FEMALE'},
    },
    recordGenders = {
        ['Character.Chinese_Food'] = 'MALE',
        ['Character.Claire'] = 'MALE',
        ['Character.Clothes'] = 'MALE',
        ['Character.Drinks'] = 'MALE',
        ['Character.Grilled_Food'] = 'MALE',
        ['Character.Kiosk'] = 'MALE',
        ['Character.Market'] = 'MALE',
        ['Character.Packed_Food'] = 'MALE',
        ['Character.Tech_Junk'] = 'MALE',
        ['Character.bls_ina_se1_clothingshop_01'] = 'FEMALE',
        ['Character.bls_ina_se1_foodshop_01'] = 'MALE',
        ['Character.bls_ina_se1_foodshop_02'] = 'MALE',
        ['Character.bls_ina_se1_foodshop_03'] = 'MALE',
        ['Character.bls_ina_se1_gunsmith_01'] = 'MALE',
        ['Character.bls_ina_se1_gunsmith_02'] = 'FEMALE',
        ['Character.bls_ina_se1_junkshop_01'] = 'MALE',
        ['Character.bls_ina_se1_medicstore_01'] = 'FEMALE',
        ['Character.bls_ina_se1_ripperdoc_01'] = 'MALE',
        ['Character.bls_ina_se1_ripperdoc_02'] = 'MALE',
        ['Character.bls_ina_se5_foodshop_01'] = 'MALE',
        ['Character.bls_ina_se5_gunsmith_01'] = 'MALE',
        ['Character.bls_ina_se5_junkshop_01'] = 'MALE',
        ['Character.bls_ina_se5_melee_01'] = 'FEMALE',
        ['Character.cct_cpz_cloth_02'] = 'MALE',
        ['Character.cct_cpz_food_01'] = 'FEMALE',
        ['Character.cct_cpz_food_02'] = 'MALE',
        ['Character.cct_cpz_medic_01'] = 'FEMALE',
        ['Character.cct_dtn_food_01'] = 'MALE',
        ['Character.cct_dtn_food_02'] = 'MALE',
        ['Character.cct_dtn_guns_01'] = 'MALE',
        ['Character.cct_dtn_medic_01'] = 'FEMALE',
        ['Character.cct_dtn_ripdoc_01'] = 'MALE',
        ['Character.cz_con_clothingshop_01'] = 'MALE',
        ['Character.cz_con_foodshop_01'] = 'FEMALE',
        ['Character.cz_con_gunsmith_01'] = 'MALE',
        ['Character.cz_con_junkshop_01'] = 'FEMALE',
        ['Character.cz_con_medicstore_01'] = 'FEMALE',
        ['Character.cz_con_netrunner_01'] = 'FEMALE',
        ['Character.cz_con_ripdoc_01'] = 'MALE',
        ['Character.cz_monument_foodshop_01'] = 'FEMALE',
        ['Character.cz_monument_ripperdoc_anderson'] = 'MALE',
        ['Character.cz_stadium_black_market_01'] = 'MALE',
        ['Character.cz_stadium_clothing_01'] = 'FEMALE',
        ['Character.cz_stadium_food_01'] = 'MALE',
        ['Character.cz_stadium_food_02'] = 'MALE',
        ['Character.cz_stadium_food_03'] = 'MALE',
        ['Character.cz_stadium_gunsmith_01'] = 'FEMALE',
        ['Character.cz_stadium_junk_01_marcin_i'] = 'MALE',
        ['Character.cz_stadium_junk_01_michal_k'] = 'MALE',
        ['Character.cz_stadium_medic_01'] = 'FEMALE',
        ['Character.cz_stadium_netrunner_01'] = 'MALE',
        ['Character.cz_stadium_qian_si_hu'] = 'MALE',
        ['Character.cz_stadium_ripperdoc_01'] = 'MALE',
        ['Character.hey_gle_foodshop_01'] = 'MALE',
        ['Character.hey_gle_foodshop_02'] = 'MALE',
        ['Character.hey_gle_gunsmith_01'] = 'MALE',
        ['Character.hey_rey_foodshop_02'] = 'MALE',
        ['Character.hey_rey_foodshop_03'] = 'MALE',
        ['Character.hey_rey_foodshop_04'] = 'MALE',
        ['Character.hey_rey_gunsmith_01'] = 'FEMALE',
        ['Character.hey_rey_netrunner_01'] = 'FEMALE',
        ['Character.hey_spr_clothingshop_01'] = 'FEMALE',
        ['Character.hey_spr_foodshop_01'] = 'FEMALE',
        ['Character.hey_spr_gunsmith_01'] = 'FEMALE',
        ['Character.hey_spr_junk_01'] = 'MALE',
        ['Character.hey_spr_medicstore_01'] = 'MALE',
        ['Character.hey_spr_ripperdoc_01'] = 'MALE',
        ['Character.nw4_spaceport_medic_01'] = 'MALE',
        ['Character.pac_cvi_clothingshop_01'] = 'FEMALE',
        ['Character.pac_cvi_foodshop_01'] = 'MALE',
        ['Character.pac_cvi_medicstore_01'] = 'MALE',
        ['Character.pac_cvi_techstore_01'] = 'FEMALE',
        ['Character.pac_wwd_guns_01'] = 'FEMALE',
        ['Character.pac_wwd_melee_01'] = 'MALE',
        ['Character.pac_wwd_ripdoc_01'] = 'MALE',
        ['Character.std_arr_clothingshop_01'] = 'FEMALE',
        ['Character.std_arr_foodshop_01'] = 'MALE',
        ['Character.std_arr_foodshop_02'] = 'MALE',
        ['Character.std_arr_foodshop_03'] = 'MALE',
        ['Character.std_arr_gunsmith_01'] = 'MALE',
        ['Character.std_arr_medicstore_01'] = 'MALE',
        ['Character.std_arr_melee_01'] = 'MALE',
        ['Character.std_arr_ripperdoc_01'] = 'MALE',
        ['Character.std_arr_techstore_01'] = 'FEMALE',
        ['Character.std_rcr_clothingshop_01'] = 'FEMALE',
        ['Character.std_rcr_foodshop_01'] = 'FEMALE',
        ['Character.std_rcr_gunsmith_01'] = 'FEMALE',
        ['Character.std_rcr_medicstore_01'] = 'FEMALE',
        ['Character.std_rcr_ripperdoc_01'] = 'MALE',
        ['Character.std_rcr_techstore_01'] = 'FEMALE',
        ['Character.wat_kab_clothingshop_01'] = 'MALE',
        ['Character.wat_kab_foodshop_01'] = 'MALE',
        ['Character.wat_kab_foodshop_02'] = 'MALE',
        ['Character.wat_kab_foodshop_03'] = 'FEMALE',
        ['Character.wat_kab_foodshop_04'] = 'MALE',
        ['Character.wat_kab_gunsmith_01'] = 'MALE',
        ['Character.wat_kab_gunsmith_02'] = 'MALE',
        ['Character.wat_kab_junkshop_01'] = 'MALE',
        ['Character.wat_kab_medicstore_01'] = 'MALE',
        ['Character.wat_kab_netrunner_01'] = 'FEMALE',
        ['Character.wat_kab_ripperdoc_01'] = 'MALE',
        ['Character.wat_kab_ripperdoc_03'] = 'MALE',
        ['Character.wat_kab_techstore_01'] = 'MALE',
        ['Character.wat_lch_clothingshop_01'] = 'MALE',
        ['Character.wat_lch_foodshop_02'] = 'MALE',
        ['Character.wat_lch_medic_01'] = 'FEMALE',
        ['Character.wat_lch_melee_01'] = 'MALE',
        ['Character.wat_lch_melee_02'] = 'MALE',
        ['Character.wat_nid_clothingshop_01'] = 'FEMALE',
        ['Character.wat_nid_foodshop_01'] = 'MALE',
        ['Character.wat_nid_foodshop_02'] = 'FEMALE',
        ['Character.wat_nid_gunsmith_01'] = 'MALE',
        ['Character.wat_nid_medicstore_01'] = 'MALE',
        ['Character.wat_nid_medicstore_02'] = 'MALE',
        ['Character.wat_nid_ripperdoc_01'] = 'MALE',
        ['Character.wbr_hil_clothingshop_01'] = 'FEMALE',
        ['Character.wbr_hil_foodshop_01'] = 'MALE',
        ['Character.wbr_hil_foodshop_02'] = 'MALE',
        ['Character.wbr_hil_ripdoc_01'] = 'FEMALE',
        ['Character.wbr_jpn_cloth_01'] = 'FEMALE',
        ['Character.wbr_jpn_food_01'] = 'FEMALE',
        ['Character.wbr_jpn_food_02'] = 'MALE',
        ['Character.wbr_jpn_food_03'] = 'MALE',
        ['Character.wbr_jpn_food_04'] = 'MALE',
        ['Character.wbr_jpn_food_05'] = 'MALE',
        ['Character.wbr_jpn_guns_01'] = 'MALE',
        ['Character.wbr_jpn_jig_bar_01'] = 'FEMALE',
        ['Character.wbr_jpn_junk_01'] = 'MALE',
        ['Character.wbr_jpn_junk_03'] = 'MALE',
        ['Character.wbr_jpn_medic_01'] = 'MALE',
        ['Character.wbr_jpn_melee_01'] = 'MALE',
        ['Character.wbr_jpn_netrun_01'] = 'MALE',
        ['Character.wbr_jpn_ripdoc_01'] = 'FEMALE',
        ['Character.wbr_nok_medic_01'] = 'MALE',
    },
    vendorRecords = {
        ['Character.Claire'] = true,
        ['Character.bls_ina_se1_clothingshop_01'] = true,
        ['Character.bls_ina_se1_foodshop_01'] = true,
        ['Character.bls_ina_se1_foodshop_02'] = true,
        ['Character.bls_ina_se1_foodshop_03'] = true,
        ['Character.bls_ina_se1_gunsmith_01'] = true,
        ['Character.bls_ina_se1_gunsmith_02'] = true,
        ['Character.bls_ina_se1_junkshop_01'] = true,
        ['Character.bls_ina_se1_medicstore_01'] = true,
        ['Character.bls_ina_se1_ripperdoc_01'] = true,
        ['Character.bls_ina_se1_ripperdoc_02'] = true,
        ['Character.bls_ina_se5_foodshop_01'] = true,
        ['Character.bls_ina_se5_gunsmith_01'] = true,
        ['Character.bls_ina_se5_junkshop_01'] = true,
        ['Character.bls_ina_se5_melee_01'] = true,
        ['Character.cct_cpz_cloth_02'] = true,
        ['Character.cct_cpz_food_01'] = true,
        ['Character.cct_cpz_food_02'] = true,
        ['Character.cct_cpz_medic_01'] = true,
        ['Character.cct_dtn_food_01'] = true,
        ['Character.cct_dtn_food_02'] = true,
        ['Character.cct_dtn_guns_01'] = true,
        ['Character.cct_dtn_medic_01'] = true,
        ['Character.cct_dtn_ripdoc_01'] = true,
        ['Character.cz_con_clothingshop_01'] = true,
        ['Character.cz_con_foodshop_01'] = true,
        ['Character.cz_con_gunsmith_01'] = true,
        ['Character.cz_con_junkshop_01'] = true,
        ['Character.cz_con_medicstore_01'] = true,
        ['Character.cz_con_netrunner_01'] = true,
        ['Character.cz_con_ripdoc_01'] = true,
        ['Character.cz_monument_foodshop_01'] = true,
        ['Character.cz_monument_ripperdoc_anderson'] = true,
        ['Character.cz_stadium_black_market_01'] = true,
        ['Character.cz_stadium_clothing_01'] = true,
        ['Character.cz_stadium_food_01'] = true,
        ['Character.cz_stadium_food_02'] = true,
        ['Character.cz_stadium_food_03'] = true,
        ['Character.cz_stadium_gunsmith_01'] = true,
        ['Character.cz_stadium_junk_01_marcin_i'] = true,
        ['Character.cz_stadium_junk_01_michal_k'] = true,
        ['Character.cz_stadium_medic_01'] = true,
        ['Character.cz_stadium_netrunner_01'] = true,
        ['Character.cz_stadium_qian_si_hu'] = true,
        ['Character.cz_stadium_ripperdoc_01'] = true,
        ['Character.hey_gle_foodshop_01'] = true,
        ['Character.hey_gle_foodshop_02'] = true,
        ['Character.hey_gle_gunsmith_01'] = true,
        ['Character.hey_gle_prostitute_female'] = true,
        ['Character.hey_gle_prostitute_male'] = true,
        ['Character.hey_rey_foodshop_02'] = true,
        ['Character.hey_rey_foodshop_03'] = true,
        ['Character.hey_rey_foodshop_04'] = true,
        ['Character.hey_rey_gunsmith_01'] = true,
        ['Character.hey_rey_netrunner_01'] = true,
        ['Character.hey_spr_clothingshop_01'] = true,
        ['Character.hey_spr_foodshop_01'] = true,
        ['Character.hey_spr_gunsmith_01'] = true,
        ['Character.hey_spr_junk_01'] = true,
        ['Character.hey_spr_medicstore_01'] = true,
        ['Character.hey_spr_ripperdoc_01'] = true,
        ['Character.lizzies_barman'] = true,
        ['Character.nw4_spaceport_medic_01'] = true,
        ['Character.pac_cvi_clothingshop_01'] = true,
        ['Character.pac_cvi_foodshop_01'] = true,
        ['Character.pac_cvi_medicstore_01'] = true,
        ['Character.pac_cvi_techstore_01'] = true,
        ['Character.pac_wwd_guns_01'] = true,
        ['Character.pac_wwd_melee_01'] = true,
        ['Character.pac_wwd_ripdoc_01'] = true,
        ['Character.std_arr_clothingshop_01'] = true,
        ['Character.std_arr_foodshop_01'] = true,
        ['Character.std_arr_foodshop_02'] = true,
        ['Character.std_arr_foodshop_03'] = true,
        ['Character.std_arr_gunsmith_01'] = true,
        ['Character.std_arr_medicstore_01'] = true,
        ['Character.std_arr_melee_01'] = true,
        ['Character.std_arr_ripperdoc_01'] = true,
        ['Character.std_arr_techstore_01'] = true,
        ['Character.std_rcr_clothingshop_01'] = true,
        ['Character.std_rcr_foodshop_01'] = true,
        ['Character.std_rcr_gunsmith_01'] = true,
        ['Character.std_rcr_medicstore_01'] = true,
        ['Character.std_rcr_ripperdoc_01'] = true,
        ['Character.std_rcr_techstore_01'] = true,
        ['Character.wat_kab_clothingshop_01'] = true,
        ['Character.wat_kab_foodshop_01'] = true,
        ['Character.wat_kab_foodshop_02'] = true,
        ['Character.wat_kab_foodshop_03'] = true,
        ['Character.wat_kab_foodshop_04'] = true,
        ['Character.wat_kab_gunsmith_01'] = true,
        ['Character.wat_kab_gunsmith_02'] = true,
        ['Character.wat_kab_junkshop_01'] = true,
        ['Character.wat_kab_medicstore_01'] = true,
        ['Character.wat_kab_netrunner_01'] = true,
        ['Character.wat_kab_ripperdoc_01'] = true,
        ['Character.wat_kab_ripperdoc_03'] = true,
        ['Character.wat_kab_techstore_01'] = true,
        ['Character.wat_lch_clothingshop_01'] = true,
        ['Character.wat_lch_foodshop_02'] = true,
        ['Character.wat_lch_medic_01'] = true,
        ['Character.wat_lch_melee_01'] = true,
        ['Character.wat_lch_melee_02'] = true,
        ['Character.wat_nid_clothingshop_01'] = true,
        ['Character.wat_nid_foodshop_01'] = true,
        ['Character.wat_nid_foodshop_02'] = true,
        ['Character.wat_nid_gunsmith_01'] = true,
        ['Character.wat_nid_medicstore_01'] = true,
        ['Character.wat_nid_medicstore_02'] = true,
        ['Character.wat_nid_ripperdoc_01'] = true,
        ['Character.wbr_hil_clothingshop_01'] = true,
        ['Character.wbr_hil_foodshop_01'] = true,
        ['Character.wbr_hil_foodshop_02'] = true,
        ['Character.wbr_hil_ripdoc_01'] = true,
        ['Character.wbr_jpn_cloth_01'] = true,
        ['Character.wbr_jpn_food_01'] = true,
        ['Character.wbr_jpn_food_02'] = true,
        ['Character.wbr_jpn_food_03'] = true,
        ['Character.wbr_jpn_food_04'] = true,
        ['Character.wbr_jpn_food_05'] = true,
        ['Character.wbr_jpn_guns_01'] = true,
        ['Character.wbr_jpn_jig_bar_01'] = true,
        ['Character.wbr_jpn_junk_01'] = true,
        ['Character.wbr_jpn_junk_03'] = true,
        ['Character.wbr_jpn_medic_01'] = true,
        ['Character.wbr_jpn_melee_01'] = true,
        ['Character.wbr_jpn_netrun_01'] = true,
        ['Character.wbr_jpn_prostitute_female'] = true,
        ['Character.wbr_jpn_prostitute_male'] = true,
        ['Character.wbr_jpn_ripdoc_01'] = true,
        ['Character.wbr_nok_medic_01'] = true,
    },
}
-- END GENERATED ARCHETYPES

-- Classification works on plain facts gathered by the adapter (init.lua);
-- this module never touches native objects.
local STORY_BOUND = {MainQuest = true, SideQuest = true, MinorQuest = true}
local function has(list, value)
    if type(list) ~= 'table' or value == nil then return false end
    for _, item in ipairs(list) do if item == value then return true end end
    return false
end
local function lowerPrefix(list, name)
    if type(list) ~= 'table' or type(name) ~= 'string' then return false end
    local bare = name:gsub('^Character%.', ''):lower()
    for _, prefix in ipairs(list) do
        if bare:sub(1, #prefix) == prefix:lower() then return true end
    end
    return false
end
local function containsToken(list, name)
    if type(list) ~= 'table' or type(name) ~= 'string' then return false end
    local bare = name:lower()
    for _, token in ipairs(list) do if bare:find(token:lower(), 1, true) then return true end end
    return false
end

-- 'MALE', 'FEMALE' or nil, from the explicit gender fact or the rig name
-- ("WomanAverage" contains "man", so women are checked first).
function M.gender(facts)
    local explicit = normalized(facts.gender)
    if explicit == 'female' then return 'FEMALE' end
    if explicit == 'male' then return 'MALE' end
    local body = normalized(facts.bodyType)
    if body:find('woman', 1, true) or body:find('female', 1, true) then return 'FEMALE' end
    if body:find('man', 1, true) or body:find('male', 1, true) then return 'MALE' end
    return nil
end

-- Lookup tables for one archetype data set. `records` maps record names (and,
-- once the adapter adds them, TweakDBID strings) to a base.
function M.buildArchetypes(data, enabledKeys)
    data = data or M.ARCHETYPES
    local index = {bases = data.bases or {}, keys = {}, byBase = {}, records = {}, vendorSpecific = {}, vendorGeneric = {},
        recordGenders = data.recordGenders or {}, vendorRecords = data.vendorRecords or {}}
    for _, variant in ipairs(data.variants or {}) do
        if index.bases[variant.base] and (not enabledKeys or enabledKeys[variant.key]) then
            index.keys[variant.key] = variant
            index.byBase[variant.base] = index.byBase[variant.base] or {}
            index.byBase[variant.base][variant.gender] = variant.key
        end
    end
    local names = {}
    for name in pairs(index.bases) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
        local base = index.bases[name]
        if base.category == 'resident' then
            for _, record in ipairs(base.records or {}) do index.records[record] = name end
        elseif base.category == 'vendor' then
            if base.records or base.recordTokens then index.vendorSpecific[#index.vendorSpecific + 1] = name
            else index.vendorGeneric[#index.vendorGeneric + 1] = name end
            for _, record in ipairs(base.records or {}) do index.records[record] = index.records[record] or name end
        end
    end
    return index
end

-- Quest-prefixed records (q105_..., sq027_..., mq041_...) are story actors.
function M.storyRecord(recordName)
    if type(recordName) ~= 'string' then return false end
    local bare = recordName:gsub('^Character%.', ''):lower()
    return bare:match('^q%d%d%d') ~= nil or bare:match('^sq%d%d%d') ~= nil or bare:match('^mq%d%d%d') ~= nil
end

-- A quest's crowd extra (Character.q005_afterlife_crowd_male): a crowd body whose quest record names it a crowd member. The owner
-- lets it talk as an ordinary person (2026-10-21); it stays protected (protectedReason), so no other system touches it in the scene.
function M.questCrowd(facts)
    if type(facts) ~= 'table' or facts.crowd ~= true then return false end
    local name = facts.recordName or facts.recordId
    if type(name) ~= 'string' then return false end
    local bare = name:gsub('^Character%.', ''):lower()
    return (bare:find('_crowd_', 1, true) ~= nil or bare:sub(-6) == '_crowd') and (M.storyRecord(name) or facts.quest ~= nil)
end

-- Which base describes these facts, or nil. Facts (all optional): vendor,
-- vendorType, affiliation, police, crowd, children, human, quest, recordName,
-- recordId. A child, a machine and a main/side quest actor are never routed to
-- an archetype (a vendor still is, unless main-quest bound). facts.storyOk = true (fallbackKey only) skips the quest rule:
-- an unnamed quest-bound person is then classified by what else is known of them (affiliation, vendor, record tokens).
function M.classifyBase(index, facts)
    if type(index) ~= 'table' or type(facts) ~= 'table' then return nil, 'no-facts' end
    if facts.children == true then return nil, 'child' end
    if facts.human == false then return nil, 'not-human' end
    local recordName, recordId = facts.recordName, facts.recordId
    local recordBase = (recordName and index.records[recordName]) or (recordId and index.records[recordId])
    if facts.vendor == true and (facts.quest ~= 'MainQuest' or facts.storyOk == true) then
        for _, name in ipairs(index.vendorSpecific) do
            local base = index.bases[name]
            if has(base.vendorTypes, facts.vendorType)
                and (recordBase == name or containsToken(base.recordTokens, recordName)) then return name, 'vendor' end
        end
        for _, name in ipairs(index.vendorGeneric) do
            if has(index.bases[name].vendorTypes, facts.vendorType) then return name, 'vendor' end
        end
    end
    if (STORY_BOUND[facts.quest or ''] or M.storyRecord(recordName)) and not M.questCrowd(facts) and facts.storyOk ~= true then return nil, 'story-bound' end
    local names = {}
    for name in pairs(index.bases) do names[#names + 1] = name end
    table.sort(names)
    for _, category in ipairs({'police', 'corpo-security', 'faction', 'gang'}) do
        for _, name in ipairs(names) do
            local base = index.bases[name]
            if base.category == category then
                local matched = has(base.affiliations, facts.affiliation)
                    or (base.police and facts.police == true)
                    or lowerPrefix(base.recordPrefixes, recordName)
                    or containsToken(base.recordTokens, recordName)
                if matched and not lowerPrefix(base.excludeRecordPrefixes, recordName) then return name, category end
                if matched then return nil, 'excluded-record' end
            end
        end
    end
    if facts.crowd == true then
        if recordBase and index.bases[recordBase] and index.bases[recordBase].category == 'resident' then return recordBase, 'resident' end
        for _, name in ipairs(names) do
            local base = index.bases[name]
            if base.category == 'resident' and lowerPrefix(base.recordPrefixes, recordName) then return name, 'resident' end
        end
    end
    return nil, 'unclassified'
end

-- The archetype profile key for these facts, or nil (with a reason).
function M.classify(index, facts)
    local base, reason = M.classifyBase(index, facts)
    if not base then return nil, reason end
    local gender = M.gender(facts)
    local variants = index.byBase[base]
    local key = variants and gender and variants[gender]
    if not key then return nil, 'no-variant' end
    return key, base
end

-- The kind of ordinary person a record name suggests, for the generic fallback: lower-case token -> resident base. First match
-- in this order wins; a base that has no variant for the gender is skipped. Not generated: a small list of plain words.
local FALLBACK_KINDS = {
    {'ep1_', 'dogtown-resident'}, {'homeless', 'homeless'}, {'nomad', 'nomad-resident'}, {'nightlife', 'nightlife-resident'},
    {'receptionist', 'corpo-resident'}, {'corpo', 'corpo-resident'}, {'worker', 'worker-resident'}, {'waitress', 'worker-resident'},
    {'janitor', 'worker-resident'}, {'cleaner', 'worker-resident'},
}

-- The archetype for a person the game placed that has no roster profile and that no archetype rule claims (an unclassified
-- worker, a quest-bound receptionist, a MaxTac officer): the best archetype the facts allow, else a resident of their gender.
-- Never for a child or a machine. Returns key, base-or-kind on success; nil and a reason otherwise: 'no-facts', 'child',
-- 'not-human' or 'no-gender'. Plain data only; bodyType (optional) is the rig name when the facts carry none. lastReason (optional): why
-- the ordinary classification just failed; only 'story-bound' (or unknown) is classified again without the quest rule, so the common
-- case (nothing matched) costs no second pass.
function M.fallbackKey(index, facts, bodyType, lastReason)
    if type(index) ~= 'table' or type(facts) ~= 'table' then return nil, 'no-facts' end
    if facts.children == true then return nil, 'child' end
    if facts.human == false then return nil, 'not-human' end
    local copy = facts
    if lastReason == nil or lastReason == 'story-bound' then
        copy = {}
        for name, value in pairs(facts) do copy[name] = value end
        copy.storyOk = true
        if copy.bodyType == nil or copy.bodyType == '' then copy.bodyType = bodyType end
        local key, base = M.classify(index, copy)
        if key then return key, base end
    end
    local gender = M.gender(copy) or M.gender({bodyType = bodyType}) or M.nameGender(copy.recordName)
    if not gender then return nil, 'no-gender' end
    local bare = type(copy.recordName) == 'string' and copy.recordName:lower() or ''
    for _, kind in ipairs(FALLBACK_KINDS) do
        local variants = index.byBase[kind[2]]
        if variants and variants[gender] and bare:find(kind[1], 1, true) then return variants[gender], kind[2] end
    end
    return gender == 'FEMALE' and 'resident-female' or 'resident-male', 'resident'
end

-- The stable identity of a shop V can come back to: the TweakDB record of a
-- vendor that has a record of its own (one physical shopkeeper), as
-- "wat_kab_ripperdoc_01". Nil for everyone else (crowd, goons, the shared
-- street-stall records, a main-quest vendor): those conversations stay
-- session-only. docs/NPC_ARCHETYPES.md, "Vendor memory".
function M.memoryKey(index, facts)
    if type(index) ~= 'table' or type(facts) ~= 'table' or facts.vendor ~= true or facts.quest == 'MainQuest' then return nil end
    local name = facts.recordName
    if type(name) ~= 'string' or not (index.vendorRecords or {})[name] then return nil end
    return (name:gsub('^Character%.', ''))
end

-- Plain description of the classified actor for the per-turn context. Only
-- fixed vocabulary leaves the game: no free text, handles or IDs (the memory
-- key is a record name from the shipped game data).
function M.describe(index, key, facts)
    facts = facts or {}
    local variant = index.keys[key]
    if not variant then return nil end
    local base = index.bases[variant.base] or {}
    return {base = variant.base, category = base.category, title = base.title,
        affiliation = facts.affiliation ~= 'Unknown' and facts.affiliation or nil,
        vendorType = facts.vendor == true and facts.vendorType or nil,
        memoryKey = base.category == 'vendor' and M.memoryKey(index, facts) or nil}
end

-- Gender from a record name alone ("_wa", "Woman", "CorpoManBig", "barman"); women first.
-- Mirrors scripts/Extract-ArchetypeRecordGenders.mjs nameGender.
local FEMALE_TOKENS = {woman = true, women = true, female = true, girl = true, w = true, wa = true, wb = true, wc = true,
    waf = true, wbf = true, wah = true, wf = true}
local MALE_TOKENS = {man = true, men = true, male = true, boy = true, m = true, ma = true, mb = true, mc = true,
    maf = true, mbf = true, mah = true, mbh = true, mf = true}
local function ends(value, suffix) return #value >= #suffix and value:sub(-#suffix) == suffix end
function M.nameGender(name)
    if type(name) ~= 'string' or name == '' then return nil end
    local text = name:gsub('^Character%.', ''):gsub('([%l%d])(%u)', '%1_%2'):lower()
    local tokens = {}
    for token in text:gmatch('[%l%d]+') do tokens[#tokens + 1] = token end
    for _, token in ipairs(tokens) do
        if FEMALE_TOKENS[token] or ends(token, 'woman') or ends(token, 'female') then return 'FEMALE' end
    end
    for _, token in ipairs(tokens) do
        if MALE_TOKENS[token] or ends(token, 'man') or ends(token, 'male') then return 'MALE' end
    end
    return nil
end

-- A character record from the Model browser (no live body): the conversation
-- profile a spawned copy of it should use, or nil. Facts come from TweakDB only
-- (recordName, affiliation, vendor, vendorType, crowd, children, human, quest).
-- Quest-prefixed records (q105_..., sq027_..., mq041_...) are story actors.
-- Crowd records without a resident kind fall back to the two residents.
function M.classifyRecord(index, facts)
    if type(index) ~= 'table' or type(facts) ~= 'table' or type(facts.recordName) ~= 'string' then return nil, 'no-facts' end
    if M.storyRecord(facts.recordName) then return nil, 'story-bound' end
    local gender = index.recordGenders[facts.recordName] or M.nameGender(facts.recordName)
    if not gender then return nil, 'no-gender' end
    local copy = {}
    for name, value in pairs(facts) do copy[name] = value end
    copy.gender, copy.bodyType = gender == 'FEMALE' and 'Female' or 'Male', nil
    local key, reason = M.classify(index, copy)
    if key then return key, reason end
    if reason == 'unclassified' and facts.crowd == true then
        return gender == 'FEMALE' and 'resident-female' or 'resident-male', 'resident'
    end
    return nil, reason
end

-- Display name of an archetype key ("Maelstrom ganger"), or nil.
function M.archetypeLabel(index, key)
    local variant = index and index.keys[key]
    local base = variant and index.bases[variant.base]
    if not base or type(base.title) ~= 'string' then return nil end
    return base.title:sub(1, 1):upper() .. base.title:sub(2)
end

-- Why a character the game placed (not our spawned copy) is off limits to every mod system, or nil. Off limits means
-- no look-at, bark muting, tactic target, perception change, face rebuild or conversation: the mod acts as if it were
-- not installed for them. Plain data only: actor = {record, name, facts = {quest, recordName}}. Named roster
-- characters (by record or name) and quest-bound ones (a quest flag, or a q###/sq###/mq### record) are protected.
-- A vendor with a minor quest flag can still be talked to (resolve), but no other system touches it.
function M.protectedReason(catalog, actor)
    if type(catalog) ~= 'table' or type(actor) ~= 'table' then return nil end
    local facts = type(actor.facts) == 'table' and actor.facts or {}
    if (actor.record and catalog.records[actor.record]) or (type(facts.recordName) == 'string' and catalog.records[facts.recordName])
        or catalog.names[normalized(actor.name)] then return 'named' end
    if STORY_BOUND[facts.quest or ''] then return 'quest' end
    if M.storyRecord(facts.recordName) then return 'story-record' end
    return nil
end

-- Why a character the game placed ends with no conversation profile, as one word, for the notice the talk key shows. Plain data
-- (actor as for resolve: record, name, facts, bodyType). 'named' is a roster character (a story character: Talk to story
-- characters is off), 'child', 'not-human' and 'no-gender' are the only people nobody can talk to, 'unknown' is anything else.
function M.noProfileReason(catalog, actor)
    if type(catalog) ~= 'table' or type(actor) ~= 'table' then return 'unknown' end
    local facts = type(actor.facts) == 'table' and actor.facts or {}
    if M.protectedReason(catalog, {record = actor.record, name = actor.name, facts = facts}) == 'named' then return 'named' end
    local _, kind = M.fallbackKey(catalog.archetypes, facts, actor.bodyType)
    if kind == 'child' or kind == 'not-human' or kind == 'no-gender' then return kind end
    return 'unknown'
end

-- Record-cloning mods spawn a character from a copy of its record named "<prefix><original record>" (Night City Allies:
-- NCA.Character.Judy, docs/NCA_FOLLOWERS_PLAN.md). The copy keeps every flat, so it is the same person: every roster record
-- also matches under each prefix, and no row needs to list its clones. A prefix is data here, not a mod check: nothing
-- reads another mod's presence, and a record that does not exist costs one unused table entry. A numbered copy
-- ("NCA.<number>", made when the original has no debug name) has no readable original, so it resolves by display name.
M.CLONE_PREFIXES = {'NCA.'}

-- The original record name behind a clone's debug name ("NCA.Character.Judy" -> "Character.Judy"), the name itself for an
-- original ("Character.Judy"), or nil for anything else (a number, another family).
function M.originalRecordName(text)
    if type(text) ~= 'string' then return nil end
    if text:find('^Character%.') then return text end
    for _, prefix in ipairs(M.CLONE_PREFIXES) do
        if text:sub(1, #prefix) == prefix and text:sub(#prefix + 1):find('^Character%.') then return text:sub(#prefix + 1) end
    end
    return nil
end

-- True for a record name that a record-cloning mod made ("NCA.Character.Judy", "NCA.12345"): it starts with one of the prefixes.
function M.isCloneRecord(text)
    if type(text) ~= 'string' then return false end
    for _, prefix in ipairs(M.CLONE_PREFIXES) do
        if text:sub(1, #prefix) == prefix and #text > #prefix then return true end
    end
    return false
end

-- True for the key of a character the player made ("custom-rebecca-k3j9"): the prefix is reserved, no roster key starts with it.
function M.isCustomKey(key)
    return type(key) == 'string' and key:find('^custom%-') ~= nil
end

function M.build(profiles, archetypes)
    local catalog = {keys = {}, names = {}, records = {}, archetypes = archetypes}
    for _, profile in ipairs(profiles) do
        catalog.keys[profile.key] = profile
        catalog.names[normalized(profile.name)] = profile
        for _, alias in ipairs(profile.aliases or {}) do catalog.names[normalized(alias)] = profile end
        for _, record in ipairs(profile.records or {}) do catalog.records[record] = profile end
    end
    -- The clone names, after every explicit record, so a row that lists its own clone keeps it.
    for _, profile in ipairs(profiles) do
        for _, record in ipairs(profile.records or {}) do
            if type(record) == 'string' and record:find('^Character%.') then
                for _, prefix in ipairs(M.CLONE_PREFIXES) do
                    if catalog.records[prefix .. record] == nil then catalog.records[prefix .. record] = profile end
                end
            end
        end
    end
    return catalog
end
function M.resolve(catalog, actor)
    if actor.managedKey or actor.copy then
        local profile = actor.managedKey and catalog.keys[actor.managedKey]
        -- A copy of ours keeps its roster profile (a roster profile always wins; the two ambient residents are crowd stand-ins, not roster people).
        -- Any other copy (a generic model, an archetype, a resident, a model with no profile at all: the Model browser's) can be a character the player made (docs/CHARACTER_EDITOR.md "Matching"), found the way custom.match finds
        -- anybody: by the model's record (actor.copyRecord, the original "Character." name the copy was made from, not the private clone the game
        -- spawned) or its name (actor.copyName). actor.managedKey is the profile the copy was made with, never a custom key. catalog.custom is
        -- nil until a character exists, so without one this is a single comparison.
        local custom = (not profile or profile.kind == 'ambient') and catalog.custom
        if custom then
            local entry = custom.match({record = actor.copyRecord or actor.record, name = actor.copyName or actor.name})
            if entry then return entry.key, entry.name end
        end
        if actor.managedKey then return actor.managedKey, profile and profile.name or actor.name end
        return nil, actor.name
    end
    -- The record by its hash string (actor.record), then by its readable name (actor.facts.recordName, set when the facts were read) and the display name. A
    -- named roster character whose hash string did not match (2026-10-22: Panam in her apartment scene fell to npc-aldecaldos-female) is still found by name.
    local facts = type(actor.facts) == 'table' and actor.facts or nil
    local profile = catalog.records[actor.record] or (facts and type(facts.recordName) == 'string' and catalog.records[facts.recordName])
        or catalog.names[normalized(actor.name)]
    if profile then
        -- actor.world: a character the game placed in the world, not our spawned copy. A named roster character there
        -- is the game's own (a quest or scene may drive it): only the copy the mod spawned talks. Name lookups that
        -- only attribute a line to a profile (game dialogue context) leave world unset.
        -- actor.story: the player allows talking to the game's own named characters (docs/WORLD_CHARACTERS.md): the roster
        -- profile resolves for the character the game placed, and nothing else about it changes (it never falls back below).
        if actor.world == true and actor.story ~= true then return nil, actor.name end
        return profile.key, profile.name
    end
    -- A character the player made (mod/custom-characters.lua, docs/CHARACTER_EDITOR.md): after every roster profile, so a roster profile always
    -- wins, and before the archetypes and residents. catalog.custom stays nil until one exists; without one this is a single comparison.
    local custom = catalog.custom
    if custom then
        local entry = custom.match(actor)
        if entry then return entry.key, entry.name end
    end
    if catalog.archetypes and type(actor.facts) == 'table' then
        local key, reason = M.classify(catalog.archetypes, actor.facts)
        if key then return key, actor.name, M.describe(catalog.archetypes, key, actor.facts) end
        -- A person the game placed that no roster profile names (a quest-bound receptionist, a worker the archetypes do not list, a
        -- MaxTac officer) always gets a conversation: the best archetype their facts allow, else a resident of their gender
        -- (M.fallbackKey). Only a child, a machine or a person whose gender cannot be told ends with no profile; a crowd child keeps
        -- the old resident fallback below. Named roster characters resolved above and keep their own rules.
        if actor.world == true then
            local fallback, kind = M.fallbackKey(catalog.archetypes, actor.facts, actor.bodyType, reason)
            if fallback then return fallback, actor.name, M.describe(catalog.archetypes, fallback, actor.facts) end
            if kind == 'child' or kind == 'not-human' then
                if not actor.crowd then return nil, actor.name end
            elseif kind == 'no-gender' then
                return nil, actor.name
            end
        end
        -- actor.spawned: a copy of a quest character's model that another mod or a spawner created (docs/SPAWNED_CHARACTERS.md).
        -- It is player-made, not the quest's actor: classify it by its other facts (affiliation, crowd), else as a resident.
        if actor.spawned == true and reason == 'story-bound' then
            local plain = {}
            for name, value in pairs(actor.facts) do plain[name] = value end
            plain.quest, plain.recordName, plain.recordId = nil, nil, nil
            if plain.bodyType == nil then plain.bodyType = actor.bodyType end
            local again = M.classify(catalog.archetypes, plain)
            if again then return again, actor.name, M.describe(catalog.archetypes, again, plain) end
            local gender = plain.human ~= false and plain.children ~= true and M.gender(plain) or nil
            if gender == 'FEMALE' then return 'resident-female', actor.name end
            if gender == 'MALE' then return 'resident-male', actor.name end
            return nil, actor.name
        end
        -- A spawned human the archetypes do not know (a spawner's generic mercenary or roamer, whose faction has no archetype) is
        -- an ordinary person too: a resident by body, never a named character and never a child or a machine.
        if actor.spawned == true and reason == 'unclassified' and actor.facts.human ~= false and actor.facts.children ~= true then
            local plain = {}
            for name, value in pairs(actor.facts) do plain[name] = value end
            if plain.bodyType == nil then plain.bodyType = actor.bodyType end
            local gender = M.gender(plain)
            if gender == 'FEMALE' then return 'resident-female', actor.name end
            if gender == 'MALE' then return 'resident-male', actor.name end
        end
    end
    if not actor.crowd then return nil, actor.name end
    local body = normalized(actor.bodyType)
    if body:find('woman',1,true) or body:find('female',1,true) then return 'resident-female', actor.name end
    if body:find('man',1,true) or body:find('male',1,true) then return 'resident-male', actor.name end
    return nil, actor.name
end
return M
