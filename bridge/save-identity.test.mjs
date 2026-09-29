import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/save-identity.lua', import.meta.url), 'utf8');
function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(`local Identity\n${fixture}\nIdentity=(function()\n${source}\nend)()\n${code}`));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(result, lua.LUA_OK, error);
}

// A source-guided engine boundary fake, not a claim of native save/load proof.
// The tests execute the real Lua adapter through save/restore/interruption
// orders. Native compilation and an in-game save/load roundtrip are separate.
const fixture = `
local function copy(value)
    if type(value) ~= 'table' then return value end
    local result = {}; for k,v in pairs(value) do result[k] = copy(v) end; return result
end
local function limbs(value)
    local result={}; for i=1,32,4 do result[#result+1]=tonumber(value:sub(i,i+3),16) end; return result
end
local function same(a,b)
    if #a ~= #b then return false end
    for i=1,#a do if a[i] ~= b[i] then return false end end; return true
end
local C='11112222333344445555666677778888'
local B='9999aaaabbbbccccddddeeeeffff1234'
local F='abcdabcdabcdabcdabcdabcdabcdabcd'
local A='10000000000000000000000000000001'
local A2='20000000000000000000000000000002'
local persisted={'schema','campaign','branch','branchEpoch','ledgerSequence','checkpointSequence',
    'checkpointBranch','checkpointBranchEpoch','checkpointLedgerSequence'}
local nativeCalls, reads = 0,0
local function native(generation)
    local data={version=1,ready=true,restored=false,resolved=false,generation=generation or 1,
        revision=0,activationId='',faulted=false,saving=false,schema=0,campaign={},branch={},branchEpoch=0,
        ledgerSequence=0,checkpointSequence=0,checkpointBranch={},checkpointBranchEpoch=0,checkpointLedgerSequence=0,
        restoredBranch={},restoredBranchEpoch=0,restoredLedgerSequence=0,restoredCheckpointSequence=0,
        restoredCheckpointValid=false,serializationCompleted=0}
    local system={data=data}
    function system:GetSnapshot() reads=reads+1; return copy(self.data) end
    function system:guard(g,r,a)
        nativeCalls=nativeCalls+1
        return data.ready and not data.saving and not data.faulted and g==data.generation
            and r==data.revision and r<2147483647 and a==data.activationId
    end
    function system:ClaimSession(g,r,previous,next)
        if not self:guard(g,r,previous) then return false end
        data.activationId=next; data.resolved=false; data.revision=data.revision+1; return true
    end
    function system:Seed(g,r,a,campaign,branch)
        if not self:guard(g,r,a) or data.schema~=0 then return false end
        data.schema=1; data.campaign=copy(campaign); data.branch=copy(branch); data.branchEpoch=1
        data.ledgerSequence=0; data.resolved=true; data.revision=data.revision+1; return true
    end
    function system:Resume(g,r,a)
        if not self:guard(g,r,a) or data.schema~=1 or data.resolved then return false end
        data.resolved=true; data.revision=data.revision+1; return true
    end
    function system:Advance(g,r,a,sequence)
        if not self:guard(g,r,a) or data.schema~=1 or not data.resolved
            or sequence~=data.ledgerSequence+1 then return false end
        data.ledgerSequence=sequence; data.revision=data.revision+1; return true
    end
    function system:Fork(g,r,a,branch,epoch)
        if not self:guard(g,r,a) or data.schema~=1 or same(branch,data.branch) or epoch<=data.branchEpoch then return false end
        data.branch=copy(branch); data.branchEpoch=epoch; data.ledgerSequence=0
        data.resolved=true; data.revision=data.revision+1; return true
    end
    function system:beforeSave()
        if not data.ready or data.schema~=1 or not data.resolved then return end
        if data.saving then data.faulted=true; return end
        data.saving=true; data.checkpointSequence=data.checkpointSequence+1
        data.checkpointBranch=copy(data.branch); data.checkpointBranchEpoch=data.branchEpoch
        data.checkpointLedgerSequence=data.ledgerSequence; data.revision=data.revision+1
    end
    function system:afterSave()
        if not data.saving then return end
        data.saving=false; data.serializationCompleted=data.checkpointSequence; data.revision=data.revision+1
    end
    function system:saveBytes()
        local saved={}; for _,key in ipairs(persisted) do saved[key]=copy(data[key]) end; return saved
    end
    function system:restore(saved)
        for _,key in ipairs(persisted) do data[key]=copy(saved[key]) end
        data.restored=true; data.restoredBranch=copy(data.branch); data.restoredBranchEpoch=data.branchEpoch
        data.restoredLedgerSequence=data.ledgerSequence; data.restoredCheckpointSequence=data.checkpointSequence
        data.restoredCheckpointValid=data.schema==1 and data.checkpointSequence>0
            and same(data.checkpointBranch,data.branch) and data.checkpointBranchEpoch==data.branchEpoch
            and data.checkpointLedgerSequence==data.ledgerSequence
    end
    return system
end
local current=native()
local function adapter(lease)
    return Identity.new({activationId=lease or A,getSystem=function() return current end})
end
local function command(driver,kind,fields)
    local value=fields or {}; value.kind=kind; value.expected=driver.inspect().expected; return driver.apply(value)
end
local function seed(driver)
    assert(command(driver,'claim').ok)
    assert(command(driver,'seed',{campaignId=C,branchId=B}).ok)
end
`;

test('requires native readback and an explicit lease/ledger handshake', () => run(`
    assert(Identity.new().capture().reason=='native-system-unavailable')
    local driver=adapter()
    assert(driver.capture().reason=='session-unclaimed')
    assert(command(driver,'claim').ok)
    assert(driver.capture().reason=='identity-uninitialized')
    assert(command(driver,'seed',{campaignId=C,branchId=B}).ok)
    local result=driver.capture()
    assert(result.status=='available' and result.confidence=='native-live')
    assert(result.campaignId==C and result.branchId==B and result.ledgerSequence==0)
    assert(result.promotionCheckpoint==nil and result.restoredProof==nil)
`));

test('bridge ids do not bypass native readiness or overwrite a loaded campaign', () => run(`
    local driver=adapter(); current.data.ready=false
    assert(not command(driver,'claim').ok and nativeCalls==0)
    assert(driver.capture().reason=='native-session-not-ready')
    current.data.ready=true; seed(driver)
    assert(not command(driver,'seed',{campaignId=F,branchId=C}).ok)
    assert(driver.capture().campaignId==C)
`));

test('rejects malformed ids, noninteger sequences, overflow and unknown operations before mutation', () => run(`
    local driver=adapter(); seed(driver); local count=nativeCalls
    for _,value in ipairs({'',string.rep('0',32),string.rep('a',33),string.rep('A',32),'../campaign'}) do
        assert(not command(driver,'seed',{campaignId=value,branchId=B}).ok)
        assert(not command(driver,'fork',{branchId=value,branchEpoch=2}).ok)
    end
    for _,value in ipairs({-1,0,1.5,2147483648,math.huge}) do
        assert(not command(driver,'advance',{ledgerSequence=value}).ok)
    end
    assert(not command(driver,'reset').ok)
    assert(nativeCalls==count)
    assert(not Identity.new({activationId='bad',getSystem=function() return current end})
        .apply({kind='claim',expected=driver.inspect().expected}).ok)
`));

test('CAS rejects delayed commands after a revision, lease or world change', () => run(`
    local driver=adapter(); seed(driver)
    local old={kind='advance',expected=driver.inspect().expected,ledgerSequence=1}
    assert(driver.apply(old).ok)
    assert(not driver.apply(old).ok and driver.capture().ledgerSequence==1)
    local other=adapter(A2); assert(command(other,'claim').ok)
    assert(driver.capture().reason=='session-unclaimed')
    assert(not command(driver,'advance',{ledgerSequence=2}).ok)
    current=native(2)
    assert(not other.apply({kind='resume',expected=old.expected}).ok)
    assert(other.capture().reason=='session-unclaimed')
`));

test('CET/bridge replacement must resolve its readback before exposing old history', () => run(`
    local driver=adapter(); seed(driver); assert(command(driver,'advance',{ledgerSequence=1}).ok)
    local replacement=adapter(A2); assert(command(replacement,'claim').ok)
    assert(replacement.capture().reason=='ledger-not-resolved')
    current:beforeSave(); assert(current.data.checkpointSequence==0)
    assert(command(replacement,'resume').ok)
    assert(replacement.capture().ledgerSequence==1)
    assert(not command(replacement,'resume').ok)
`));

test('save initiation and serialization completion cannot promote unsaved episodes', () => run(`
    local driver=adapter(); seed(driver); assert(command(driver,'advance',{ledgerSequence=1}).ok)
    local prior=driver.inspect().expected
    current:beforeSave()
    assert(driver.capture().reason=='save-in-progress')
    assert(not driver.apply({kind='advance',expected=prior,ledgerSequence=2}).ok)
    assert(driver.inspect().checkpoint.proof=='serialization-candidate')
    current:afterSave()
    local after=driver.capture()
    assert(after.checkpoint.proof=='serialization-finished')
    assert(after.promotionCheckpoint==nil and after.restoredProof==nil)
    assert(after.confidence=='native-live')
`));

test('an actual restored cursor grants only its immutable saved prefix', () => run(`
    local driver=adapter(); seed(driver); assert(command(driver,'advance',{ledgerSequence=1}).ok)
    current:beforeSave(); local bytes=current:saveBytes(); current:afterSave()
    assert(command(driver,'advance',{ledgerSequence=2}).ok)
    current=native(2); current:restore(bytes)
    driver=adapter(A2); assert(command(driver,'claim').ok)
    assert(driver.capture().reason=='ledger-not-resolved')
    assert(driver.inspect().restoredProof.checkpointId==B..':1:1')
    assert(command(driver,'resume').ok)
    local restored=driver.capture()
    assert(restored.confidence=='native-restored' and restored.ledgerSequence==1)
    assert(restored.restoredProof.kind=='native-on-restored')
    assert(restored.restoredProof.checkpointId==B..':1:1')
    assert(command(driver,'advance',{ledgerSequence=2}).ok)
    local advanced=driver.capture()
    assert(advanced.confidence=='native-live' and advanced.restoredProof.ledgerSequence==1)
    current:beforeSave(); current:afterSave()
    assert(driver.capture().restoredProof.checkpointId==B..':1:1')
    assert(driver.capture().checkpoint.id==B..':2:2')
`));

test('rollback forks at restored parent prefix and cannot inherit the future tail', () => run(`
    local driver=adapter(); seed(driver); assert(command(driver,'advance',{ledgerSequence=1}).ok)
    current:beforeSave(); local older=current:saveBytes(); current:afterSave()
    assert(command(driver,'advance',{ledgerSequence=2}).ok)
    current=native(2); current:restore(older); driver=adapter(A2)
    assert(command(driver,'claim').ok)
    local before=driver.inspect(); assert(before.ledgerSequence==1 and before.branchId==B)
    assert(command(driver,'fork',{branchId=F,branchEpoch=2}).ok)
    local fork=driver.capture()
    assert(fork.branchId==F and fork.branchEpoch==2 and fork.ledgerSequence==0)
    assert(fork.restoredProof.branchId==B and fork.restoredProof.ledgerSequence==1)
    assert(fork.confidence=='native-live')
    assert(not command(driver,'fork',{branchId=F,branchEpoch=3}).ok)
    assert(not command(driver,'fork',{branchId=C,branchEpoch=2}).ok)
    assert(command(driver,'advance',{ledgerSequence=1}).ok)
`));

test('new or pre-mod saves cannot adopt an identity merely from the previous process', () => run(`
    local driver=adapter(); seed(driver)
    current=native(2); current.data.restored=true
    driver=adapter(A2); assert(command(driver,'claim').ok)
    assert(driver.capture().reason=='identity-uninitialized')
    assert(command(driver,'seed',{campaignId=F,branchId=C}).ok)
    local result=driver.capture()
    assert(result.campaignId==F and result.branchId==C)
    assert(result.restoredProof==nil and result.confidence=='native-live')
`));

test('does not manufacture restore proof for mismatched or missing checkpoint fields', () => run(`
    local driver=adapter(); seed(driver); assert(command(driver,'advance',{ledgerSequence=1}).ok)
    current:beforeSave(); local bytes=current:saveBytes(); current:afterSave()
    bytes.checkpointLedgerSequence=0
    current=native(2); current:restore(bytes); driver=adapter(A2)
    assert(command(driver,'claim').ok and command(driver,'resume').ok)
    local result=driver.capture()
    assert(result.restoredCursor.ledgerSequence==1)
    assert(result.restoredProof==nil and result.promotionCheckpoint==nil)
`));

test('a successful Bool with failed or different native readback is not success', () => run(`
    local driver=adapter(); seed(driver)
    current.Advance=function() return true end
    local result=command(driver,'advance',{ledgerSequence=1})
    assert(not result.ok and result.reason=='native-readback-mismatch')
    assert(driver.capture().ledgerSequence==0)
    current.GetSnapshot=function() error('world detached') end
    assert(driver.capture().status=='unavailable')
`));

test('lost command replies require reconciliation and are never automatically retried', () => run(`
    local driver=adapter(); seed(driver)
    local original=current.Advance
    current.Advance=function(self,...)
        assert(original(self,...)); error('reply interrupted after native commit')
    end
    local before=nativeCalls
    local result=command(driver,'advance',{ledgerSequence=1})
    assert(not result.ok and result.reason=='native-command-uncertain')
    assert(nativeCalls==before+1 and driver.inspect().ledgerSequence==1)
`));

test('nested saves, malformed snapshots and detach fail closed without cached handles', () => run(`
    local driver=adapter(); seed(driver)
    current:beforeSave(); current:beforeSave()
    assert(driver.capture().reason=='native-lifecycle-fault')
    current=native(2)
    assert(driver.capture().reason=='session-unclaimed')
    current.data.schema=2
    assert(driver.capture().reason=='native-read-failed')
    current=nil
    assert(driver.capture().reason=='native-read-failed')
`));

test('all IDs roundtrip without loss across high-bit UUID limbs', () => run(`
    local driver=adapter(); assert(command(driver,'claim').ok)
    local high='ffffffff8000ffff00010002fffeffff'
    assert(command(driver,'seed',{campaignId=high,branchId=B}).ok)
    assert(driver.capture().campaignId==high)
    local result=driver.inspect()
    result.expected.revision=2147483648
    assert(not driver.apply({kind='resume',expected=result.expected}).ok)
`));
