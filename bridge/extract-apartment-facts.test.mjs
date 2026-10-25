import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify, collectFacts, compareFacts, isApartmentFact, parseReservedFacts} from '../scripts/Extract-ApartmentFacts.mjs';

// Two tiny stand-ins for cooked quest data: facts hide in nested objects and arrays, and the same name shows up in both files.
const questphase = {
    Data: {RootChunk: {graph: {nodes: [
        {Data: {conditionNode: {condition: {factName: 'mq055_02_downtown_active', value: 1}}}},
        {Data: {setter: {factName: 'dlc6_apart_hey_gle_purchase_setup'}}},
        {Data: {setter: {factName: 'dlc6_apart_hey_gle_purchased'}}}, // ownership result: never listed
        {Data: {setter: {factName: 'apartment_on'}}}, // global switch: never listed
        {Data: {setter: {factName: 'mq055_05_downtown_activities_off - fact disabled after feedback'}}}, // a note, not a fact name
        {Data: {setter: {factName: 'travelling_merchant_lives'}}}, // not an apartment fact
        {Data: {setter: {factName: 'mq055_northside_shower'}}},
        {Data: {setter: {factName: 'mq055_02_active'}}},
    ]}}},
};
const scene = {
    Data: {RootChunk: {screenplayStore: {events: [
        {factName: {$type: 'CName', $value: 'q305_johnny_scene_active'}},
        {factName: 'dlc6_apart_wbr_jpn_purchase'},
        {factName: 'dlc6_apart_dtn_sleeping'},
        {factName: 'web_apartment_website_start'},
        {factName: 'mq055_02_active'}, // duplicate of the other file
        {factName: 'mq000_vs_apartment_active'},
        {factName: 'johnny_default_sit_active'},
        {factName: 'judys_apartment_exploration'},
        {factName: 'dlc6_apart_wat_nid_purchase'},
        {nested: [{deeper: {factName: 'mq055_02_megabuilding_active'}}]},
        {other: 'mq055_never_a_fact_name', factName: 42},
    ]}}},
};

test('classify sends each name to its apartment', () => {
    assert.equal(classify('dlc6_apart_cct_dtn_purchase'), 'corpo');
    assert.equal(classify('mq055_02_downtown_active'), 'corpo');
    assert.equal(classify('dlc6_apart_hey_gle_purchase_setup'), 'glen');
    assert.equal(classify('mq055_04_intimate_action_on'), 'any');
    assert.equal(classify('mq055_heywood_shower'), 'glen');
    assert.equal(classify('dlc6_apart_wbr_jpn_purchase'), 'japan');
    assert.equal(classify('mq055_03_japantown_x'), 'japan');
    assert.equal(classify('dlc6_apart_wat_nid_purchase'), 'north');
    assert.equal(classify('mq055_northside_shower'), 'north');
    assert.equal(classify('mq055_02_megabuilding_active'), 'h10');
    assert.equal(classify('mq000_vs_apartment_active'), 'h10');
    assert.equal(classify('q305_johnny_scene_active'), 'h10');
    assert.equal(classify('mq055_02_active'), 'any');
    assert.equal(classify('web_apartment_website_start'), 'any');
    // The short district tokens of the dlc6 names.
    assert.equal(classify('dlc6_apart_dtn_sleeping'), 'corpo');
    assert.equal(classify('dlc6_apart_gle_tv_on'), 'glen');
    assert.equal(classify('dlc6_apart_jpn_tv_on'), 'japan');
});

test('isApartmentFact keeps the family and drops the excluded names', () => {
    for (const name of ['dlc6_apart_x', 'mq055_02_active', 'web_apartment_website_start', 'q305_a', 'johnny_default_sit_active', 'mq000_a', 'judys_apartment_exploration']) {
        assert.equal(isApartmentFact(name), true, name);
    }
    for (const name of ['dlc6_apart_cct_dtn_purchased', 'apartment_on', 'travelling_merchant_lives', 'q001_in_v_room', 'x y apartment', '']) {
        assert.equal(isApartmentFact(name), false, name);
    }
});

test('collectFacts walks nested data, filters, groups, de-duplicates and sorts', () => {
    const facts = collectFacts([questphase, scene]);
    assert.deepEqual(facts, {
        any: ['judys_apartment_exploration', 'mq055_02_active', 'web_apartment_website_start'],
        h10: ['johnny_default_sit_active', 'mq000_vs_apartment_active', 'mq055_02_megabuilding_active', 'q305_johnny_scene_active'],
        corpo: ['dlc6_apart_dtn_sleeping', 'mq055_02_downtown_active'],
        glen: ['dlc6_apart_hey_gle_purchase_setup'],
        japan: ['dlc6_apart_wbr_jpn_purchase'],
        north: ['dlc6_apart_wat_nid_purchase', 'mq055_northside_shower'],
    });
    // Order of the inputs does not matter.
    assert.deepEqual(collectFacts([scene, questphase]), facts);
    assert.deepEqual(collectFacts([]), {any: [], h10: [], corpo: [], glen: [], japan: [], north: []});
});

test('the Lua table and the comparison', () => {
    const lua = `
local D = {version = 1}
D.reservedFacts = {
    any = {'mq055_02_active', "web_apartment_website_start"},
    -- q001_in_v_room is deliberately not listed.
    h10 = {'q305_johnny_scene_active'},
    corpo = {'dlc6_apart_cct_dtn_purchase', 'mq055_02_downtown_active'},
}
D.apartments = {h10 = {id = 'h10'}}`;
    const data = parseReservedFacts(lua);
    assert.deepEqual(data.any, ['mq055_02_active', 'web_apartment_website_start']);
    assert.deepEqual(data.h10, ['q305_johnny_scene_active']);
    assert.deepEqual(data.glen, []);
    const report = compareFacts(collectFacts([questphase, scene]), data);
    assert.deepEqual(report.any.missingInData, ['judys_apartment_exploration']);
    assert.deepEqual(report.any.notInGame, []);
    assert.deepEqual(report.corpo.missingInData, ['dlc6_apart_dtn_sleeping']);
    assert.deepEqual(report.corpo.notInGame, ['dlc6_apart_cct_dtn_purchase']);
    assert.throws(() => parseReservedFacts('local D = {}'), /not found/);
});
