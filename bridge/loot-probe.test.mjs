import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/loot-probe.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const result = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}
const fixture = `
local now,reads,registrations=1000,0,0
os.time=function()return now end
local before,after={},{}
ObserveBefore=function(class,method,fn)registrations=registrations+1;before[class..'.'..method]=fn end
ObserveAfter=function(class,method,fn)registrations=registrations+1;after[class..'.'..method]=fn end
local function object(id,kind)
 return {GetEntityID=function()reads=reads+1;return {hash=id}end,
  GetClassName=function()return kind end,IsPlayer=function()return kind=='player'end,
  IsPlayerStash=function()return kind=='player-stash'end,IsVehicle=function()return kind=='vehicle'end,
  IsNPC=function()return kind=='npc'end}
end
local player,vehicle=object('1ULL','player'),object('2ULL','vehicle')
local transaction={HasItem=function()return true end}
Game={GetPlayer=function()reads=reads+1;return player end,GetTransactionSystem=function()return transaction end}
NameToString=function(value)return value end
CName={new=function(value)return value end};Enum={new=function(_,value)return value end}
ItemID={IsValid=function(id)return id~=nil end,GetCombinedHash=function(id)return id.hash end,
 GetTDBID=function(id)return id.record end,GetRngSeed=function(id)return id.seed end,HasFlag=function()return false end}
TDBID={ToStringDEBUG=function(value)return value end,ToNumber=function()return 123 end}
RPGManager={GetItemDataQuality=function()return 'Legendary'end,GetItemCategory=function()return 'Weapon'end,
 IsItemIconic=function()return false end,IsItemBroken=function()return false end}
TweakDBInterface={GetItemRecord=function(id)return id end}
UIItemsHelper={GetItemName=function(_,data)return data.name end}
local id={hash='12345ULL',record='Items.Example',seed=3}
local data={name='Example',GetQuantity=function()return 4 end,GetItemType=function()return 'Wea_Handgun'end,
 HasTag=function()return false end,GetID=function()return id end}
local event={itemID=id,itemData=data,currentQuantity=4,flaggedAsSilent=false,difference=2}
local m=(function()${source}end)()
`;

test('probe is inert until started, observers preserve calls, and snapshots contain no native references', () => run(fixture + `
m.install();local count=registrations;m.install();assert(registrations==count)
local observe=after['PlayerPuppet.OnItemAddedToInventory']
observe(player,event);assert(reads==0 and #m.status().events==0)
m.start(30)
local nativeCalls=0
local function nativeCall(p,e)
 assert(p==player and e==event);nativeCalls=nativeCalls+1;return 'native-result',42
end
local function dispatch(p,e)
 local a,b=nativeCall(p,e);assert(observe(p,e)==nil);return a,b
end
local a,b=dispatch(player,event);assert(a=='native-result' and b==42 and nativeCalls==1)
local status=m.status();local row=status.events[1]
assert(row.item.hash=='12345ULL' and row.item.record=='Items.Example' and row.item.name=='Example')
assert(row.total==4 and row.silent==false and row.source.kind=='unavailable' and row.owner.localPlayer)
id.hash='changed';data.name='changed';event.currentQuantity=999
assert(m.status().events[1].item.hash=='12345ULL' and m.status().events[1].total==4)
row.item.hash='mutated receipt';assert(m.status().events[1].item.hash=='12345ULL')
local function plain(v)
 if type(v)=='table' then for k,x in pairs(v)do assert(type(k)=='string' or type(k)=='number');plain(x)end
 else assert(type(v)=='string' or type(v)=='boolean' or type(v)=='number')end
end
plain(status)
m.stop();local prior=reads;dispatch(player,event);assert(reads==prior and #m.status().events==1)
`));

test('source-bearing storage and vendor intent stay distinct from confirmed inventory events', () => run(fixture + `
m.start(30)
local transfer=before['VendorDataManager.TransferItem']
assert(transfer({},vehicle,player,data,2)==nil)
local row=m.status().events[1]
assert(row.kind=='vendor-data-transfer' and row.source.kind=='vehicle' and row.source.isPlayerStash==false)
assert(row.target.localPlayer and row.amount==2 and row.success=='unavailable')
local vendor={GetVendorInstance=function()return object('3ULL','npc')end}
before['VendorDataManager.BuyItemFromVendor'](vendor,data,1,17)
before['VendorDataManager.BuybackItemFromVendor'](vendor,data,1,18)
after['PlayerPuppet.OnItemChangedEvent'](player,event)
local rows=m.status().events
assert(rows[2].kind=='vendor-buy-request' and rows[3].kind=='vendor-buyback-request')
assert(rows[4].delta==2 and rows[4].silent=='unavailable')
event.flaggedAsSilent=true;after['PlayerPuppet.OnItemAddedToInventory'](player,event)
assert(m.status().events[5].silent==true)
`));

test('capture stops at its hard bound, expires, and releases on player detach', () => run(fixture + `
m.start({seconds=9999,maxEvents=9999});assert(m.status().maxEvents==512 and m.status().expiresAt==1300)
for _=1,600 do after['PlayerPuppet.OnItemAddedToInventory'](player,event)end
local state=m.status();assert(#state.events==512 and not state.active and state.stopReason=='event-limit')
assert(state.events[512].sequence==512)
m.start(2);now=1002;after['PlayerPuppet.OnItemAddedToInventory'](player,event)
assert(#m.status().events==0 and m.status().stopReason=='expired')
m.start(10);before['PlayerPuppet.OnDetach']();assert(not m.status().active and m.status().stopReason=='player-detached')
m.start(10);before['PlayerPuppet.OnDeath']();assert(not m.status().active and m.status().stopReason=='player-died')
`));

test('unknown native reads are labelled unavailable and failed registrations do not stop other hooks', () => run(fixture + `
local original=ObserveBefore
ObserveBefore=function(class,method,fn)
 if class=='Inventory' and method=='OnLootAllEvent' then error('not exposed')end
 return original(class,method,fn)
end
m.start(10)
assert(not m.status().hooks['Inventory.OnLootAllEvent'].registered)
RPGManager.GetItemDataQuality=function()error('unsupported')end
Game.GetTransactionSystem=function()error('unavailable')end
after['PlayerPuppet.OnItemAddedToInventory'](player,event)
local row=m.status().events[1];assert(row.item.quality=='unavailable' and row.item.ownedByPlayer=='unavailable')
assert(row.item.hash=='12345ULL' and m.status().active)
ItemID.GetCombinedHash=function()return nil end
player.GetEntityID=function()return {}end
after['PlayerPuppet.OnItemAddedToInventory'](player,event)
row=m.status().events[2]
assert(row.item.hash=='unavailable' and row.owner.id=='unavailable' and row.owner.localPlayer=='unavailable')
`));
