import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, parseChauffeurOffer, SEATED_MODES} from './companion-actions.mjs';
import {actionMenu} from './text-actions.mjs';
import {screenWords, explicitRequest} from './text-action-words.mjs';

// Seated drive: V already sits in their own car (docs/COMPANION_CHAUFFEUR.md, "Seated drive").
const offer = extra => ({available: true, actor: {serial: 3, id: '44ULL', key: 'judy'},
  car: {id: '55ULL', record: 'Vehicle.fixture', name: 'Fixture car'}, passengerSeat: 'seat_front_right',
  waypoint: {id: '66', name: 'Custom waypoint', position: {x: 100, y: 200, z: 30}}, ...extra});

test('a seated offer carries one bounded mode; an on-foot offer carries none and stays byte for byte as before', () => {
  assert.deepEqual(SEATED_MODES, ['driver', 'passenger']);
  for (const mode of SEATED_MODES) assert.deepEqual(parseChauffeurOffer(offer({seated: mode})), offer({seated: mode}));
  assert.equal(parseChauffeurOffer(offer()).seated, undefined);
  for (const bad of ['pilot', '', null, 1, true, 'Driver']) assert.equal(parseChauffeurOffer(offer({seated: bad})), null, String(bad));
  assert.equal(parseChauffeurOffer({...offer({seated: 'driver'}), extra: 1}), null);
  const input = {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy', channel: 'private', name: 'Judy',
    bodyType: 'Woman', text: 'you drive', chauffeurOffer: offer({seated: 'driver'})};
  assert.equal(parseInput(JSON.stringify(input)).chauffeurOffer.seated, 'driver');
});

function broker() {
  const files = [];
  const actions = new CompanionActions({now: () => 10000, createToken: () => 'drive-' + '1'.repeat(20),
    publish: async packet => { files.push(packet); return true; }});
  return {actions, files};
}
const prepared = seated => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: 'judy', channel: 'private', name: 'Judy',
    bodyType: 'Woman', text: 'you drive', chauffeurOffer: offer(seated ? {seated} : {})}});

test('the host window and the delivered packet keep the seated mode; the model never chooses it', async () => {
  for (const mode of [undefined, 'driver', 'passenger']) {
    const {actions, files} = broker();
    const config = actions.admit(prepared(mode), {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true});
    assert.equal(config.seated, mode);
    assert.equal(config.drive, undefined);
    assert.ok(await actions.deliver({version: 1, token: config.token}));
    assert.equal(files.at(-1).action, 'drive-to-waypoint');
    assert.equal(files.at(-1).offer.seated, mode);
  }
  const window = new CompanionActionWindow({now: () => 10000});
  const base = {version: 1, token: 'drive-' + '1'.repeat(20), source: 'private-text', expiresAt: 20000, carName: 'Car', destinationName: 'Pin'};
  assert.equal(window.open({...base, seated: 'driver'}), true);
  assert.equal(window.open({...base, seated: 'taxi'}), false);
  assert.equal(window.open({...base, drive: false, seated: 'driver', driveUnavailable: 'busy'}), false);
});

test('the Convai context and the text-route row name what happens next for each seat, and V is never said to be moved', () => {
  const base = {version: 1, token: 'drive-' + '1'.repeat(20), source: 'private-text', expiresAt: 20000, carName: 'Porsche', destinationName: 'Pin'};
  const onFoot = CompanionActionWindow.contextText(base);
  assert.match(onFoot, /V is on foot beside their stopped/);
  assert.doesNotMatch(onFoot, /swap seats/);
  const driver = CompanionActionWindow.contextText({...base, seated: 'driver'});
  assert.match(driver, /sitting in the driver seat of their own stopped car/);
  assert.match(driver, /step out of the driver seat/);
  assert.match(driver, /"swap seats"/);
  assert.doesNotMatch(driver, /on foot beside/);
  const passenger = CompanionActionWindow.contextText({...base, seated: 'passenger'});
  assert.match(passenger, /sitting in a passenger seat/);
  assert.match(driver + passenger, /never claim success before confirmation/);
  const menu = actionMenu({...base, leave: undefined, seated: 'driver'});
  assert.deepEqual(menu.codes, ['DRIVE']);
  assert.match(menu.rows[0].tell, /step out of it so you can take the wheel/);
  assert.match(menu.rows[0].what, /swap seats/);
  assert.deepEqual(menu.message({code: 'DRIVE', argument: ''}), {version: 1, token: base.token});
  assert.match(actionMenu({...base, seated: 'passenger'}).rows[0].tell, /take the driver seat if you do not have it yet/);
  assert.doesNotMatch(actionMenu(base).rows[0].tell, /step out/);
});

test('seated phrasing passes the screen in every language the list covers', () => {
  const lines = {
    en: ['You drive.', 'Swap seats with me.', 'Take over, I am tired.', 'Your turn to drive.', 'Slide over and drive.', 'Switch places.'],
    de: ['Du fährst.', 'Lass uns die Plätze tauschen.', 'Übernimm das Steuer.'],
    fr: ['Tu conduis.', 'On échange les places.', 'Prends le volant.', 'À toi de conduire.'],
    es: ['Conduce tú.', 'Cambiemos de asiento.', 'Toma el volante.', 'Es tu turno.'],
    it: ['Guida tu.', 'Cambiamo posto.', 'Prendi tu il volante.', 'Tocca a te.'],
    pt: ['Tu dirige.', 'Trocamos de lugar.', 'Assume o volante.', 'É a tua vez.'],
    pl: ['Ty prowadź.', 'Zamieńmy się miejscami.', 'Przejmij kierownicę.', 'Twoja kolej.'],
    ru: ['Ты за рулём.', 'Поменяемся местами.', 'Возьми руль.', 'Твоя очередь.', 'Пересядь за руль.'],
    uk: ['Ти за кермом.', 'Поміняймося місцями.', 'Візьми кермо.', 'Твоя черга.'],
    tr: ['Sen sür.', 'Koltuk değiştirelim.', 'Direksiyonu devral.', 'Sıra sende.'],
    cs: ['Ty řiď.', 'Vyměníme si místa.', 'Přeber volant.', 'Přesedni si.'],
    hu: ['Te vezess.', 'Cseréljünk helyet.', 'Vedd át a kormányt.', 'Ülj át.'],
    ja: ['君が運転して。', '席を交代しよう。', '代わって。'],
    ko: ['네가 운전해.', '자리 바꾸자.', '교대하자.'],
    zh: ['你来开车。', '换座吧。', '你来开。', '换我开'],
  };
  const missed = [];
  for (const [code, rows] of Object.entries(lines)) for (const text of rows) {
    if (!screenWords(text, {codes: ['DRIVE']}).includes('DRIVE')) missed.push(`${code}: ${text}`);
  }
  assert.deepEqual(missed, []);
});

test('plain English seated requests count as a drive when the decision gives nothing; look-alikes do not', () => {
  for (const text of ['you drive', 'You drive.', 'Take over.', 'take over the wheel', 'Swap seats.', 'switch seats with me', 'Can you take over?',
    'Your turn to drive', 'drive', 'take the wheel', 'Judy, swap seats with me please', 'trade places']) {
    assert.equal(explicitRequest(text, {codes: ['DRIVE']}), 'DRIVE', text);
  }
  for (const text of ['They plan to take over the world.', 'If you drive I will pay', 'Why do you drive so slow?',
    'Do not take over', 'I used to swap seats with my sister', 'Take over the world with me', 'swap seats later', 'seats are comfy']) {
    assert.equal(explicitRequest(text, {codes: ['DRIVE']}), null, text);
  }
  assert.equal(explicitRequest('you drive', {codes: ['FIGHT']}), null, 'nothing offered, nothing guessed');
});
