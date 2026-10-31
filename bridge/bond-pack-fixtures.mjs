// Pack fixtures shared by the round 2 tests (bridge/bond-packs-gate-plus.test.mjs, bridge/bond-pack-round2.test.mjs). Not part of the Runtime.

export const panamHangout = () => ({format: 2, id: 'test-hangout', character: 'panam-palmer', kind: 'hangout', title: 'Test hangout',
  requires: {questsFinished: ['quests/side_quest/sq004_riders_on_the_storm']}, start: {channels: ['own'], chance: 1, bringUp: 'You ask V if V wants to do something.'},
  places: {spot: {name: 'The spot', radius: 10}, other: {name: 'Another spot', radius: 10}},
  lines: {'H.1': {text: 'You made it.', channel: 'own'}},
  hangout: {repeatDays: 3, capPerDay: 20, stoodUp: -10, variations: [{id: 'first', know: 'It is dawn.'}, {id: 'second', wants: 'A story.', places: {spot: 'other'}}, {id: 'third'}]},
  stages: [{id: 'meet', type: 'play', know: 'You are out with V.', meet: {where: 'here'}, do: [{p: 'place', at: 'spot'}], script: [{when: 'place:spot:arrived', say: 'H.1'}],
    choices: [{id: 'met', on: 'meet:met', next: 'fun'}, {id: 'stood', on: 'meet:stood-up', next: 'late'}]}],
  endings: {fun: {memory: 'Had fun.', bond: 12}, late: {memory: 'V did not come.'}}});
