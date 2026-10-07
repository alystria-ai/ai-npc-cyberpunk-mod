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
    assert(key({crowd=true,recordName='Character.Waitress',bodyType='WomanAverage'})==nil)
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
      facts={crowd=true,recordName='Character.Waitress',bodyType='WomanAverage'}})=='resident-female')
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
  const genders=JSON.parse(readFileSync(new URL('../characters/archetype-record-genders.json',import.meta.url),'utf8')).records;
  assert.equal(source.slice(source.indexOf(LUA_BEGIN),source.indexOf(LUA_END)+LUA_END.length),luaArchetypeBlock(catalog,genders));
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
