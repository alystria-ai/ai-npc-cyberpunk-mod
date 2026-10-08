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
  const result=lauxlib.luaL_dostring(state,to_luastring(`local api=(function() ${source} end)()\n${code}`));
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
    -- Police by affiliation or flag; MaxTac stays unprofiled.
    assert(key({affiliation='NCPD',bodyType='ManAverage'})=='npc-ncpd-male')
    assert(key({police=true,affiliation='Unknown',bodyType='WomanAverage'})=='npc-ncpd-female')
    assert(key({affiliation='NCPD',recordName='Character.maxtac_rifle_ma',bodyType='ManAverage'})==nil)
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
    assert(api.resolve(catalog,{name='Ganger',bodyType='ManAverage',crowd=false,
      facts={affiliation='Valentinos',quest='MainQuest',bodyType='ManAverage'}})==nil)
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
    assert(key({recordName='Character.maxtac_rifle_ma',affiliation='NCPD'})==nil)
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
