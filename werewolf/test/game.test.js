import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignRoles,
  validateComposition,
  suggestComposition,
  decideWolfTarget,
  resolveNight,
  tallyVotes,
  checkWin,
  divineResult,
  mediumResults,
} from '../server/game.js';

/** 常に先頭を選ぶ決定的な rng */
const rngFirst = () => 0;
/** 常に末尾を選ぶ決定的な rng */
const rngLast = () => 0.999999;

const P = (id, role, status = 'alive') => ({ id, role, status });

/* ---------------- 役職構成 ---------------- */

test('validateComposition: 合計人数が一致しないと、過不足を指摘して弾く', () => {
  assert.equal(validateComposition({ villager: 2, seer: 1, werewolf: 1 }, 5), '役職が1人分足りません');
  assert.equal(validateComposition({ villager: 4, seer: 1, werewolf: 1 }, 4), '役職が2人分多いです');
  assert.equal(validateComposition({ villager: 2, seer: 1, werewolf: 1 }, 4), null);
});

test('validateComposition: 人狼が0人、または多すぎる構成を弾く', () => {
  assert.match(validateComposition({ villager: 4 }, 4), /人狼が1人もいません/);
  assert.match(validateComposition({ villager: 2, werewolf: 2 }, 4), /人狼が多すぎます/);
});

test('validateComposition: 占い師・霊媒師・騎士は1人まで', () => {
  assert.match(validateComposition({ seer: 2, villager: 2, werewolf: 1 }, 5), /占い師は1人までです/);
});

test('suggestComposition: 何人でも合計は必ずその人数ちょうどになる', () => {
  // ここがズレると、ルーム作成直後（1人）に「合計 2 / 1人」と赤字が出てしまう
  for (let n = 1; n <= 20; n++) {
    const counts = suggestComposition(n);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, n, `${n}人の推奨構成の合計が${total}人になっています`);
  }
  assert.equal(Object.values(suggestComposition(0)).reduce((a, b) => a + b, 0), 0);
});

test('suggestComposition: 4〜16人すべてで成立する構成を返す', () => {
  for (let n = 4; n <= 16; n++) {
    const counts = suggestComposition(n);
    assert.equal(validateComposition(counts, n), null, `${n}人の推奨構成が不正: ${JSON.stringify(counts)}`);
  }
});

test('assignRoles: 固定役職を指定すると、残りだけが人間に配られる', () => {
  const ids = ['human1', 'human2', 'bot1', 'bot2'];
  const counts = { villager: 2, seer: 1, werewolf: 1 };
  const fixed = { bot1: 'villager', bot2: 'villager' };
  for (let i = 0; i < 30; i++) {
    const assigned = assignRoles(ids, counts, Math.random, fixed);
    assert.equal(assigned.bot1, 'villager');
    assert.equal(assigned.bot2, 'villager');
    // 意味のある役職は必ず人間に回る
    assert.deepEqual([assigned.human1, assigned.human2].sort(), ['seer', 'werewolf']);
  }
});

test('assignRoles: 固定役職の枠が足りなければ例外', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const counts = { villager: 1, seer: 1, medium: 1, werewolf: 1 };
  assert.throws(
    () => assignRoles(ids, counts, Math.random, { a: 'villager', b: 'villager' }),
    /市民の枠が足りません/,
  );
});

test('validateComposition: CPU固定分の市民枠が足りないと弾く', () => {
  const counts = { villager: 1, seer: 1, knight: 1, werewolf: 1, madman: 1 };
  assert.equal(validateComposition(counts, 5), null);
  assert.match(validateComposition(counts, 5, { villagerFloor: 2 }), /市民を2人以上/);
  assert.equal(validateComposition({ villager: 2, seer: 1, werewolf: 1, madman: 1 }, 5, { villagerFloor: 2 }), null);
});

test('assignRoles: 全員にちょうど1つずつ配られ、構成通りになる', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const counts = { villager: 2, seer: 1, werewolf: 1, madman: 1 };
  const assigned = assignRoles(ids, counts);
  assert.deepEqual(Object.keys(assigned).sort(), ids);
  const tally = {};
  for (const role of Object.values(assigned)) tally[role] = (tally[role] || 0) + 1;
  assert.deepEqual(tally, counts);
});

/* ---------------- 占い・霊媒 ---------------- */

test('divineResult: 狂人は「人間」と出る', () => {
  assert.equal(divineResult('madman'), 'human');
  assert.equal(divineResult('werewolf'), 'wolf');
  assert.equal(divineResult('seer'), 'human');
});

test('mediumResults: 前日の処刑者がいない初日は何も出ない', () => {
  const players = [P('m', 'medium'), P('w', 'werewolf')];
  assert.deepEqual(mediumResults(players, null, 1), []);
});

test('mediumResults: 生存する霊媒師にだけ、処刑者の正体が届く', () => {
  const players = [P('m', 'medium'), P('m2', 'medium', 'executed'), P('w', 'werewolf', 'executed')];
  const logs = mediumResults(players, 'w', 3);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actorId, 'm');
  assert.equal(logs[0].result, 'wolf');
  assert.deepEqual(logs[0].visibleTo, ['m']);
});

/* ---------------- 襲撃先の決定 ---------------- */

test('decideWolfTarget: 人狼の多数決で決まる', () => {
  const players = [P('w1', 'werewolf'), P('w2', 'werewolf'), P('v1', 'villager'), P('v2', 'villager')];
  const target = decideWolfTarget({ w1: 'v1', w2: 'v1' }, players);
  assert.equal(target, 'v1');
});

test('decideWolfTarget: 同数はランダム、無投票でも必ず誰かに決まる', () => {
  const players = [P('w1', 'werewolf'), P('w2', 'werewolf'), P('v1', 'villager'), P('v2', 'villager')];
  assert.ok(['v1', 'v2'].includes(decideWolfTarget({ w1: 'v1', w2: 'v2' }, players, rngFirst)));
  assert.ok(['v1', 'v2'].includes(decideWolfTarget({}, players, rngLast)));
});

test('decideWolfTarget: 死亡した人狼の票と、人狼への投票は無視される', () => {
  const players = [
    P('w1', 'werewolf'),
    P('w2', 'werewolf', 'executed'),
    P('v1', 'villager'),
    P('v2', 'villager'),
  ];
  const target = decideWolfTarget({ w1: 'v2', w2: 'v1' }, players);
  assert.equal(target, 'v2');
});

/* ---------------- 夜の解決 ---------------- */

const nightCtx = (players, night, day = 2, firstNightAttack = true) => ({
  day,
  players,
  night: { wolfVotes: {}, knightTargets: {}, ...night },
  firstNightAttack,
});

test('resolveNight: 護衛されていない対象は死亡する', () => {
  const players = [P('w', 'werewolf'), P('k', 'knight'), P('v', 'villager'), P('s', 'seer')];
  const out = resolveNight(nightCtx(players, { wolfVotes: { w: 'v' }, knightTargets: { k: 's' } }));
  assert.deepEqual(out.deaths, [{ id: 'v', cause: 'killedByWolf' }]);
  assert.equal(out.attackBlocked, false);
});

test('resolveNight: 騎士の護衛が成功すると犠牲者が出ない', () => {
  const players = [P('w', 'werewolf'), P('k', 'knight'), P('v', 'villager'), P('s', 'seer')];
  const out = resolveNight(nightCtx(players, { wolfVotes: { w: 'v' }, knightTargets: { k: 'v' } }));
  assert.deepEqual(out.deaths, []);
  assert.equal(out.attackBlocked, true);
  assert.equal(out.attacked, true);
});

test('resolveNight: 騎士は自分自身を護衛できない', () => {
  const players = [P('w', 'werewolf'), P('k', 'knight'), P('v', 'villager'), P('s', 'seer')];
  const out = resolveNight(nightCtx(players, { wolfVotes: { w: 'k' }, knightTargets: { k: 'k' } }));
  assert.deepEqual(out.deaths, [{ id: 'k', cause: 'killedByWolf' }]);
  assert.deepEqual(out.guardedIds, []);
});

test('resolveNight: 初日襲撃オフなら1日目は誰も死なない', () => {
  const players = [P('w', 'werewolf'), P('k', 'knight'), P('v', 'villager'), P('s', 'seer')];
  const out = resolveNight(nightCtx(players, { wolfVotes: { w: 'v' } }, 1, false));
  assert.deepEqual(out.deaths, []);
  assert.equal(out.attacked, false);
});

test('resolveNight: 襲撃ログは人狼にしか見えない', () => {
  const players = [P('w', 'werewolf'), P('k', 'knight'), P('v', 'villager'), P('s', 'seer')];
  const out = resolveNight(nightCtx(players, { wolfVotes: { w: 'v' }, knightTargets: { k: 's' } }));
  const attack = out.logs.find((l) => l.type === 'attack');
  const guard = out.logs.find((l) => l.type === 'guard');
  assert.deepEqual(attack.visibleTo, ['w']);
  assert.deepEqual(guard.visibleTo, ['k']);
  assert.ok(out.logs.every((l) => l.visibleTo !== 'all'));
});

/* ---------------- 投票 ---------------- */

test('tallyVotes: 最多票が処刑される', () => {
  const result = tallyVotes({ a: 'c', b: 'c', c: 'a' }, ['a', 'b', 'c']);
  assert.equal(result.executedId, 'c');
  assert.equal(result.reason, 'majority');
});

test('tallyVotes: 同票はランダムで1人が処刑される', () => {
  const result = tallyVotes({ a: 'b', b: 'a' }, ['a', 'b', 'c'], rngFirst);
  assert.equal(result.reason, 'tieRandom');
  assert.deepEqual(result.tied.sort(), ['a', 'b']);
  assert.ok(['a', 'b'].includes(result.executedId));
});

test('tallyVotes: 死亡者の票と死亡者への票は無効', () => {
  const result = tallyVotes({ a: 'dead', b: 'c', dead: 'b' }, ['a', 'b', 'c']);
  assert.deepEqual(result.counts, { c: 1 });
  assert.equal(result.executedId, 'c');
});

test('tallyVotes: 全員棄権なら処刑なし', () => {
  const result = tallyVotes({}, ['a', 'b', 'c']);
  assert.equal(result.executedId, null);
  assert.equal(result.reason, 'noVotes');
});

/* ---------------- 勝敗判定 ---------------- */

test('checkWin: 人狼が全滅すると村人陣営の勝ち', () => {
  const players = [P('w', 'werewolf', 'executed'), P('v', 'villager'), P('s', 'seer')];
  assert.equal(checkWin(players).winner, 'village');
});

test('checkWin: 人狼と人間が同数になると人狼陣営の勝ち', () => {
  const players = [P('w', 'werewolf'), P('v', 'villager'), P('s', 'seer', 'killedByWolf')];
  assert.equal(checkWin(players).winner, 'wolf');
});

test('checkWin: 狂人は人間としてカウントされる（村の延命になる）', () => {
  // 人狼1 / 市民1 / 狂人1 → 人間2 > 人狼1 なのでまだ決着しない
  const players = [P('w', 'werewolf'), P('v', 'villager'), P('m', 'madman')];
  assert.equal(checkWin(players), null);

  // 狂人を除くと人狼1 = 人間1 で人狼の勝ち
  const players2 = [P('w', 'werewolf'), P('v', 'villager'), P('m', 'madman', 'executed')];
  assert.equal(checkWin(players2).winner, 'wolf');
});

test('checkWin: 決着していなければ null', () => {
  const players = [P('w', 'werewolf'), P('v1', 'villager'), P('v2', 'villager'), P('s', 'seer')];
  assert.equal(checkWin(players), null);
});
