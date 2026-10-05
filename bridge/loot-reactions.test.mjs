import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const source = readFileSync(new URL('../mod/loot-reactions.lua', import.meta.url), 'utf8');
function run(code) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}
const fixture = `
-- A policy must not call the game, filesystem, clock, network or random APIs.
Game=nil; io=nil; os=nil; math.random=nil
local policy=(function() ${source} end)().new()
local now=1000
local people={{entity='1ULL',profileKey='judy-alvarez',distance=2,available=true,name='Judy'},
  {entity='2ULL',profileKey='judy-alvarez',distance=3,available=true,name='Judy'},
  {entity='3ULL',profileKey='panam-palmer',distance=4,available=true,name='Panam'}}
local sample={available=true,blocked=false,paused=false,combat=false,holdForBattle=false}
local enabled=true
local function tick(dt)
  now=now+dt; policy.update(sample,dt,now,enabled,people)
end
local function wait(seconds)
  while seconds>0 do local dt=math.min(1,seconds); tick(dt); seconds=seconds-dt end
end
local function item(id,overrides)
  local row={acquisitionId=id,identity='hash-'..id,record='Items.Drink',name='NiCola',quantity=1,
    quality='Common',category='Consumable',newlyAcquired=false,source='world',confirmed=true}
  for key,value in pairs(overrides or {})do row[key]=value end
  return row
end
local function add(id,overrides,witnesses)
  return policy.acquire(item(id,overrides),witnesses or people,now)
end
local function offer(busy)return policy.offer(busy,people,now)end
local function capture(entity,profile)
  return policy.capture({forReaction=true,entity=entity or '1ULL',profileKey=profile or 'judy-alvarez'},now)
end
tick(0)
`;

test('only normalized confirmed world acquisitions enter the batch', () => run(fixture + `
local cases={{source='stash'},{source='vendor'},{confirmed=false},{quantity=0},{quantity=-1},
  {quantity=.5},{quantity=math.huge},{quantity=0/0},{quality='5'},{quality='Unknown'},
  {newlyAcquired='yes'},{identity=''},{name='bad\\nname'},{record=string.rep('x',241)},
  {acquisitionId='contains space'},{category='Unknown category'}}
for i,override in ipairs(cases)do
  local ok=add('invalid-'..i,override);assert(not ok,'accepted invalid input '..i)
end
assert(policy.status().pending==0)
assert(add('confirmed'))
assert(policy.status().pending==1)
`));

test('duplicate native callbacks count once; distinct acquisitions of one stack accumulate', () => run(fixture + `
assert(add('one',{identity='same-stack',quantity=2}))
local ok,reason=add('one',{identity='same-stack',quantity=2})
assert(not ok and reason=='duplicate')
assert(add('two',{identity='same-stack',quantity=3}))
assert(#policy.capture().items==1 and policy.capture().items[1].quantity==5)
wait(6);local event=assert(offer(false))
assert(event.loot.items[1].quantity==5 and event.reaction.kind=='loot')
assert(event.reaction.expiresAt==math.floor((now+30)*1000))
assert(event.loot.batch:match('^loot%-%d+%-%d+$'))
assert(policy.claim(event,now));assert(not offer(false))
assert(not add('one'),'A consumed receipt must still be deduplicated')
`));

test('a batch waits six quiet gameplay seconds and new pickups restart the window', () => run(fixture + `
add('one');wait(5);assert(not offer(false))
assert(policy.status().collecting and policy.status().quietSeconds==5)
add('two');wait(5);assert(not offer(false));wait(1)
assert(not policy.status().collecting and offer(false))
`));

test('pausing freezes quiet time and cannot admit or consume reactions', () => run(fixture + `
add('one');wait(2);sample.paused=true;wait(20)
assert(policy.status().quietSeconds==2 and not offer(false))
assert(not capture())
sample.paused=false;tick(0);wait(4);local event=assert(offer(false))
sample.paused=true;tick(0);assert(not policy.claim(event,now))
sample.paused=false;tick(0);assert(policy.claim(event,now))
`));

test('ordinary loot has a ten-minute cooldown without retrospectively replaying old batches', () => run(fixture + `
add('first');wait(6);local first=assert(offer(false));assert(policy.claim(first,now))
local started=now;assert(policy.status().cooldownUntil==started+600)
assert(policy.release(first.reaction));add('during-cooldown');wait(6);assert(not offer(false))
wait(91);assert(policy.status().pending==0 and not offer(false))
now=started+590;tick(0);add('near-end');wait(6);assert(not offer(false));wait(4)
assert(offer(false))
`));

test('new Legendary equipment bypasses ordinary cooldown, with a separate two-minute minimum', () => run(fixture + `
add('ordinary');wait(6);local first=assert(offer(false));policy.claim(first,now);policy.release(first.reaction)
add('rare',{record='Items.Pistol',name='Pistol',quality='LegendaryPlus',category='Weapon',newlyAcquired=true})
wait(6);local rare=assert(offer(false));assert(rare.loot.exceptional)
assert(policy.claim(rare,now));local rareAt=now;policy.release(rare.reaction)
add('another',{record='Items.Coat',name='Coat',quality='LegendaryPlusPlus',category='Clothing',newlyAcquired=true})
wait(6);assert(not offer(false));wait(91);assert(policy.status().pending==0)
now=rareAt+114;tick(0)
add('after-cooldown',{record='Items.Coat',quality='Legendary',category='Clothing',newlyAcquired=true})
wait(6);assert(offer(false))
`));

test('a snapshot keeps the verified quality and optional item type of every Legendary pickup', () => run(fixture + `
add('weapon',{record='Items.Preset_Pride',name='Pride',quality='Legendary',category='Weapon',itemType='Wea_AssaultRifle',newlyAcquired=true})
add('mod',{record='Items.Scope',name='Scope',quality='LegendaryPlus',category='WeaponMod',itemType='Prt_Scope',newlyAcquired=true})
add('junk',{record='Items.Junk',name='Junk',quality='Common',category='General',itemType='Not a type!'})
wait(6);local event=assert(offer(false));assert(policy.claim(event,now))
local rows={}
for _,row in ipairs(event.loot.items)do rows[row.name]=row end
assert(rows.Pride.quality=='Legendary' and rows.Pride.itemType=='Wea_AssaultRifle' and rows.Pride.category=='Weapon')
assert(rows.Scope.quality=='LegendaryPlus' and rows.Scope.itemType=='Prt_Scope')
assert(rows.Junk.itemType==nil,'A malformed descriptive type is dropped, not a rejection')
assert(event.loot.exceptional and event.loot.items[1].name=='Pride','Legendary equipment is described first')
`));

test('old equipment and Legendary consumables cannot use the new-equipment exception', () => run(fixture + `
add('ordinary');wait(6);local first=offer(false);policy.claim(first,now);policy.release(first.reaction)
add('returned-weapon',{record='Items.Pistol',quality='Legendary',category='Weapon',newlyAcquired=false})
add('consumable',{quality='Legendary',newlyAcquired=true})
add('epic-weapon',{record='Items.Rifle',quality='Epic',category='Weapon',newlyAcquired=true})
wait(6);assert(not offer(false));assert(not policy.capture().exceptional)
`));

test('verified Cyberpunk plus qualities are accepted and newly acquired Legendary cyberware is equipment', () => run(fixture + `
for _,quality in ipairs({'CommonPlus','UncommonPlus','RarePlus','EpicPlus','Iconic'})do
  assert(add('quality-'..quality,{quality=quality}))
end
assert(not policy.capture().exceptional)
wait(6);local ordinary=assert(offer(false));policy.claim(ordinary,now);policy.release(ordinary.reaction)
add('implant',{record='Items.Implant',name='Implant',quality='LegendaryPlus',category='Cyberware',newlyAcquired=true})
wait(6);local event=assert(offer(false));assert(event.loot.exceptional)
`));

test('witnessing is exact entity plus profile, so a later copy cannot claim an earlier pickup', () => run(fixture + `
add('one',nil,{people[1]});wait(6)
people={people[2]};tick(0);assert(not offer(false));assert(not capture('2ULL'))
people={{entity='1ULL',profileKey='different-profile',distance=2,available=true}}
tick(0);assert(not offer(false))
people={{entity='1ULL',profileKey='judy-alvarez',distance=2,available=true}}
tick(0);assert(offer(false))
`));

test('each selected witness receives only what that particular copy observed', () => run(fixture + `
add('judy-only',{name='Judy pickup'}, {people[1]})
add('panam-only',{name='Panam pickup'}, {people[3]})
add('both',{name='Shared pickup'}, {people[1],people[3]})
wait(6)
local judy=assert(capture());local panam=assert(capture('3ULL','panam-palmer'))
assert(#judy.items==2 and judy.items[1].name=='Judy pickup')
assert(#panam.items==2 and panam.items[1].name=='Panam pickup')
local event=assert(offer(false));local ok,trusted=policy.claim(event,now);assert(ok)
assert(trusted.witness.entity=='1ULL' and policy.status().pending==0)
assert(not offer(false),'One pickup batch cannot be spoken by each witness in turn')
`));

test('speakers are nearby available witnesses, deduplicated by profile, with deterministic rotation', () => run(fixture + `
people[1].available=false
add('one');wait(6);local first=assert(offer(false));assert(first.person.entity=='2ULL')
assert(policy.claim(first,now));policy.release(first.reaction)
wait(600);add('two');wait(6);local next=assert(offer(false))
assert(next.person.profileKey=='panam-palmer','Another available profile gets the next turn')
people[3].distance=21;people[2].available=false;tick(0)
assert(not offer(false))
`));

test('scripted scenes, disabled settings and unavailable saves discard rather than defer loot', () => run(fixture + `
for index,condition in ipairs({'blocked','disabled','available'})do
  sample.available=true;sample.blocked=false;enabled=true;tick(0)
  add('before-'..index);wait(6);local prepared=assert(offer(false))
  if condition=='blocked'then sample.blocked=true
  elseif condition=='disabled'then enabled=false else sample.available=false end
  tick(0);assert(policy.status().pending==0)
  assert(not add('during-'..index));assert(not policy.claim(prepared,now))
  sample.available=true;sample.blocked=false;enabled=true;tick(0)
  assert(not add('during-'..index),'A retried suppressed receipt must not replay')
  wait(6);assert(not offer(false))
end
`));

test('save reset clears cooldowns and invalidates old ownership, even when receipt IDs recur', () => run(fixture + `
add('one');wait(6);local oldSnapshot=assert(capture());local oldEvent=assert(offer(false))
assert(policy.claim(oldEvent,now));assert(policy.valid(oldEvent.reaction,now))
policy.reset();tick(0);assert(policy.status().cooldownUntil==0)
assert(add('one'));wait(6);local fresh=assert(capture())
assert(fresh.batch~=oldSnapshot.batch)
assert(not policy.claim(oldEvent,now) and not policy.valid(oldEvent.reaction,now))
assert(policy.status().pending==1 and policy.claim(assert(offer(false)),now))
`));

test('combat loot accumulates, then waits for its own standalone turn without a battle reservation', () => run(fixture + `
sample.combat=true;tick(0);add('battle');wait(6);assert(not offer(false))
local during=assert(capture());assert(policy.status().pending==1)
sample.combat=false;sample.holdForBattle=true;tick(0)
local event=assert(offer(false));assert(event.loot.batch==during.batch)
assert(policy.status().cooldownUntil==0 and policy.status().exceptionalCooldownUntil==0)
assert(policy.claim(event,now))
assert(policy.status().cooldownUntil==now+600 and policy.status().exceptionalCooldownUntil==0)
assert(policy.status().pending==0)
`));

test('a new combat transition discards prior exploration loot; this battle and aftermath share one batch', () => run(fixture + `
add('exploration',{name='Before the fight'});wait(6);local old=assert(capture())
sample.combat=true;tick(0)
assert(policy.status().pending==0)
assert(not add('exploration'),'The old receipt cannot be retried into the new fight')
add('during',{name='During the fight'});wait(6);assert(policy.status().pending==1)
sample.combat=false;sample.holdForBattle=true;tick(0)
add('after',{name='After the fight'});wait(6)
local snapshot=assert(capture());assert(#snapshot.items==2)
assert(snapshot.items[1].name=='During the fight' and snapshot.items[2].name=='After the fight')
local event=assert(offer(false));assert(event.loot.batch==snapshot.batch and policy.claim(event,now))
`));

test('standalone snapshot claim is exactly once and preserves later acquisitions of the same item', () => run(fixture + `
add('first',{identity='same',quantity=2});wait(6);local event=assert(offer(false));local snapshot=event.loot
add('later',{identity='same',quantity=3})
snapshot.items[1].quantity=999;snapshot.items[1].name='Caller mutation'
wait(6);local ok,trusted=policy.claim(event,now);assert(ok)
assert(trusted.items[1].quantity==2 and trusted.items[1].name=='NiCola')
assert(policy.status().pending==1 and policy.capture().items[1].quantity==3)
assert(not policy.claim(event,now))
assert(policy.status().pending==1)
`));

test('stale overlapping captures cannot consume a newer prefix', () => run(fixture + `
add('first');wait(6);local older=assert(offer(false));add('second');wait(6);local larger=assert(offer(false))
assert(policy.claim(older,now));policy.release(older.reaction);assert(not policy.claim(larger,now))
assert(policy.status().pending==1 and policy.capture().items[1].quantity==1)
assert(not offer(false),'The independent loot cooldown still applies to later pickups')
`));

test('battle cannot capture or consume loot and standalone claims require their available exact witness', () => run(fixture + `
add('one');wait(6);local ordinary=assert(offer(false))
assert(policy.consumeForBattle==nil and policy.suppressAfterBattle==nil)
local none,reason=policy.capture({forBattle=true,entity='1ULL',profileKey='judy-alvarez'},now)
assert(not none and reason=='separate-reactions' and policy.status().pending==1)
people[1].available=false;tick(0);assert(not policy.claim(ordinary,now))
people[1].available=true;tick(0);sample.combat=true;tick(0)
sample.combat=false;tick(0)
assert(not policy.claim(ordinary,now),'A later fight invalidates an earlier pickup request')
assert(policy.status().pending==0)
`));

test('a legacy battle reservation does not change standalone pickup cooldowns', () => run(fixture + `
sample.holdForBattle=true;tick(0)
assert(policy.status().cooldownUntil==0 and policy.status().exceptionalCooldownUntil==0)
add('new-legendary',{record='Items.Pistol',quality='Legendary',category='Weapon',newlyAcquired=true})
wait(6);local event=assert(offer(false));assert(event.loot.exceptional and policy.status().pending==1)
`));

test('manual busy and collecting races cannot admit a prepared standalone reaction', () => run(fixture + `
add('one');wait(6);assert(not offer(true));local event=assert(offer(false))
add('two');assert(not policy.claim(event,now));assert(policy.status().pending==2)
wait(6);assert(policy.claim(event,now));assert(policy.status().pending==1)
assert(not policy.claim(event,now) and not offer(false))
`));

test('a prepared event cannot silently switch its recipient or extend its admission deadline', () => run(fixture + `
add('one');wait(6);local event=assert(offer(false))
event.person.entity='2ULL';local ok,reason=policy.claim(event,now)
assert(not ok and reason=='speaker-changed' and policy.status().pending==1)
event.person.entity='1ULL';event.reaction.expiresAt=event.reaction.expiresAt+1000
ok,reason=policy.claim(event,now);assert(not ok and reason=='deadline-changed')
event.reaction.expiresAt=event.reaction.expiresAt-1000;assert(policy.claim(event,now))
`));

test('claimed leases honor admission deadlines and permit only timely bounded playback', () => run(fixture + `
add('one');wait(6);local event=assert(offer(false));assert(policy.claim(event,now))
local expiry=event.reaction.expiresAt/1000
assert(policy.valid(event.reaction,now))
now=expiry+1;tick(0)
assert(not policy.valid(event.reaction,now))
assert(policy.valid(event.reaction,now,expiry-1))
assert(not policy.valid(event.reaction,now,expiry+1))
now=expiry+30;tick(0);assert(not policy.valid(event.reaction,now,expiry-1))
`));

test('lease owner is exact, temporary native speech can wait, and interruption never replays', () => run(fixture + `
add('one');wait(6);local event=assert(offer(false));assert(policy.claim(event,now))
people[1].available=false;people[1].voiceBusy=true;tick(0)
local ok,reason=policy.valid(event.reaction,now);assert(ok and reason=='speaker-waiting')
people[1].voiceBusy=false;tick(0);assert(not policy.valid(event.reaction,now))
people[1].available=true;tick(0);assert(policy.valid(event.reaction,now))
people={people[2],people[3]};tick(0);assert(not policy.valid(event.reaction,now))
assert(not policy.release({batch='wrong'}));assert(policy.release(event.reaction))
assert(not policy.valid(event.reaction,now) and not offer(false))
assert(policy.status().pending==0)
`));

test('a claimed reaction is invalidated by a new fight or save teardown', () => run(fixture + `
for _,mode in ipairs({'combat','unavailable'})do
  policy.reset();sample={available=true};tick(0);add('one');wait(6)
  local event=assert(offer(false));assert(policy.claim(event,now))
  if mode=='unavailable'then sample.available=false else sample[mode]=true end
  tick(0);assert(not policy.valid(event.reaction,now))
  sample={available=true};tick(0);assert(not offer(false))
end
`));

test('pending age expires after ninety seconds of activity even across a long pause', () => run(fixture + `
add('one');wait(6);local old=assert(capture());sample.paused=true
now=now+91;tick(0)
assert(policy.status().pending==0 and policy.status().snapshots==0)
sample.paused=false;tick(0);assert(not offer(false))
assert(add('fresh'));wait(6);assert(offer(false))
`));

test('receipt, description, witness, snapshot and dedup stores have enforced bounds', () => run(fixture + `
for i=1,130 do add('receipt-'..i,{name='Pickup '..i,record='Items.Item'..i})end
assert(policy.status().pending==128 and #policy.capture().items==12)
local ok,reason=add('overflow');assert(not ok and reason=='batch-full')
local limits=policy.status().limits;limits.receipts=10000;assert(policy.status().limits.receipts==128)
policy.reset();tick(0);people={}
for i=1,24 do people[i]={entity=i..'ULL',profileKey='profile-'..i,distance=i/2,available=true}end
tick(0);add('witness-limit')
assert(not capture('17ULL','profile-17'))
for i=1,8 do assert(capture(i..'ULL','profile-'..i))end
assert(policy.status().snapshots==8)
local missing,full=capture('9ULL','profile-9');assert(not missing and full=='snapshot-capacity')
assert(capture('1ULL','profile-1'),'Polling the same capture reuses its owned token')
wait(31);assert(policy.status().snapshots==0 and capture('9ULL','profile-9'))
policy.reset();enabled=false;tick(0)
for i=1,1100 do add('seen-'..i)end
assert(policy.status().rememberedReceipts==1024)
enabled=true;tick(0);local accepted,full=add('cache-overflow');assert(not accepted and full=='receipt-cache-full')
wait(181);assert(add('new-after-expiry'))
`));

test('rare descriptions survive a full ordinary description set and quantities remain bounded', () => run(fixture + `
for i=1,15 do add('ordinary-'..i,{name='Ordinary '..i,record='Items.Item'..i})end
add('rare',{record='Items.Pistol',name='Legendary pistol',quality='Legendary',category='Weapon',newlyAcquired=true})
wait(6);local event=assert(offer(false))
assert(#event.loot.items==12 and event.loot.exceptional and event.loot.items[1].name=='Legendary pistol')
policy.reset();tick(0);add('big-one',{quantity=1000000});add('big-two',{quantity=1000000})
assert(policy.capture().items[1].quantity==1000000)
`));

test('public snapshots are plain detached data and never retain supplied game objects', () => run(fixture + `
people[1].npc={dangerous=function()error('native access')end}
local acquisition=item('one');acquisition.native={};assert(policy.acquire(acquisition,people,now))
acquisition.name='Mutated input';people[1].profileKey='Mutated profile';tick(0)
-- The original witness needs to be present again before offering.
people[1].profileKey='judy-alvarez';tick(0);wait(6);local event=assert(offer(false))
assert(event.loot.items[1].name=='NiCola' and event.person.npc==nil)
local function plain(value)
  if type(value)=='table'then for k,v in pairs(value)do assert(type(k)=='string' or type(k)=='number');plain(v)end
  else assert(type(value)=='string' or type(value)=='number' or type(value)=='boolean' or value==nil)end
end
plain(event);plain(policy.status());plain(policy.capture())
local snapshot,extra=capture();assert(snapshot and extra==nil,'Do not expose the internal token table')
snapshot.witness.entity='MUTATED';snapshot.items[1].name='MUTATED';event.loot=snapshot
local ok,trusted=policy.claim(event,now);assert(ok)
assert(trusted.witness.entity=='1ULL' and trusted.items[1].name=='NiCola')
`));
