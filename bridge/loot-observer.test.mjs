import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/loot-observer.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local now,registrations,nameReads,listReads=1000,0,0,0
os.time=function()return now end
local before,after={},{}
ObserveBefore=function(class,method,callback)registrations=registrations+1;before[class..'.'..method]=callback end
ObserveAfter=function(class,method,callback)registrations=registrations+1;after[class..'.'..method]=callback end
local function object(id,kind)
 return {id=id,kind=kind,quantities={},GetEntityID=function(self)return {hash=self.id}end,
  IsAttached=function()return true end,IsDeadNoStatPool=function()return false end,
  IsPlayer=function(self)return self.kind=='player'end,IsPlayerStash=function(self)return self.kind=='stash'end,
  IsVehicle=function(self)return self.kind=='vehicle'end}
end
local player,world=object('1ULL','player'),object('11090064ULL','world')
local baselineItems,baselineOk={},true
local transaction={
 GetItemList=function(_,target)assert(target==player);listReads=listReads+1;return baselineOk,baselineItems end,
 GetItemQuantity=function(_,target,id)return target.quantities[id.hash] or 0 end}
Game={GetPlayer=function()return player end,GetTransactionSystem=function()return transaction end}
NameToString=function(value)return value end
CName={new=function(value)return value end};Enum={new=function(_,value)return value end}
ItemID={IsValid=function(id)return id~=nil and not id.invalid end,GetCombinedHash=function(id)return id.hash end,
 GetTDBID=function(id)return id.record end,HasFlag=function(id)return id.preview==true end}
TDBID={ToStringDEBUG=function(value)return value end}
TweakDBInterface={GetItemRecord=function(value)return value end}
RPGManager={GetItemDataQuality=function(data)assert(data);return data.id.quality end,
 GetItemCategory=function(id)return id.category end,IsItemBroken=function(data)assert(data);return data.broken==true end}
UIItemsHelper={GetItemName=function(_,data)assert(data);nameReads=nameReads+1;return data.name end}
LootChoiceActionWrapper={Unwrap=function(event)return event.wrapper end,IsValid=function(wrapper)return wrapper.valid~=false end}
local function item(hash,name,quality,category)
 return {hash=hash,record='Items.LowQualityDrink10',name=name or 'NiCola',
  quality=quality or 'gamedataQuality : Common (0)',category=category or 'gamedataItemCategory : Consumable (1)'}
end
local function data(id,total)
 return {id=id,name=id.name,total=total,tags={},GetID=function(self)return self.id end,
  GetQuantity=function(self)return self.total end,HasTag=function(self,tag)return self.tags[tag]==true end}
end
local ctx={available=true,blocked=false,worldReady=true,enabled=true,now=now,
 people={{entity='21ULL',profileKey='judy-alvarez',distance=2,available=true,npc=object('21ULL','npc')},
 {entity='22ULL',profileKey='judy-alvarez',distance=4,available=true,npc=object('22ULL','npc')}}}
local m=(function()${source}end)()
m.configure({captureContext=function(p)assert(p==player);ctx.now=now;return ctx end})
m.install()
local function update()ctx.now=now;m.update(ctx)end
local function intent(id,amount,source,activator,action)
 source=source or world;source.quantities[id.hash]=amount or 1
 before['Inventory.OnInteractionUsed']({GetEntity=function()return source end},
  {activator=activator or player,wrapper={valid=true,itemId=id,action=action or 'Loot'}})
end
local function added(id,old,total,silent,details)
 local value=details or data(id,total)
 player.quantities[id.hash]=total
 after['PlayerPuppet.OnItemAddedToInventory'](player,
  {itemID=id,itemData=value,currentQuantity=old,flaggedAsSilent=silent==true})
 return value
end
local function changed(id,total,difference)
 player.quantities[id.hash]=total
 after['PlayerPuppet.OnItemChangedEvent'](player,{itemID=id,itemData=data(id,total),currentQuantity=total,difference=difference})
end
local drink=item('3883189708567085088ULL')
`;

test('recorded drink then stacked pickup emit one delta each, never Added plus Changed duplicates', () => run(fixture + `
update();assert(m.status().baseline.complete and listReads==1 and nameReads==0)
intent(drink,1)
added(drink,0,1,false);changed(drink,1,1)
local first=m.drain();assert(#first==1 and first[1].quantity==1 and first[1].newlyAcquired)
assert(first[1].identity=='3883189708567085088ULL' and first[1].record=='Items.LowQualityDrink10')
assert(first[1].name=='NiCola' and first[1].quality=='Common' and first[1].category=='Consumable')
assert(first[1].source=='world' and first[1].confirmed and #m.drain()==0)
now=now+1;world.id='11090129ULL';update();intent(drink,2)
added(drink,1,3,false);changed(drink,3,2);added(drink,1,3,false);changed(drink,3,2)
local second=m.drain();assert(#second==1 and second[1].quantity==2 and not second[1].newlyAcquired)
assert(second[1].acquisitionId~=first[1].acquisitionId and listReads==1)
`));

test('only item-specific Loot from a local world source establishes provenance', () => run(fixture + `
update()
local sources={player,object('2ULL','stash'),object('3ULL','vehicle')}
for _,source in ipairs(sources)do intent(drink,1,source);added(drink,0,1,false);assert(#m.drain()==0)end
intent(drink,1,world,object('9ULL','player'));added(drink,1,2,false);assert(#m.drain()==0)
intent(drink,1,world,player,'Learn');added(drink,2,3,false);assert(#m.drain()==0)
local other=item('44ULL','Other')
intent(drink,1);added(other,0,1,false);assert(#m.drain()==0)
now=1004;update();added(drink,3,4,false);assert(#m.drain()==0 and m.status().intents==0)
assert(before['Inventory.OnLootAllEvent']==nil and before['ScriptedPuppet.OnInteraction']==nil)
assert(m.status().routes.corpseLootAll=='unverified-disabled')
`));

test('silent, unknown and changed-only grants cannot borrow a valid world interaction', () => run(fixture + `
update();added(drink,0,1,false);changed(drink,1,1);assert(#m.drain()==0)
intent(drink,2);added(drink,1,3,true);changed(drink,3,2);assert(#m.drain()==0 and m.status().intents==0)
now=1004;update();intent(drink,1);changed(drink,4,1);assert(#m.drain()==0 and m.status().intents==0)
now=1005;update();intent(drink,1)
after['PlayerPuppet.OnItemAddedToInventory'](player,{itemID=drink,itemData=data(drink,5),currentQuantity=4})
changed(drink,5,1);assert(#m.drain()==0,'An unknown silent flag must fail closed')
`));

test('storage transfers and vendor/buyback requests veto exact item IDs', () => run(fixture + `
update();intent(drink,1)
before['VendorDataManager.TransferItem']({},object('3ULL','vehicle'),player,data(drink,1),1)
added(drink,0,1,false);changed(drink,1,1);assert(#m.drain()==0)
now=1004;update();intent(drink,1)
before['VendorDataManager.BuyItemFromVendor']({},data(drink,1),1)
added(drink,1,2,false);assert(#m.drain()==0)
now=1008;update();intent(drink,1)
before['VendorDataManager.BuybackItemFromVendor']({},data(drink,1),1)
added(drink,2,3,false);assert(#m.drain()==0)
now=1012;update();intent(drink,1)
before['VendorDataManager.TransferItem']({},world,object('9ULL','npc'),data(drink,1),1)
added(drink,3,4,false);assert(#m.drain()==1,'An unrelated NPC transfer must not veto the player')
`));

test('recorded vehicle storage deposit and withdrawal stay silent despite nonsilent Added', () => run(fixture + `
player.quantities[drink.hash]=3;baselineItems={data(drink,3)};update()
local vehicle=object('9017983ULL','vehicle')
before['VendorDataManager.TransferItem']({},player,vehicle,data(drink,3),1)
changed(drink,2,-1)
before['VendorDataManager.TransferItem']({},vehicle,player,data(drink,1),1)
added(drink,2,3,false);changed(drink,3,1)
assert(#m.drain()==0 and m.status().intents==0)
assert(m.status().baseline.seen==1 and m.status().counts.accepted==nil)
-- A later real re-pick of this exact previously owned item is still ordinary.
now=1004;update();changed(drink,0,-3);intent(drink,1);added(drink,0,1,false)
local rows=m.drain();assert(#rows==1 and not rows[1].newlyAcquired)
`));

test('quantity confirmation uses old Added total and rejects mismatched, nonpositive and oversized increases', () => run(fixture + `
update()
intent(drink,1);added(drink,1,1,false);assert(#m.drain()==0)
intent(drink,1);added(drink,1,1,false);assert(#m.drain()==0)
intent(drink,1);added(drink,1,3,false);assert(#m.drain()==0)
intent(drink,1);added(drink,3,2,false);assert(#m.drain()==0)
intent(drink,1);added(drink,2,3,false);local rows=m.drain();assert(#rows==1 and rows[1].quantity==1)
`));

test('baseline, removal and re-pick retain prior ownership and reset once per new save', () => run(fixture + `
local weapon=item('55ULL','Weapon','gamedataQuality : LegendaryPlusPlus (7)','gamedataItemCategory : Weapon (6)')
weapon.record='Items.Preset_Test_Default';baselineItems={data(weapon,1)};player.quantities[weapon.hash]=1
update();update();assert(listReads==1 and nameReads==0)
before['PlayerPuppet.OnItemBeingRemovedFromInventory'](player,{itemID=weapon,currentQuantity=1,difference=1})
changed(weapon,0,-1)
intent(weapon,1);added(weapon,0,1,false)
local row=m.drain()[1];assert(row and not row.newlyAcquired and row.quality=='LegendaryPlusPlus')
changed(weapon,0,-1);baselineItems={};m.reset();update();assert(listReads==2)
intent(weapon,1);added(weapon,0,1,false);assert(m.drain()[1].newlyAcquired)
before['PlayerPuppet.OnDetach'](player);assert(not m.status().baseline.attempted and m.status().queued==0)
`));

test('blocked, disabled and unavailable periods discard intents and rebaseline without delayed receipts', () => run(fixture + `
update();intent(drink,1);ctx.blocked=true
added(drink,0,1,false);assert(#m.drain()==0 and m.status().baseline.needed)
ctx.blocked=false;baselineItems={data(drink,1)};update();assert(listReads==2)
intent(drink,1);added(drink,1,2,false);ctx.enabled=false;update();assert(#m.drain()==0)
ctx.enabled=true;baselineItems={data(drink,2)};update();assert(listReads==3)
intent(drink,1);ctx.available=false;update();added(drink,2,3,false);assert(#m.drain()==0)
ctx.available=true;intent(drink,1);added(drink,3,4,false)
assert(not m.drain()[1].newlyAcquired,'Gameplay resuming before the new baseline cannot assert a discovery')
baselineItems={data(drink,3)};update();assert(m.status().baseline.complete and listReads==4)
-- A clean full read closes the unavailable interval: later new equipment is new again.
local rare=item('91ULL','Unknown','Legendary','Weapon');intent(rare,1);added(rare,0,1,false)
assert(m.drain()[1].newlyAcquired)
`));

test('source callbacks refresh resumed gameplay before stale polling gates and still reject fresh suppression', () => run(fixture + `
update()
local cases={{'blocked',true,false},{'worldReady',false,true},{'enabled',false,true},{'available',false,true}}
for index,case in ipairs(cases)do
 local id=item(tostring(index+600)..'ULL')
 ctx[case[1]]=case[2];update()
 assert(not m.status().enabled)
 ctx[case[1]]=case[3]
 -- No update between returning to gameplay and the actual inventory callback.
 intent(id,1);added(id,0,1,false);changed(id,1,1)
 local rows=m.drain()
 assert(#rows==1 and rows[1].quantity==1,'A stale '..case[1]..' gate lost a fresh pickup')
 assert(not rows[1].newlyAcquired,'A pending rebaseline must not invent first ownership')
 update()
 -- The inverse transition must read the fresh suppression before admission.
 ctx[case[1]]=case[2]
 local suppressed=item(tostring(index+700)..'ULL')
 intent(suppressed,1);added(suppressed,0,1,false)
 assert(#m.drain()==0 and m.status().intents==0,'Fresh '..case[1]..' suppression was ignored')
 ctx[case[1]]=case[3];update()
end
local reads=0
m.configure({captureContext=function()reads=reads+1;return ctx end})
player.IsAttached=function()return false end
intent(drink,1);assert(reads==0 and #m.drain()==0,'Detached native player must not be sampled')
player.IsAttached=function()return true end
player.IsDeadNoStatPool=function()return true end
intent(drink,1);assert(reads==0 and #m.drain()==0,'Dead native player must not be sampled')
`));

test('receipts retain exact witnessed copies and contain no native references', () => run(fixture + `
ctx.people[1].available=false;ctx.people[1].voiceBusy=true;ctx.people[1].availableReason='native-dialogue'
ctx.people[3]={entity='23ULL',profileKey='judy-alvarez',distance=3,available=false,voiceBusy=false,availableReason='dead'}
ctx.people[4]={entity='24ULL',profileKey='judy-alvarez',distance=25,available=true}
update();intent(drink,1)
ctx.people[1].entity='99ULL';ctx.people[2].profileKey='alex'
local value=added(drink,0,1,false);value.name='MUTATED';drink.name='MUTATED'
local rows=m.drain();assert(#rows==1 and rows[1].name=='NiCola')
assert(#rows[1].witnesses==2 and rows[1].witnesses[1].entity=='21ULL')
assert(not rows[1].witnesses[1].available and rows[1].witnesses[1].voiceBusy)
assert(rows[1].witnesses[2].entity=='22ULL' and rows[1].witnesses[2].profileKey=='judy-alvarez')
local function plain(value)
 if type(value)=='table' then for key,v in pairs(value)do assert(type(key)=='string' or type(key)=='number');plain(v)end
 else assert(type(value)=='string' or type(value)=='number' or type(value)=='boolean')end
end
plain(rows);plain(m.status())
local state=m.status();state.hooks['Inventory.OnInteractionUsed'].calls=999
assert(m.status().hooks['Inventory.OnInteractionUsed'].calls~=999)
`));

test('activity-log exclusions, invalid labels and unknown quality names stay silent', () => run(fixture + `
update()
local rejected={'Currency','Recipe','IconicRecipe','SkipActivityLog','SkipActivityLogOnLoot'}
for index,tag in ipairs(rejected)do
 local id=item(tostring(index+100)..'ULL');local value=data(id,1);value.tags[tag]=true
 intent(id,1);added(id,0,1,false,value);assert(#m.drain()==0)
end
for index,kind in ipairs({'preview','broken','empty','locale','quality','category'})do
 local id=item(tostring(index+200)..'ULL');local value=data(id,1)
 if kind=='preview'then id.preview=true elseif kind=='broken'then value.broken=true
 elseif kind=='empty'then value.name='  ' elseif kind=='locale'then value.name='LocKey#12345'
 elseif kind=='quality'then id.quality='gamedataQuality : Invalid (14)' else id.category='gamedataItemCategory : Invalid (9)'end
 intent(id,1);added(id,0,1,false,value);assert(#m.drain()==0)
end
`));

test('nil data and thrown native getters fail closed without retaining or dereferencing nil', () => run(fixture + `
update();intent(drink,1)
after['PlayerPuppet.OnItemAddedToInventory'](player,{itemID=drink,currentQuantity=0,flaggedAsSilent=false})
assert(#m.drain()==0 and not m.status().baseline.complete)
now=1004;update();intent(drink,1)
RPGManager.GetItemDataQuality=function()error('native unavailable')end
added(drink,0,1,false);assert(#m.drain()==0 and m.status().baseline.needed)
assert(m.status().hooks['PlayerPuppet.OnItemAddedToInventory'].errors==1)
local count=registrations;m.install();assert(registrations==count)
`));

test('a real Legendary weapon pickup is a new, Legendary, typed world receipt', () => run(fixture + `
update()
local id=item('777ULL','Pride','gamedataQuality : Legendary (4)','gamedataItemCategory : Weapon (6)')
id.record='Items.Preset_Pride_Default'
local value=data(id,1);value.GetItemType=function()return 'gamedataItemType : Wea_AssaultRifle (86)' end
intent(id,1);added(id,0,1,false,value);changed(id,1,1)
local rows=m.drain();assert(#rows==1)
local row=rows[1]
assert(row.quality=='Legendary' and row.category=='Weapon' and row.itemType=='Wea_AssaultRifle')
assert(row.name=='Pride' and row.newlyAcquired and row.source=='world' and row.confirmed and row.quantity==1)
-- Quality is the native name, never an ordering guess: plus tiers are reported as named.
for index,tier in ipairs({'Legendary','LegendaryPlus','LegendaryPlusPlus'})do
 local plus=item(tostring(800+index)..'ULL','Plus','gamedataQuality : '..tier..' ('..index..')','gamedataItemCategory : Clothing (0)')
 intent(plus,1);added(plus,0,1,false);local seen=m.drain()[1];assert(seen.quality==tier and seen.newlyAcquired)
end
-- The type is a descriptive extra: an unreadable or unusable one never blocks the receipt.
for index,getter in ipairs({function()error('native')end,function()return nil end,
  function()return 'gamedataItemType : Invalid (110)' end,function()return 'not a type!' end})do
 local other=item(tostring(900+index)..'ULL','Other','gamedataQuality : Legendary (4)','gamedataItemCategory : Weapon (6)')
 local details=data(other,1);details.GetItemType=getter
 intent(other,1);added(other,0,1,false,details)
 local result=m.drain()[1];assert(result and result.itemType==nil and result.quality=='Legendary',index)
end
`));

test('every accepted pickup carries its tooltip description when a native read resolves it', () => run(fixture + `
update()
local descriptions={}
local function record(key)return {LocalizedDescription=function()
 if key=='throws' then error('native') end;return key end}end
TweakDBInterface.GetItemRecord=function(value)return record(descriptions[value] or 'LocKey#1')end
local function pick(hash,tier,text,details)
 local id=item(hash,'Thing',tier or 'gamedataQuality : Common (0)')
 id.record='Items.Record'..hash;descriptions[id.record]=text
 intent(id,1);added(id,0,1,false,details);return m.drain()[1]
end
-- The inventory tooltip's own resolver first; tags and whitespace are removed.
LocKeyToString=function(key)return ' <i>A cheap</i>  drink'..string.char(10)..'for the road. '..key end
assert(pick('1001ULL','gamedataQuality : Common (0)','LocKey#7').description=='A cheap drink for the road. LocKey#7')
local legendary=pick('1002ULL','gamedataQuality : Legendary (4)','LocKey#8')
assert(legendary.quality=='Legendary' and legendary.description,'Legendary items are described the same way')
-- A resolver that fails, is empty or leaves the key unresolved falls through to the next.
LocKeyToString=function()error('not callable')end
GetLocalizedTextByKey=function(key)return 'LocKey#'..tostring(key)end
Game.GetLocalizedTextByKey=function()return '   'end
GetLocalizedItemNameByCName=function(key)return 'Resolved by the last reader'end
assert(pick('1003ULL',nil,'LocKey#9').description=='Resolved by the last reader')
-- Unreadable text never blocks the receipt and leaves the description absent.
GetLocalizedItemNameByCName=function()return 'LocKey#9' end
local bare=pick('1004ULL',nil,'LocKey#10');assert(bare and bare.name=='Thing' and bare.description==nil)
LocKeyToString=function()return 'Never reached' end
assert(pick('1005ULL',nil,'throws').description==nil,'A throwing description read is ignored')
TweakDBInterface.GetItemRecord=function()return {LocalizedDescription=function()return nil end}end
assert(pick('1006ULL',nil,'x').description==nil)
TweakDBInterface.GetItemRecord=function(value)return value end
local plain=pick('1007ULL',nil,'x');assert(plain and plain.description==nil and plain.name=='Thing','A record without the method is fine')
`));

test('a long description is cut at a sentence or word end without splitting a character', () => run(fixture + `
update()
local text
TweakDBInterface.GetItemRecord=function()return {LocalizedDescription=function()return 'k' end}end
LocKeyToString=function()return text end
local function pick(hash)
 local id=item(hash);intent(id,1);added(id,0,1,false);return m.drain()[1].description
end
text=string.rep('A sentence that runs on and on. ',20)
local cut=pick('2001ULL');assert(#cut<=280 and cut:sub(-1)=='.' and not cut:find('%.%.%.'),cut)
text=string.rep('word ',200)
cut=pick('2002ULL');assert(#cut<=283 and cut:sub(-7)=='word...',cut:sub(-12))
text='x'..string.rep('\u{1F409}',100)
cut=pick('2003ULL')
assert(cut and cut:sub(-3)=='...' and #cut<=283)
local body=cut:sub(1,-4)
assert(utf8.len(body)==70 and #body==277,'No split multi-byte character')
text='short'
assert(pick('2004ULL')=='short')
`));

test('one failed or unreadable event no longer disables new-equipment detection for the whole session', () => run(fixture + `
update();assert(m.status().baseline.complete)
-- A callback that throws leaves ownership uncertain until the inventory is read again.
local broken=item('601ULL')
RPGManager.GetItemDataQuality=function()error('native unavailable')end
intent(broken,1);added(broken,0,1,false)
assert(m.status().baseline.needed and not m.status().baseline.complete)
RPGManager.GetItemDataQuality=function(data)assert(data);return data.id.quality end
local during=item('602ULL','Weapon','gamedataQuality : Legendary (4)','gamedataItemCategory : Weapon (6)')
intent(during,1);added(during,0,1,false)
assert(not m.drain()[1].newlyAcquired,'Before the clean read ownership is still uncertain')
baselineItems={data(broken,1),data(during,1)};update()
assert(m.status().baseline.complete and listReads==2)
local rare=item('603ULL','Weapon','gamedataQuality : Legendary (4)','gamedataItemCategory : Weapon (6)')
intent(rare,1);added(rare,0,1,false);assert(m.drain()[1].newlyAcquired)
-- Items seen during the uncertain interval remain owned, so they are not new again.
changed(during,0,-1);intent(during,1);added(during,0,1,false);assert(not m.drain()[1].newlyAcquired)
-- An unreadable item or oversized ever-owned set in the clean read itself still keeps it off.
baselineOk=false;now=now+1;ctx.blocked=true;update();ctx.blocked=false;update()
assert(not m.status().baseline.complete)
`));

test('incomplete or oversized baselines never label a later Legendary pickup new', () => run(fixture + `
baselineOk=false;update();assert(not m.status().baseline.complete and listReads==1)
local id=item('501ULL','Weapon','Legendary','Weapon');intent(id,1);added(id,0,1,false)
assert(not m.drain()[1].newlyAcquired)
m.reset();baselineOk=true;baselineItems={}
for index=1,4097 do local row=item(tostring(index+1000)..'ULL');baselineItems[index]=data(row,1)end
update();assert(m.status().baseline.seen==4096 and not m.status().baseline.complete)
assert(nameReads==1,'Baseline must not read thousands of item names')
local unseen=item('99999ULL','Weapon','Legendary','Weapon');intent(unseen,1);added(unseen,0,1,false)
assert(not m.drain()[1].newlyAcquired and m.status().baseline.seen==4096)
`));

test('intent, veto and receipt buffers are bounded and failed hooks keep ownership incomplete', () => run(fixture + `
update()
for index=1,70 do intent(item(tostring(index+100)..'ULL'),1)end
assert(m.status().intents==64)
for index=1,140 do
 local id=item(tostring(index+1000)..'ULL');intent(id,1);added(id,0,1,false)
end
assert(m.status().queued==128 and #m.drain()==128)
for index=1,140 do before['VendorDataManager.BuyItemFromVendor']({},data(item(tostring(index+2000)..'ULL'),1))end
assert(m.status().vetoes<=64 and m.status().intents==0)
local old=ObserveAfter
ObserveAfter=function(class,method,callback)if method=='OnItemChangedEvent'then return false end;return old(class,method,callback)end
local other=(function()${source}end)();other.configure({captureContext=function()return ctx end});other.install();other.update(ctx)
assert(not other.status().baseline.complete);other.reset();other.update(ctx);assert(not other.status().baseline.complete)
`));

test('with Loot reactions off the source callbacks make no native call and capture nothing; turned on, they work as before', () => run(fixture + `
local reads,natives=0,0
local on=false
m.configure({captureContext=function(p)reads=reads+1;ctx.now=now;return ctx end,enabled=function()return on end})
local realGetPlayer=Game.GetPlayer
Game.GetPlayer=function()natives=natives+1;return realGetPlayer()end
-- Off: an interaction, a transfer and a purchase touch nothing (no player read, no context capture, no witnesses).
intent(drink,1)
before['VendorDataManager.TransferItem']({},world,player,data(drink,1),1)
before['VendorDataManager.BuyItemFromVendor']({},data(drink,1),1)
assert(reads==0 and natives==0,'reads '..reads..' natives '..natives)
assert(#m.drain()==0 and m.status().intents==0 and m.status().vetoes==0)
-- A pickup while off records nothing as a receipt. The three inventory callbacks read nothing at all: no player, no item hash.
local hashReads=0;local realHash=ItemID.GetCombinedHash
ItemID.GetCombinedHash=function(id)hashReads=hashReads+1;return realHash(id)end
added(drink,0,1,false);assert(#m.drain()==0)
changed(drink,1,1);after['PlayerPuppet.OnItemChangedEvent'](player,{itemID=drink,currentQuantity=1,difference=-1})
before['PlayerPuppet.OnItemBeingRemovedFromInventory'](player,{itemID=drink})
assert(natives==0 and hashReads==0,'inventory callbacks while off: natives '..natives..' hashes '..hashReads)
ItemID.GetCombinedHash=realHash
-- On again: the next update takes a new baseline and a world pickup is a receipt as it always was.
on=true;now=1010;update()
assert(m.status().baseline.complete)
intent(drink,1);assert(reads==1 and natives>0)
added(drink,1,2,false);local rows=m.drain();assert(#rows==1 and rows[1].quantity==1)
-- A setting that fails to answer leaves the full path in charge (the captured context's own flag decides).
m.configure({captureContext=function()reads=reads+1;return ctx end,enabled=function()error('settings unreadable')end})
local before=reads;intent(drink,1);assert(reads==before+1)
-- No setting given at all: unchanged.
m.configure({captureContext=function()reads=reads+1;return ctx end})
before=reads;intent(drink,1);assert(reads==before+1)
`));
