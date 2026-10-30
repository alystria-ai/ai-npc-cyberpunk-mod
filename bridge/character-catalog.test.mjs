import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
test('named identities take priority over rig and crowd classification',()=>{
  const source=readFileSync(new URL('../mod/character-catalog.lua',import.meta.url),'utf8');
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const code=`local api=(function() ${source} end)()
    local catalog=api.build({
      {key='alex',name='Alex',aliases={'Alena Xenakis'},records={'Character.alex'}},
      {key='8ug8ear',name='8ug8ear'},
      {key='resident-female',name='Night City Resident Female'}
    })
    assert(api.resolve(catalog,{managedKey='8ug8ear',name='Unknown',bodyType='WomanAverage',crowd=true})=='8ug8ear')
    assert(api.resolve(catalog,{name=' ALENA XENAKIS ',bodyType='WomanAverage'})=='alex')
    assert(api.resolve(catalog,{name='Localized Name',record='Character.alex',bodyType='WomanAverage'})=='alex')
    assert(api.resolve(catalog,{name='Unknown Quest NPC',bodyType='WomanAverage',crowd=false})==nil)
    assert(api.resolve(catalog,{name='NC Resident',bodyType='WomanAverage',crowd=true})=='resident-female')
    assert(api.resolve(catalog,{managedKey='not-provisioned',name='Unknown',crowd=true})=='not-provisioned')
  `;
  const result=lauxlib.luaL_dostring(state,to_luastring(code));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state);assert.equal(result,lua.LUA_OK,error);
});

// Generic NPC archetypes (docs/NPC_ARCHETYPES.md): classification from TweakDB facts, precedence and routing.
const runLua=code=>{
  const source=readFileSync(new URL('../mod/character-catalog.lua',import.meta.url),'utf8');
  const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
  const result=lauxlib.luaL_dostring(state,to_luastring(`local api=(function() ${source} end)()\nlocal function eq(a,b,m) assert(a==b,(m or 'values differ')..': expected '..tostring(b)..', got '..tostring(a)) end\n${code}`));
  const error=result===lua.LUA_OK?'':to_jsstring(lua.lua_tostring(state,-1));
  lua.lua_close(state);assert.equal(result,lua.LUA_OK,error);
};
test('archetype classification follows vendor, police, corporate security, gang, resident precedence',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local function key(facts) return (api.classify(index,facts)) end
    assert(key({affiliation='Maelstrom',bodyType='ManAverage'})=='npc-maelstrom-male')
    assert(key({affiliation='Maelstrom',bodyType='WomanAverage'})=='npc-maelstrom-female', 'woman contains man')
    assert(key({affiliation='MaelstromAndroid',bodyType='ManBig',human=true})=='npc-maelstrom-male')
    assert(key({affiliation='TygerClaws',gender='Female'})=='npc-tyger-claws-female')
    assert(key({affiliation='Barghest',bodyType='ManAverage'})=='npc-barghest-male')
    assert(key({affiliation='TheMox',bodyType='WomanAverage'})=='npc-mox-female')
    -- A vendor wins over a gang affiliation (Character.wat_kab_gunsmith_02 inherits a Maelstrom record).
    assert(key({vendor=true,vendorType='Gunsmith',affiliation='Maelstrom',bodyType='ManAverage'})=='npc-weapons-dealer-male')
    assert(key({vendor=true,vendorType='RipperDoc',bodyType='WomanAverage'})=='npc-ripperdoc-female')
    assert(key({vendor=true,vendorType='Food',recordName='Character.wat_kab_foodshop_04',bodyType='ManAverage'})=='npc-bartender-male')
    assert(key({vendor=true,vendorType='Food',recordName='Character.wat_kab_foodshop_01',bodyType='ManAverage'})=='npc-food-vendor-male')
    assert(key({vendor=true,vendorType='Clothing',bodyType='WomanAverage'})=='npc-clothing-vendor-female')
    assert(key({vendor=true,vendorType='VendingMachine',bodyType='ManAverage'})==nil, 'not a talking vendor type')
    -- Police by affiliation or flag; MaxTac has its own kind (2026-10-22), the plain NCPD kind excludes it.
    assert(key({affiliation='NCPD',bodyType='ManAverage'})=='npc-ncpd-male')
    assert(key({police=true,affiliation='Unknown',bodyType='WomanAverage'})=='npc-ncpd-female')
    assert(key({affiliation='NCPD',recordName='Character.maxtac_rifle_ma',bodyType='ManAverage'})=='npc-maxtac-male')
    assert(key({affiliation='NCPD',recordName='Character.prevention_maxtac_rifle_wa',police=true,bodyType='WomanAverage'})=='npc-maxtac-female')
    assert(key({affiliation='NCPD',recordName='Character.ncpd_police_ranged1_omaha_ma',police=true,bodyType='ManAverage'})=='npc-ncpd-male')
    -- Sex workers (crowd and vendor records), NUSA personnel and Zetatech guards (2026-10-22).
    assert(key({crowd=true,recordName='Character.ProstituteFemale',bodyType='WomanAverage'})=='npc-joytoy-female')
    assert(key({recordName='Character.hey_gle_prostitute_male',bodyType='ManAverage'})=='npc-joytoy-male')
    assert(key({crowd=true,recordName='Character.SexworkerMaleDoll',bodyType='ManAverage'})=='npc-joytoy-male')
    assert(key({affiliation='NUSA',bodyType='ManAverage'})=='npc-nusa-male')
    assert(key({affiliation='NUSA_Myers',bodyType='WomanAverage'})=='npc-nusa-female')
    assert(key({affiliation='Zetatech',recordName='Character.security_guard1_ranged1_nue_wa',bodyType='WomanAverage'})=='npc-corpo-security-female')
    assert(key({affiliation='Arasaka',bodyType='ManAverage'})=='npc-corpo-security-male')
    assert(key({affiliation='UnaffiliatedCorpo',recordName='Character.security_guard1_ranged1_ma',bodyType='ManAverage'})=='npc-corpo-security-male')
    -- Story-bound actors keep the game's own role; street stories and gigs are generic.
    assert(key({affiliation='Valentinos',quest='MainQuest',bodyType='ManAverage'})==nil)
    assert(key({affiliation='Valentinos',quest='SideQuest',bodyType='ManAverage'})==nil)
    assert(key({affiliation='Valentinos',quest='StreetStory',bodyType='ManAverage'})=='npc-valentinos-male')
    assert(key({vendor=true,vendorType='RipperDoc',quest='StreetStory',bodyType='ManAverage'})=='npc-ripperdoc-male')
    -- Residents need the crowd flag and a known crowd record (by name, prefix or TweakDBID string).
    assert(key({crowd=true,recordName='Character.CorpoWomanBag',bodyType='WomanAverage'})=='npc-corpo-resident-female')
    assert(key({crowd=true,recordName='Character.HomelessManDE',bodyType='ManAverage'})=='npc-homeless-male')
    assert(key({crowd=true,recordName='Character.LowlifeMaleNewVariant',bodyType='ManAverage'})=='npc-street-resident-male')
    assert(key({crowd=true,recordName='Character.CitizenAldecaldosFemaleNomad',bodyType='WomanAverage'})=='npc-nomad-resident-female')
    index.records['ToTweakDBID{ hash = 0x1, length = 21 }']='homeless'
    assert(key({crowd=true,recordId='ToTweakDBID{ hash = 0x1, length = 21 }',bodyType='WomanAverage'})=='npc-homeless-female')
    assert(key({crowd=false,recordName='Character.CorpoMan',bodyType='ManAverage'})==nil, 'a non-crowd actor is not a pedestrian')
    assert(key({crowd=true,recordName='Character.Mallrat',bodyType='WomanAverage'})==nil)
    -- Never children, machines or a body without a gender.
    assert(key({crowd=true,children=true,recordName='Character.CorpoMan',bodyType='ManAverage'})==nil)
    assert(key({affiliation='Maelstrom',human=false,bodyType='ManAverage'})==nil)
    assert(key({affiliation='Maelstrom',bodyType='Unknown'})==nil)
    assert(api.classifyBase(index,{affiliation='SixthStreet'})=='sixth-street')
    local info=api.describe(index,'npc-weapons-dealer-male',{vendor=true,vendorType='Gunsmith',affiliation='Maelstrom'})
    assert(info.base=='weapons-dealer' and info.category=='vendor' and info.vendorType=='Gunsmith' and info.title=='weapons dealer')
  `);
});
test('resolve keeps named and managed identities first, then archetypes, then the resident fallback',()=>{
  runLua(`
    local catalog=api.build({{key='viktor-vektor',name='Viktor Vektor',records={'Character.Victor_Vector'}},
      {key='resident-male',name='Night City Resident Male'},{key='resident-female',name='Night City Resident Female'}},
      api.buildArchetypes(api.ARCHETYPES))
    local ripper={vendor=true,vendorType='RipperDoc',bodyType='ManAverage'}
    assert(api.resolve(catalog,{name='Viktor Vektor',record='Character.Victor_Vector',facts=ripper})=='viktor-vektor')
    assert(api.resolve(catalog,{managedKey='judy-alvarez',name='Judy',facts=ripper})=='judy-alvarez')
    local key,name,info=api.resolve(catalog,{name='Ripperdoc',bodyType='ManAverage',facts=ripper})
    assert(key=='npc-ripperdoc-male' and name=='Ripperdoc' and info.base=='ripperdoc')
    assert(api.resolve(catalog,{name='Pedestrian',bodyType='WomanAverage',crowd=true,
      facts={crowd=true,recordName='Character.Mallrat',bodyType='WomanAverage'}})=='resident-female')
    -- A quest-bound person with no roster profile (2026-10-22: every NPC V can target is talkable): the archetype their other facts give,
    -- else a resident of their gender. Without a world flag (game dialogue attribution) nothing changes.
    assert(api.resolve(catalog,{name='Ganger',bodyType='ManAverage',crowd=false,
      facts={affiliation='Valentinos',quest='MainQuest',bodyType='ManAverage'}})==nil)
    assert(api.resolve(catalog,{world=true,name='Ganger',bodyType='ManAverage',crowd=false,
      facts={affiliation='Valentinos',quest='MainQuest',bodyType='ManAverage'}})=='npc-valentinos-male')
    -- A quest's crowd extra (the Afterlife patrons) talks as an ordinary person, and so does an unnamed quest actor of the same quest.
    assert(api.resolve(catalog,{world=true,name='Afterlife patron',bodyType='ManAverage',crowd=true,
      facts={crowd=true,quest='MainQuest',recordName='Character.q005_afterlife_crowd_male',bodyType='ManAverage'}})=='resident-male')
    assert(api.resolve(catalog,{world=true,name='Bouncer',bodyType='ManAverage',crowd=false,
      facts={crowd=false,quest='MainQuest',recordName='Character.q005_afterlife_crowd_male',bodyType='ManAverage'}})=='resident-male')
    assert(api.resolve(catalog,{world=true,name='Goon',bodyType='ManAverage',crowd=true,
      facts={crowd=true,quest='MainQuest',recordName='Character.q005_afterlife_bouncer',bodyType='ManAverage'}})=='resident-male')
    assert(api.questCrowd({crowd=true,recordName='Character.sq021_party_crowd'})==true)
    assert(api.questCrowd({crowd=true,recordName='Character.crowdrat'})==false)
    -- Without facts (the setting is off) the previous behaviour is unchanged.
    assert(api.resolve(catalog,{name='Pedestrian',bodyType='ManAverage',crowd=true})=='resident-male')
    assert(api.resolve(catalog,{name='Maelstrom',bodyType='ManAverage',crowd=false})==nil)
  `);
});
test('the generated archetype block matches characters/archetypes.json and every variant is in the archetype roster',async()=>{
  const {luaArchetypeBlock,LUA_BEGIN,LUA_END}=await import('../scripts/Build-ArchetypeProfiles.mjs');
  const catalog=JSON.parse(readFileSync(new URL('../characters/archetypes.json',import.meta.url),'utf8'));
  const source=readFileSync(new URL('../mod/character-catalog.lua',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const table=JSON.parse(readFileSync(new URL('../characters/archetype-record-genders.json',import.meta.url),'utf8'));
  assert.equal(source.slice(source.indexOf(LUA_BEGIN),source.indexOf(LUA_END)+LUA_END.length),luaArchetypeBlock(catalog,table.records,table.uniqueVendors));
  const roster=JSON.parse(readFileSync(new URL('../characters/archetype-roster.json',import.meta.url),'utf8'));
  assert.deepEqual(roster.map(p=>p.key),catalog.archetypes.map(a=>a.key));
  for(const base of Object.keys(catalog.bases))for(const gender of ['male','female'])
    assert(roster.some(p=>p.key===`npc-${base}-${gender}`),`${base} ${gender}`);
  const named=JSON.parse(readFileSync(new URL('../characters/roster.json',import.meta.url),'utf8'));
  assert(!named.some(p=>p.key.startsWith('npc-')),'archetypes stay out of the named roster');
});
test('Model browser records classify from TweakDB facts alone; record-name gender matches the extractor rule',async()=>{
  const {nameGender}=await import('../scripts/Extract-ArchetypeRecordGenders.mjs');
  const names=['maelstrom_grunt1_ranged1_lexington_ma','tyger_claws_gang_wa','CorpoWoman','CorpoManAfterWork','HomelessFemale',
    'Grilled_Food_Woman','Grilled_Food','ep1_combat_zone_citizen_obese_waf','ep1_combat_zone_citizen_obese_mf','Waitress','lizzies_barman',
    'Policeman','WomanChubbyCorpo','LightCrowd_kabuki_ma','CitizenAldecaldosFemaleNomad','arasaka_ninja_fmelee3_katana_wa','Character.Mallrat'];
  const expected=names.map(name=>`${name}=${nameGender(name)??'nil'}`).join(';');
  runLua(`
    local out={}
    for _,name in ipairs({${names.map(name=>`'${name}'`).join(',')}}) do out[#out+1]=name..'='..tostring(api.nameGender(name) or 'nil') end
    assert(table.concat(out,';')=='${expected}', table.concat(out,';'))
    local index=api.buildArchetypes(api.ARCHETYPES)
    local function key(facts) return (api.classifyRecord(index,facts)) end
    assert(key({recordName='Character.maelstrom_grunt1_ranged1_lexington_ma',affiliation='Maelstrom'})=='npc-maelstrom-male')
    assert(key({recordName='Character.tyger_claws_biker3_shotgun3_zhuo_ma_elite',affiliation='TygerClaws'})=='npc-tyger-claws-male')
    assert(key({recordName='Character.arasaka_ninja_fmelee3_katana_wa',affiliation='Arasaka'})=='npc-corpo-security-female')
    assert(key({recordName='Character.ncpd_police_ranged1_omaha_wa',affiliation='NCPD'})=='npc-ncpd-female')
    assert(key({recordName='Character.maxtac_rifle_ma',affiliation='NCPD'})=='npc-maxtac-male')
    assert(key({recordName='Character.kurtz_base',affiliation='Barghest'})==nil, 'no gender in the name')
    -- Vendor records take their gender from the generated table (shipped tweak sources).
    assert(key({recordName='Character.wat_kab_ripperdoc_01',affiliation='Civilian',vendor=true,vendorType='RipperDoc'})=='npc-ripperdoc-male')
    assert(key({recordName='Character.hey_spr_gunsmith_01',vendor=true,vendorType='Gunsmith'})=='npc-weapons-dealer-female')
    assert(key({recordName='Character.cz_monument_foodshop_01',vendor=true,vendorType='Food'})=='npc-bartender-female')
    assert(key({recordName='Character.wat_kab_gunsmith_02',affiliation='Maelstrom',vendor=true,vendorType='Gunsmith'})=='npc-weapons-dealer-male')
    -- Crowd records: a resident kind, else the generic resident; never children or machines.
    assert(key({recordName='Character.HomelessFemaleDE',crowd=true})=='npc-homeless-female')
    assert(key({recordName='Character.LightCrowd_kabuki_wa',crowd=true})=='resident-female')
    assert(key({recordName='Character.ChildPoor_ma',crowd=true,children=true})==nil)
    assert(key({recordName='Character.TrainingRobot_ma',crowd=true,human=false})==nil)
    -- Story actors stay without a profile: quest tags and quest-prefixed record names.
    assert(key({recordName='Character.valentinos_grunt2_ma',affiliation='Valentinos',quest='SideQuest'})==nil)
    assert(key({recordName='Character.q105_tyger_ma',affiliation='TygerClaws'})==nil)
    assert(key({recordName='Character.sq021_mox_wa',affiliation='TheMox'})==nil)
    assert(key({recordName='Character.mq041_ncpd_ma',affiliation='NCPD'})==nil)
    assert(key({recordName='Character.generic_street_base_ma',affiliation='Unaffiliated'})==nil)
    assert(api.archetypeLabel(index,'npc-mox-female')=='Mox member' and api.archetypeLabel(index,'npc-ripperdoc-male')=='Ripperdoc')
    assert(api.archetypeLabel(index,'judy-alvarez')==nil)
  `);
});

// Second batch (docs/NPC_ARCHETYPES.md): more vendor kinds, factions and resident kinds, one-shop vendor memory keys.
test('second batch: vendor kinds, factions and resident kinds classify with the documented precedence',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local function key(facts) return (api.classify(index,facts)) end
    local M,F='ManAverage','WomanAverage'
    -- Vendors by type; skill-trainer vendors split on the record name; plain trainers stay unprofiled.
    assert(key({vendor=true,vendorType='Medical',recordName='Character.wat_kab_medicstore_01',bodyType=M})=='npc-medic-vendor-male')
    assert(key({vendor=true,vendorType='Medical',bodyType=F})=='npc-medic-vendor-female')
    assert(key({vendor=true,vendorType='Junk',bodyType=M})=='npc-junk-dealer-male')
    assert(key({vendor=true,vendorType='TechJunk',recordName='Character.Tech_Junk',bodyType=F})=='npc-junk-dealer-female')
    assert(key({vendor=true,vendorType='SkillTrainer',recordName='Character.wat_lch_melee_01',bodyType=M})=='npc-melee-vendor-male')
    assert(key({vendor=true,vendorType='SkillTrainer',recordName='Character.wbr_jpn_netrun_01',bodyType=M})=='npc-netrunner-vendor-male')
    assert(key({vendor=true,vendorType='SkillTrainer',recordName='Character.std_arr_techstore_01',bodyType=F})=='npc-netrunner-vendor-female')
    assert(key({vendor=true,vendorType='SkillTrainer',recordName='Character.some_trainer_01',bodyType=M})==nil)
    assert(key({vendor=true,vendorType='Kiosk',bodyType=M})=='npc-market-stall-male')
    assert(key({vendor=true,vendorType='Market',bodyType=F})=='npc-market-stall-female')
    assert(key({vendor=true,vendorType='DropPoint',bodyType=M})==nil and key({vendor=true,vendorType='VendingMachine',bodyType=M})==nil)
    assert(key({vendor=true,vendorType='PackedFood',bodyType=M})=='npc-food-vendor-male', 'stalls that sell food stay food vendors')
    assert(key({vendor=true,vendorType='Medical',affiliation='Maelstrom',bodyType=M})=='npc-medic-vendor-male', 'a vendor beats a gang record')
    -- Factions: Militech and Kang Tao are no longer corporate security; Arasaka and security_ records still are.
    assert(key({affiliation='Militech',bodyType=M})=='npc-militech-male')
    assert(key({affiliation='KangTao',bodyType=F})=='npc-kang-tao-female')
    assert(key({affiliation='Arasaka',bodyType=M})=='npc-corpo-security-male')
    assert(key({affiliation='Militech',recordName='Character.security_guard1_ranged1_saratoga_ma',bodyType=M})=='npc-corpo-security-male')
    assert(key({affiliation='NetWatch',bodyType=M})=='npc-netwatch-male')
    assert(key({affiliation='TraumaTeam',bodyType=F})=='npc-trauma-team-female')
    assert(key({affiliation='Unaffiliated',recordName='Character.kab_trauma_soldier_ranged2_dian_ma',bodyType=M})=='npc-trauma-team-male')
    assert(key({affiliation='Biotechnica',bodyType=F})=='npc-biotechnica-female')
    assert(key({affiliation='AfterlifeMercs',bodyType=M})=='npc-merc-male')
    assert(key({affiliation='UnaffiliatedCorpo',recordName='Character.generic_merc_ranged2_ajax_wa',bodyType=F})=='npc-merc-female')
    assert(key({affiliation='UnaffiliatedCorpo',recordName='Character.street_goon_medium_range_m_easy',bodyType=M})=='npc-street-goon-male')
    assert(key({affiliation='UnaffiliatedCorpo',recordName='Character.generic_grunt_ranged1_pulsar_wa',bodyType=F})=='npc-street-goon-female')
    assert(key({affiliation='Unaffiliated',bodyType=M})==nil, 'Unaffiliated alone is not a goon')
    assert(key({affiliation='Militech',quest='SideQuest',bodyType=M})==nil, 'story actors stay unprofiled')
    assert(key({affiliation='Militech',human=false,recordName='Character.militech_drone_wyvern_hard'})==nil)
    -- A gang affiliation still routes to its gang; police still beat factions.
    assert(key({affiliation='Maelstrom',bodyType=M})=='npc-maelstrom-male')
    assert(key({police=true,affiliation='NCPD',bodyType=M})=='npc-ncpd-male')
    -- Residents: nightlife, workers, Dogtown; the other Dogtown kinds keep their own.
    assert(key({crowd=true,recordName='Character.NightlifeWoman',bodyType=F})=='npc-nightlife-resident-female')
    assert(key({crowd=true,recordName='Character.NonBinaryMaleBodyNightlife',bodyType=M})=='npc-nightlife-resident-male')
    assert(key({crowd=true,recordName='Character.WorkerSpecialistMale',bodyType=M})=='npc-worker-resident-male')
    assert(key({crowd=true,recordName='Character.Waitress',bodyType=F})=='npc-worker-resident-female')
    assert(key({crowd=true,recordName='Character.ep1_combat_zone_citizen_stacks_wa',bodyType=F})=='npc-dogtown-resident-female')
    assert(key({crowd=true,recordName='Character.ep1_combat_zone_citizen_pacific_mb',bodyType=M})=='npc-dogtown-resident-male')
    assert(key({crowd=true,recordName='Character.ep1_combat_zone_citizen_business_ma',bodyType=M})=='npc-corpo-resident-male')
    assert(key({crowd=true,recordName='Character.ep1_combat_zone_citizen_outcast_wa',bodyType=F})=='npc-homeless-female')
    assert(key({crowd=true,recordName='Character.Mallrat',bodyType=F})==nil, 'unlisted crowd kinds keep the resident fallback')
    -- Every base the data declares has both variants.
    for name,base in pairs(index.bases) do
      assert(index.byBase[name] and index.byBase[name].MALE and index.byBase[name].FEMALE, name)
    end
  `);
});
test('only one-shop vendors get a memory key; crowd, goons and shared stall records stay session-only',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local ripper={vendor=true,vendorType='RipperDoc',recordName='Character.wat_kab_ripperdoc_01',bodyType='ManAverage'}
    local key=api.classify(index,ripper)
    assert(key=='npc-ripperdoc-male')
    assert(api.describe(index,key,ripper).memoryKey=='wat_kab_ripperdoc_01')
    assert(api.memoryKey(index,ripper)=='wat_kab_ripperdoc_01')
    local bar={vendor=true,vendorType='Food',recordName='Character.lizzies_barman',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,bar),bar).memoryKey=='lizzies_barman')
    local medic={vendor=true,vendorType='Medical',recordName='Character.cct_dtn_medic_01',bodyType='WomanAverage'}
    assert(api.describe(index,api.classify(index,medic),medic).memoryKey=='cct_dtn_medic_01')
    -- The shared street-stall records stand at many stalls, so they are not one shopkeeper.
    local stall={vendor=true,vendorType='Kiosk',recordName='Character.Kiosk',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,stall),stall).memoryKey==nil)
    local grill={vendor=true,vendorType='GrilledFood',recordName='Character.Grilled_Food',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,grill),grill).memoryKey==nil)
    -- No record name, a main-quest vendor, a gang member and a pedestrian have none.
    local anon={vendor=true,vendorType='RipperDoc',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,anon),anon).memoryKey==nil)
    assert(api.memoryKey(index,{vendor=true,quest='MainQuest',recordName='Character.wat_kab_ripperdoc_01'})==nil)
    local gang={affiliation='Maelstrom',recordName='Character.wat_kab_ripperdoc_01',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,gang),gang).memoryKey==nil)
    local walker={crowd=true,recordName='Character.CorpoMan',bodyType='ManAverage'}
    assert(api.describe(index,api.classify(index,walker),walker).memoryKey==nil)
  `);
});
test('Model browser records of the new kinds classify from TweakDB facts (vendor genders from the shipped sources)',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local function key(facts) return (api.classifyRecord(index,facts)) end
    assert(key({recordName='Character.wat_kab_medicstore_01',vendor=true,vendorType='Medical'})=='npc-medic-vendor-male')
    assert(key({recordName='Character.cct_dtn_medic_01',vendor=true,vendorType='Medical'})=='npc-medic-vendor-female')
    assert(key({recordName='Character.wat_kab_junkshop_01',vendor=true,vendorType='Junk'})=='npc-junk-dealer-male')
    assert(key({recordName='Character.wat_lch_melee_01',vendor=true,vendorType='SkillTrainer'})=='npc-melee-vendor-male')
    assert(key({recordName='Character.wat_kab_netrunner_01',vendor=true,vendorType='SkillTrainer'})=='npc-netrunner-vendor-female')
    assert(key({recordName='Character.militech_ranger1_ranged1_saratoga_ma',affiliation='Militech'})=='npc-militech-male')
    assert(key({recordName='Character.afterlife_merc_generic_medium_range_w_easy',affiliation='AfterlifeMercs'})=='npc-merc-female')
    assert(key({recordName='Character.street_goon_medium_range_w_hard',affiliation='UnaffiliatedCorpo'})=='npc-street-goon-female')
    assert(key({recordName='Character.NightlifeWoman',crowd=true})=='npc-nightlife-resident-female')
    assert(key({recordName='Character.ep1_combat_zone_citizen_stacks_ma',crowd=true})=='npc-dogtown-resident-male')
    assert(key({recordName='Character.q113_militech_guard_ma',affiliation='Militech'})==nil, 'quest records stay silent')
  `);
});
test('the one-shop vendor list is generated from the shipped sources and holds no shared stall record',()=>{
  const table=JSON.parse(readFileSync(new URL('../characters/archetype-record-genders.json',import.meta.url),'utf8'));
  assert(table.uniqueVendors.length>100);
  for(const shared of ['Character.Kiosk','Character.Market','Character.Drinks','Character.Grilled_Food','Character.Packed_Food','Character.Clothes','Character.Tech_Junk','Character.Chinese_Food'])
    assert(!table.uniqueVendors.includes(shared),shared);
  for(const shop of ['Character.wat_kab_ripperdoc_01','Character.lizzies_barman','Character.cz_stadium_gunsmith_01','Character.wbr_jpn_netrun_01'])
    assert(table.uniqueVendors.includes(shop),shop);
  assert.deepEqual([...table.uniqueVendors],[...table.uniqueVendors].sort());
});

// The mod never touches game-placed characters except the talk path for ordinary NPCs (docs/WORLD_COMPANIONS.md).
test('a named character the game placed gets no profile; our spawned copy and ordinary NPCs still talk',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({
      {key='judy-alvarez',name='Judy Alvarez',aliases={'Judy'},records={'Character.judy'}},
      {key='viktor-vektor',name='Viktor Vektor',records={'Character.viktor'}},
      {key='resident-female',name='Night City Resident Female'}
    },index)
    local function who(actor) return (api.resolve(catalog,actor)) end
    -- The vanilla Judy (by record, then by name) is the game's own: no Convai.
    assert(who({world=true,name='Whoever',record='Character.judy',bodyType='WomanAverage'})==nil, 'record')
    assert(who({world=true,name=' judy alvarez ',bodyType='WomanAverage'})==nil, 'name')
    assert(who({world=true,name='Judy',record='Character.judy',crowd=true,bodyType='WomanAverage'})==nil, 'never a resident')
    assert(who({world=true,name='Viktor Vektor',record='Character.viktor',facts={vendor=true,vendorType='RipperDoc',bodyType='ManAverage'}})==nil,
        'a named ripperdoc is not the generic ripperdoc')
    -- Our spawned copy of Judy talks as Judy.
    assert(who({managedKey='judy-alvarez',world=false,name='Judy Alvarez',record='Character.judy'})=='judy-alvarez')
    -- The same lookup without the world flag (game dialogue attribution only) is unchanged.
    assert(who({name='Judy Alvarez',record='Character.judy'})=='judy-alvarez')
    -- Ordinary world NPCs still reach their archetype.
    assert(who({world=true,name='Ganger',record='Character.x',facts={affiliation='Maelstrom',bodyType='ManAverage'}})=='npc-maelstrom-male')
    assert(who({world=true,name='Dealer',record='Character.y',facts={vendor=true,vendorType='RipperDoc',bodyType='WomanAverage'}})=='npc-ripperdoc-female')
    assert(who({world=true,name='Citizen',record='Character.z',crowd=true,bodyType='WomanAverage'})=='resident-female')
    -- A quest-bound or story-record character with no roster profile still talks: the archetype their facts give, else a resident.
    eq(who({world=true,name='Quest NPC',record='Character.q',crowd=true,bodyType='WomanAverage',
        facts={quest='SideQuest',crowd=true,affiliation='Maelstrom',bodyType='WomanAverage'}}),'npc-maelstrom-female')
    eq(who({world=true,name='Quest Goon',record='Character.q101_goon',crowd=true,
        facts={recordName='Character.q101_goon',affiliation='Maelstrom',bodyType='ManAverage'}}),'npc-maelstrom-male')
    eq(who({world=true,name='Maxtac',record='Character.maxtac_x',crowd=true,
        facts={recordName='Character.maxtac_avg',affiliation='NCPD',police=true,bodyType='ManAverage'}}),'npc-maxtac-male')
    -- A child or a machine (not a crowd child) and a person of unknown gender still have no profile.
    assert(who({world=true,name='Kid',record='Character.k',facts={children=true,bodyType='ManAverage'}})==nil)
    assert(who({world=true,name='Drone',record='Character.d',facts={human=false,bodyType='ManAverage'}})==nil)
    assert(who({world=true,name='Shape',record='Character.s',facts={human=true,bodyType='Mech'}})==nil)
  `);
});

test('protectedReason: named, quest-flagged and story-record characters are off limits; ordinary NPCs are not',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({{key='panam-palmer',name='Panam Palmer',aliases={'Panam'},records={'Character.panam'}}},index)
    local function why(actor) return api.protectedReason(catalog,actor) end
    assert(why({record='Character.panam',name='x'})=='named')
    assert(why({record='',name='Panam'})=='named')
    assert(why({record='Character.g',name='Ganger',facts={quest='MainQuest'}})=='quest')
    assert(why({record='Character.g',name='Ganger',facts={quest='MinorQuest'}})=='quest')
    assert(why({record='Character.g',name='Ganger',facts={recordName='Character.sq023_goon'}})=='story-record')
    assert(why({record='Character.g',name='Ganger',facts={recordName='Character.mq041_x'}})=='story-record')
    -- a quest crowd extra may talk, but stays protected from every other system (reactions, tactics, names)
    assert(why({record='Character.g',name='Patron',facts={crowd=true,quest='MainQuest',recordName='Character.q005_afterlife_crowd_male'}})=='quest')
    assert(why({record='Character.g',name='Ganger',facts={quest='None',recordName='Character.gang_maelstrom_01'}})==nil)
    assert(why({record='Character.g',name='Pedestrian',facts={}})==nil)
    assert(why({record='Character.g',name='Pedestrian'})==nil)
    assert(why(nil)==nil and api.protectedReason(nil,{})==nil)
    -- a vendor with a minor quest flag can still be talked to, but no other system may touch it
    assert(why({record='Character.v',name='Shop',facts={quest='MinorQuest',vendor=true}})=='quest')
    assert(api.resolve(catalog,{world=true,name='Shop',record='Character.v',
        facts={quest='MinorQuest',vendor=true,vendorType='Food',recordName='Character.v',bodyType='ManAverage'}})~=nil)
  `);
});

// 2026-10-22 report: Panam in her apartment scene was talked to as npc-aldecaldos-female. Her record's hash string did not match the roster's, and the
// roster was never looked up by the readable record name the facts carry; a named character the game placed must never fall to an archetype.
test('a world character found by facts.recordName never falls to an archetype: nil with story talk off, her profile with it on',()=>{
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({
      {key='panam-palmer',name='Panam Palmer',aliases={'Panam'},records={'Character.Panam'}},
      {key='resident-female',name='Night City Resident Female'}
    },index)
    local facts={recordName='Character.Panam',affiliation='Aldecaldos',gender='Female',bodyType='WomanAverage'}
    local function who(actor) return (api.resolve(catalog,actor)) end
    -- The hash string and the display name both miss (a scene name, another hash form): the readable record name still finds her.
    local scene={world=true,name='Someone Else',record='<TDBID:DEADBEEF:07>',bodyType='WomanAverage',facts=facts}
    assert(who(scene)==nil, 'story talk off: the game own character, no profile, no archetype')
    scene.story=true
    assert(who(scene)=='panam-palmer', 'story talk on: her profile')
    -- Without the record name in the facts the same actor is an ordinary Aldecaldos woman, so the lookup is what makes the difference.
    local plain={world=true,name='Someone Else',record='<TDBID:DEADBEEF:07>',bodyType='WomanAverage',
        facts={recordName='Character.aldecaldos_grunt',affiliation='Aldecaldos',gender='Female',bodyType='WomanAverage'}}
    assert(who(plain)=='npc-aldecaldos-female', 'an unnamed Aldecaldos woman is still an archetype')
    -- The facts the actor carries when "Talk to ordinary NPCs" is off are absent: nothing changes there.
    assert(who({world=true,name='Panam',record='<TDBID:DEADBEEF:07>',bodyType='WomanAverage'})==nil, 'the display name alone still finds her')
    -- Every other system leaves her alone too, found by the same record name.
    assert(api.protectedReason(catalog,{record='<TDBID:DEADBEEF:07>',name='Someone Else',facts=facts})=='named')
    assert(api.protectedReason(catalog,{record='<TDBID:DEADBEEF:07>',name='Someone Else',facts=plain.facts})==nil)
    -- A character our own copy spawned (managed key) is untouched by all of this.
    assert(who({managedKey='panam-palmer',world=false,name='Panam Palmer'})=='panam-palmer')
  `);
});

// 2026-10-22 live test: "Conversation unavailable: profile=nil" for people V can target. Every person the game placed and the roster does not
// name gets an archetype conversation; the notice reason is told in words for the few who cannot talk.
test('the receptionist and WorkerMaleDE cases: quest-bound and unclassified world people always get an archetype', () => {
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({{key='judy-alvarez',name='Judy Alvarez',records={'Character.judy'}},
      {key='resident-male',name='Night City Resident Male'},{key='resident-female',name='Night City Resident Female'}},index)
    local function who(actor) return (api.resolve(catalog,actor)) end
    -- log: classify=story-bound protected=quest crowd=true quest=MainQuest record=Character.dlc6_dtn_receptionist
    local receptionist={world=true,name='Receptionist',record='ToTweakDBID{ hash = 0x1, length = 30 }',crowd=true,bodyType='WomanAverage',
      facts={crowd=true,quest='MainQuest',recordName='Character.dlc6_dtn_receptionist',bodyType='WomanAverage',gender='Female',human=true}}
    eq(who(receptionist),'npc-corpo-resident-female','a receptionist is a corporate worker')
    -- an earlier report: classify=unclassified record=Character.WorkerMaleDE (not a crowd body, no affiliation)
    local worker={world=true,name='Worker',record='ToTweakDBID{ hash = 0x2, length = 22 }',crowd=false,bodyType='ManAverage',
      facts={crowd=false,recordName='Character.WorkerMaleDE',bodyType='ManAverage',human=true,children=false}}
    eq(who(worker),'npc-worker-resident-male')
    local plain={world=true,name='Someone',record='Character.zzz',crowd=false,bodyType='WomanBig',
      facts={crowd=false,recordName='Character.SomethingElse',bodyType='WomanBig',human=true}}
    eq(who(plain),'resident-female','no archetype fits: a resident of their gender')
    -- the gender comes from the explicit fact, the rig or the record name, in that order
    eq(who({world=true,name='X',facts={recordName='Character.foo_ma',gender='Female'}}),'resident-female')
    eq(who({world=true,name='X',bodyType='ManAverage',facts={recordName='Character.foo'}}),'resident-male')
    eq(who({world=true,name='X',facts={recordName='Character.NightlifeWomanX',human=true}}),'npc-nightlife-resident-female')
    -- the quest actor's own facts still pick the archetype when they name one
    eq(who({world=true,name='Guard',facts={affiliation='Arasaka',quest='MainQuest',bodyType='ManAverage'}}),'npc-corpo-security-male')
    -- a named roster character keeps its own rules: never a fallback
    assert(who({world=true,name='Judy Alvarez',record='Character.judy',crowd=true,bodyType='WomanAverage',
      facts={crowd=true,quest='MainQuest',recordName='Character.judy',bodyType='WomanAverage'}})==nil)
    -- the setting-off path (no facts) is unchanged
    eq(who({world=true,name='Worker',crowd=false,bodyType='ManAverage'}),nil)
    eq(who({world=true,name='Worker',crowd=true,bodyType='ManAverage'}),'resident-male')
  `);
});

test('noProfileReason names the few people nobody can talk to, and a roster character with the story setting off', () => {
  runLua(`
    local index=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({{key='rogue-amendiares',name='Rogue Amendiares',aliases={'Rogue'},records={'Character.Rogue'}}},index)
    local function why(actor) return api.noProfileReason(catalog,actor) end
    -- log: classify=merc protected=named crowd=false quest=nil record=Character.Rogue
    eq(why({world=true,name='Rogue Amendiares',record='ToTweakDBID{ hash = 0x3, length = 14 }',
      facts={recordName='Character.Rogue',affiliation='AfterlifeMercs',bodyType='WomanAverage'}}),'named')
    eq(why({world=true,name='Someone',record='Character.x',facts={recordName='Character.Rogue'}}),'named')
    eq(why({world=true,name='Kid',facts={children=true,bodyType='ManAverage'}}),'child')
    eq(why({world=true,name='Bot',facts={human=false,bodyType='ManAverage'}}),'not-human')
    eq(why({world=true,name='Shape',facts={human=true,bodyType='Mech'}}),'no-gender')
    eq(why({world=true,name='Plain',facts={human=true,bodyType='ManAverage'}}),'unknown')
    eq(why(nil),'unknown')
    -- with the story setting on the roster character resolves and never reaches the notice
    eq((api.resolve(catalog,{world=true,story=true,name='Rogue Amendiares',record='Character.Rogue',bodyType='WomanAverage'})),'rogue-amendiares')
    eq((api.resolve(catalog,{world=true,name='Rogue Amendiares',record='Character.Rogue',bodyType='WomanAverage'})),nil)
  `);
});

// The 2026-10-30 cast sweep (docs/CAST_SWEEP.md): a minor profile names an ordinary person. It answers for a character a mod spawns from the record
// at once, for the game's own copy only while Talk to story characters is on, and it never makes that person a protected story character.
test('a minor profile resolves for a spawned copy, for the game copy only with Talk to story characters, and is not protected',()=>{
  runLua(`
    local archetypes=api.buildArchetypes(api.ARCHETYPES)
    local catalog=api.build({
      {key='mateo-lorenzo',name='Mateo Lorenzo',aliases={'Mateo Lorenzo'},records={'Character.q000_kid_bar_patron_male_03'},minor=true},
      {key='judy-alvarez',name='Judy Alvarez',records={'Character.Judy'}}
    },archetypes)
    local facts={recordName='Character.q000_kid_bar_patron_male_03',affiliation='Valentinos',bodyType='ManAverage',human=true}
    local mateo={record='Character.q000_kid_bar_patron_male_03',name='Mateo',facts=facts,bodyType='ManAverage'}
    eq((api.resolve(catalog,mateo)),'mateo-lorenzo','not world-placed: a record a mod spawns')
    mateo.spawned=true
    eq((api.resolve(catalog,mateo)),'mateo-lorenzo','spawned by another mod')
    mateo.spawned=nil; mateo.world=true
    local off=api.resolve(catalog,mateo)
    assert(off~='mateo-lorenzo','the game copy keeps its archetype while the setting is off')
    assert(off~=nil,'and still has a conversation')
    mateo.story=true
    eq((api.resolve(catalog,mateo)),'mateo-lorenzo','story talk on')
    assert(api.protectedReason(catalog,{record=mateo.record,name='Mateo',facts=facts})~='named','a minor profile is not a named story character')
    eq(api.protectedReason(catalog,{record='Character.Judy',name='Judy',facts={recordName='Character.Judy'}}),'named','a story profile still does')
    local judy={record='Character.Judy',name='Judy',world=true,facts={recordName='Character.Judy'}}
    eq((api.resolve(catalog,judy)),nil,'a story character is still refused while the setting is off')
  `);
});
