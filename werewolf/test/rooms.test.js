import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../server/rooms.js';

R.setBroadcaster(() => {});

function setup(names = ['A', 'B', 'C', 'D', 'E', 'F']) {
  const { room, player: host } = R.createRoom(names[0]);
  for (const n of names.slice(1)) R.joinRoom(room.id, n);
  return { room, host };
}
const list = (room) => [...room.players.values()];
const alive = (room) => list(room).filter((p) => p.status === 'alive');

function toNight(room, host) {
  R.startGame(room, host.id);
  for (const p of list(room)) R.setReady(room, p.id);
}

/* ---------------- CPUプレイヤー ---------------- */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('CPUを追加すると頭数に加わり、ホストが減らせる', () => {
  const { room, host } = setup(['A', 'B', 'C']);
  R.addBot(room, host.id);
  R.addBot(room, host.id);
  assert.equal(room.players.size, 5);
  assert.equal(R.botCount(room), 2);
  R.removeBot(room, host.id);
  assert.equal(R.botCount(room), 1);
});

test('CPUは既定で市民に固定され、意味のある役職は人間に回る', () => {
  const { room, host } = setup(['A', 'B', 'C']);
  R.addBot(room, host.id);
  R.addBot(room, host.id);
  // 5人: 市民2 占い師1 人狼1 狂人1 → 市民2枠がCPUに埋まる
  R.startGame(room, host.id);
  const bots = list(room).filter((p) => p.isBot);
  const humans = list(room).filter((p) => !p.isBot);
  assert.ok(bots.every((b) => b.role === 'villager'), 'CPUが市民以外を引いています');
  assert.deepEqual(humans.map((h) => h.role).sort(), ['madman', 'seer', 'werewolf']);
});

test('CPUを市民固定にすると、市民枠が足りない構成は開始できない', () => {
  const { room, host } = setup(['A', 'B', 'C']);
  R.addBot(room, host.id);
  R.addBot(room, host.id);
  R.updateConfig(room, host.id, {
    roleCounts: { villager: 1, seer: 1, medium: 0, knight: 1, werewolf: 1, madman: 1 },
  });
  assert.throws(() => R.startGame(room, host.id), /市民を2人以上/);
});

test('CPUは自動で役職確認を済ませ、夜と投票を自分で進める', async () => {
  const { room, host } = setup(['A', 'B']);
  R.addBot(room, host.id);
  R.addBot(room, host.id);
  // 4人: 市民2 占い師1 人狼1 → CPU2体が市民
  R.startGame(room, host.id);
  assert.equal(room.phase, 'roleReveal');

  for (const p of list(room).filter((x) => !x.isBot)) R.setReady(room, p.id);
  await wait(1800); // CPUの確認待ち
  assert.equal(room.phase, 'night', 'CPUが役職確認を終えていません');

  // 人間側の夜の行動を済ませる
  for (const p of alive(room).filter((x) => !x.isBot)) {
    const kind = { seer: 'divine', knight: 'guard', werewolf: 'attack' }[p.role];
    if (!kind) continue;
    const pool = alive(room).filter((q) => q.id !== p.id && (kind !== 'attack' || q.role !== 'werewolf'));
    R.submitNightAction(room, p.id, kind, pool[0].id);
  }
  assert.notEqual(room.phase, 'night', '市民固定のCPUは夜に待たせる必要がない');

  R.skipPhase(room, room.hostId); // morning -> discussion
  R.skipPhase(room, room.hostId); // discussion -> vote
  assert.equal(room.phase, 'vote');
  await wait(9000); // CPUの投票待ち
  const botVotes = list(room).filter((p) => p.isBot && p.status === 'alive' && room.votes[p.id]);
  assert.ok(botVotes.length > 0, 'CPUが投票していません');
});

test('CPUだけではゲームを開始できない', () => {
  const { room, host } = setup(['A']);
  for (let i = 0; i < 4; i++) R.addBot(room, host.id);
  R.handleDisconnect(room, host); // 人間が抜ける（ロビーなので削除される）
  assert.equal(list(room).filter((p) => !p.isBot).length, 0);
  assert.equal(room.hostId && room.players.get(room.hostId)?.isBot, undefined);
});

test('CPUはホストになれない', () => {
  const { room, host } = setup(['A', 'B']);
  R.addBot(room, host.id);
  R.addBot(room, host.id);
  const human = list(room).find((p) => !p.isBot && p.id !== host.id);
  R.handleDisconnect(room, host);
  assert.equal(room.hostId, human.id);
  assert.equal(room.players.get(room.hostId).isBot, false);
});

/* ---------------- ロビー ---------------- */

test('参加人数に応じて推奨構成が自動で追従する', () => {
  const { room } = setup(['A', 'B', 'C', 'D']);
  const sum = Object.values(room.config.roleCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, 4);
  R.joinRoom(room.id, 'E');
  assert.equal(Object.values(room.config.roleCounts).reduce((a, b) => a + b, 0), 5);
});

test('ホストが手で構成を変えたら、以後は自動追従しない', () => {
  const { room, host } = setup(['A', 'B', 'C', 'D']);
  R.updateConfig(room, host.id, { roleCounts: { ...room.config.roleCounts, villager: 3 } });
  const before = JSON.stringify(room.config.roleCounts);
  R.joinRoom(room.id, 'E');
  assert.equal(JSON.stringify(room.config.roleCounts), before);
});

test('ホスト以外は設定変更もゲーム開始もできない', () => {
  const { room } = setup(['A', 'B', 'C', 'D']);
  const other = list(room)[1];
  assert.throws(() => R.updateConfig(room, other.id, { nightSeconds: 30 }), /ホスト/);
  assert.throws(() => R.startGame(room, other.id), /ホスト/);
});

test('タブをリロードしてもホスト権限を失わない', () => {
  const { room, host } = setup();
  toNight(room, host);
  R.handleDisconnect(room, host);
  assert.equal(room.hostId, host.id, '猶予時間の間はホストのまま');
  R.reconnect(room.id, host.id, host.token);
  assert.equal(room.hostId, host.id);
  assert.equal(room.hostGraceTimer, null, '再接続で移譲予約が取り消される');
});

test('ロビーでホストが抜けたら、その場で次の人に移譲される', () => {
  const { room, host } = setup(['A', 'B', 'C', 'D']);
  R.handleDisconnect(room, host);
  assert.equal(room.players.size, 3);
  assert.notEqual(room.hostId, host.id);
  assert.equal(list(room).filter((p) => p.isHost).length, 1);
});

test('暫定ホストになった人がいても、作成者が戻ればホストが返る', () => {
  const { room, host } = setup();
  toNight(room, host);
  const stand = list(room).find((p) => p.id !== host.id);
  // 猶予時間が切れた状態を再現する
  R.handleDisconnect(room, host);
  for (const p of list(room)) p.isHost = p.id === stand.id;
  room.hostId = stand.id;

  R.reconnect(room.id, host.id, host.token);
  assert.equal(room.hostId, host.id);
  assert.equal(list(room).filter((p) => p.isHost).length, 1);
});

test('不正なトークンでは再接続できない', () => {
  const { room, host } = setup();
  assert.throws(() => R.reconnect(room.id, host.id, 'wrong-token'), /再接続/);
});

test('切断中のプレイヤーがいても夜が即座に終わらない', () => {
  const { room, host } = setup();
  toNight(room, host);
  assert.equal(room.phase, 'night');
  const actors = alive(room).filter((p) => ['seer', 'knight', 'werewolf'].includes(p.role));
  const idle = actors[actors.length - 1];
  R.handleDisconnect(room, idle);
  for (const p of actors) {
    if (p.id === idle.id) continue;
    const kind = { seer: 'divine', knight: 'guard', werewolf: 'attack' }[p.role];
    const pool = alive(room).filter((q) => q.id !== p.id && (kind !== 'attack' || q.role !== 'werewolf'));
    R.submitNightAction(room, p.id, kind, pool[0].id);
  }
  assert.equal(room.phase, 'night', '切断者を待たずに夜が明けてしまっている');
});

test('占いは1晩に1回だけ、自分と死者は対象にできない', () => {
  const { room, host } = setup();
  toNight(room, host);
  const seer = alive(room).find((p) => p.role === 'seer');
  const target = alive(room).find((p) => p.id !== seer.id);
  assert.throws(() => R.submitNightAction(room, seer.id, 'divine', seer.id), /自分/);
  R.submitNightAction(room, seer.id, 'divine', target.id);
  assert.throws(() => R.submitNightAction(room, seer.id, 'divine', target.id), /すでに占って/);
});

test('人狼は仲間を襲撃できない', () => {
  const { room, host } = setup(['A', 'B', 'C', 'D', 'E', 'F', 'G']); // 7人で人狼2
  R.updateConfig(room, host.id, { roleCounts: { villager: 3, seer: 1, medium: 0, knight: 0, werewolf: 2, madman: 1 } });
  toNight(room, host);
  const wolves = alive(room).filter((p) => p.role === 'werewolf');
  assert.equal(wolves.length, 2);
  assert.throws(() => R.submitNightAction(room, wolves[0].id, 'attack', wolves[1].id), /仲間/);
});

test('市民は夜に何もできない', () => {
  const { room, host } = setup();
  toNight(room, host);
  const villager = alive(room).find((p) => p.role === 'villager');
  const other = alive(room).find((p) => p.id !== villager.id);
  assert.throws(() => R.submitNightAction(room, villager.id, 'divine', other.id), /占いはできません/);
  assert.throws(() => R.submitNightAction(room, villager.id, 'guard', other.id), /護衛はできません/);
  assert.throws(() => R.submitNightAction(room, villager.id, 'attack', other.id), /襲撃はできません/);
});

test('自分自身には投票できない', () => {
  const { room, host } = setup();
  toNight(room, host);
  R.skipPhase(room, room.hostId); // night -> morning
  R.skipPhase(room, room.hostId); // morning -> discussion
  R.skipPhase(room, room.hostId); // discussion -> vote
  assert.equal(room.phase, 'vote');
  const voter = alive(room)[0];
  assert.throws(() => R.castVote(room, voter.id, voter.id), /自分/);
});

test('再戦するとロビーに戻り、役職と生死がリセットされる', () => {
  const { room, host } = setup();
  toNight(room, host);
  // 強制的に終局させる
  for (const p of list(room)) if (p.role === 'werewolf') p.status = 'executed';
  R.skipPhase(room, room.hostId);
  assert.equal(room.phase, 'gameOver');
  R.restartGame(room, host.id);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.day, 0);
  assert.ok(list(room).every((p) => p.role === null && p.status === 'alive'));
});
