/**
 * ゲームの純粋ロジック。
 * ここには副作用（タイマー・ソケット・Map操作）を一切置かない。
 * 人狼はここのバグが致命傷になるので、テストはこのファイルに集中させる。
 */

/** @typedef {'villager'|'seer'|'medium'|'knight'|'werewolf'|'madman'} Role */
/** @typedef {'alive'|'killedByWolf'|'executed'} Status */

export const ROLES = {
  villager: {
    key: 'villager',
    name: '市民',
    team: 'village',
    emoji: '🧑‍🌾',
    night: null,
    desc: '特別な能力はありません。議論と投票だけが武器です。人狼を見つけ出してください。',
  },
  seer: {
    key: 'seer',
    name: '占い師',
    team: 'village',
    emoji: '🔮',
    night: 'divine',
    desc: '毎晩1人を占い、その人が「人狼」か「人間」かを即座に知ることができます。',
  },
  medium: {
    key: 'medium',
    name: '霊媒師',
    team: 'village',
    emoji: '🕯️',
    night: null,
    desc: '前日に処刑された人が「人狼」だったかどうかが、夜になると自動で分かります。',
  },
  knight: {
    key: 'knight',
    name: '騎士',
    team: 'village',
    emoji: '🛡️',
    night: 'guard',
    desc: '毎晩、自分以外の1人を護衛します。護衛した人はその夜、人狼に襲撃されても死にません。',
  },
  werewolf: {
    key: 'werewolf',
    name: '人狼',
    team: 'wolf',
    emoji: '🐺',
    night: 'attack',
    desc: '毎晩1人を襲撃して殺害します。仲間の人狼が誰かを知っています。正体を隠し通してください。',
  },
  madman: {
    key: 'madman',
    name: '狂人',
    team: 'wolf',
    emoji: '🎭',
    night: null,
    desc: '能力はありません。占われても「人間」と出ます。人狼が誰かは分かりませんが、人狼陣営が勝てばあなたの勝ちです。',
  },
};

export const ROLE_ORDER = ['villager', 'seer', 'medium', 'knight', 'werewolf', 'madman'];

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 16;

/** 1人までしか置けない役職（複数占い師などの特殊ルールは今回は非対応） */
const UNIQUE_ROLES = ['seer', 'medium', 'knight'];

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                       */
/* ------------------------------------------------------------------ */

/** Fisher-Yates。rng を差し替えられるようにしてテストで固定する。 */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, rng = Math.random) {
  if (!arr.length) return null;
  return arr[Math.floor(rng() * arr.length)];
}

/* ------------------------------------------------------------------ */
/* 役職構成                                                             */
/* ------------------------------------------------------------------ */

/**
 * 役職構成が成立するか検証する。
 * @returns {string|null} エラーメッセージ。問題なければ null
 */
export function validateComposition(roleCounts, playerCount, options = {}) {
  const { villagerFloor = 0 } = options;
  if (playerCount < MIN_PLAYERS) return `プレイヤーが足りません（最低${MIN_PLAYERS}人）`;
  if (playerCount > MAX_PLAYERS) return `プレイヤーが多すぎます（最大${MAX_PLAYERS}人）`;

  let total = 0;
  for (const key of Object.keys(roleCounts)) {
    if (!ROLES[key]) return `不明な役職です: ${key}`;
    const n = roleCounts[key];
    if (!Number.isInteger(n) || n < 0) return '役職の人数が不正です';
    total += n;
  }
  if (total !== playerCount) {
    // 合計と参加人数は画面にも並べて出るので、ここでは「何をすればいいか」だけ言う
    const diff = total - playerCount;
    return diff > 0 ? `役職が${diff}人分多いです` : `役職が${-diff}人分足りません`;
  }

  const wolves = roleCounts.werewolf || 0;
  if (wolves < 1) return '人狼が1人もいません';
  if (wolves * 2 >= playerCount) return '人狼が多すぎます（開始時点で人狼陣営の勝利条件を満たしてしまいます）';

  for (const key of UNIQUE_ROLES) {
    if ((roleCounts[key] || 0) > 1) return `${ROLES[key].name}は1人までです`;
  }

  // CPUを市民固定で参加させる場合、その人数分の市民枠が要る
  if ((roleCounts.villager || 0) < villagerFloor) {
    return `CPUは市民として参加します。市民を${villagerFloor}人以上にしてください`;
  }
  return null;
}

/**
 * 役職をランダムに配布する。
 *
 * `fixed` に指定したプレイヤーは先に役職を確定させ、残りを人間同士でシャッフルする。
 * CPUを市民固定にして、意味のある役職（人狼・占い師など）を必ず人間へ回すために使う。
 *
 * @param {string[]} playerIds
 * @param {Record<Role, number>} roleCounts
 * @param {() => number} rng
 * @param {Record<string, Role>} fixed playerId -> 固定する役職
 * @returns {Record<string, Role>} playerId -> role
 */
export function assignRoles(playerIds, roleCounts, rng = Math.random, fixed = {}) {
  const pool = [];
  for (const key of ROLE_ORDER) {
    for (let i = 0; i < (roleCounts[key] || 0); i++) pool.push(key);
  }
  if (pool.length !== playerIds.length) {
    throw new Error('役職の合計人数がプレイヤー数と一致しません');
  }

  const out = {};
  for (const id of playerIds) {
    const role = fixed[id];
    if (!role) continue;
    const index = pool.indexOf(role);
    if (index === -1) throw new Error(`${ROLES[role]?.name || role}の枠が足りません`);
    pool.splice(index, 1);
    out[id] = role;
  }

  const rest = playerIds.filter((id) => !out[id]);
  const shuffled = shuffle(pool, rng);
  rest.forEach((id, i) => {
    out[id] = shuffled[i];
  });
  return out;
}

/** 人数に応じた推奨構成 */
export function suggestComposition(playerCount) {
  const table = {
    4: { villager: 2, seer: 1, werewolf: 1 },
    5: { villager: 2, seer: 1, werewolf: 1, madman: 1 },
    6: { villager: 2, seer: 1, knight: 1, werewolf: 1, madman: 1 },
    7: { villager: 2, seer: 1, medium: 1, knight: 1, werewolf: 2 },
    8: { villager: 3, seer: 1, medium: 1, knight: 1, werewolf: 2 },
    9: { villager: 3, seer: 1, medium: 1, knight: 1, werewolf: 2, madman: 1 },
    10: { villager: 4, seer: 1, medium: 1, knight: 1, werewolf: 2, madman: 1 },
    11: { villager: 4, seer: 1, medium: 1, knight: 1, werewolf: 3, madman: 1 },
    12: { villager: 5, seer: 1, medium: 1, knight: 1, werewolf: 3, madman: 1 },
    13: { villager: 6, seer: 1, medium: 1, knight: 1, werewolf: 3, madman: 1 },
    14: { villager: 6, seer: 1, medium: 1, knight: 1, werewolf: 4, madman: 1 },
    15: { villager: 7, seer: 1, medium: 1, knight: 1, werewolf: 4, madman: 1 },
    16: { villager: 8, seer: 1, medium: 1, knight: 1, werewolf: 4, madman: 1 },
  };
  const base = table[playerCount];
  if (base) return { ...emptyCounts(), ...base };
  // 表の外（4人未満など）は市民で埋める。
  // 合計は必ず playerCount ちょうどにする。ここがズレると、
  // ルームを作った直後（1人）にいきなり「合計 2 / 1人」と赤字が出てしまう。
  const counts = emptyCounts();
  if (playerCount <= 0) return counts;
  counts.werewolf = Math.max(1, Math.floor(playerCount / 4));
  counts.seer = playerCount - counts.werewolf >= 1 ? 1 : 0;
  counts.villager = playerCount - counts.werewolf - counts.seer;
  return counts;
}

export function emptyCounts() {
  const c = {};
  for (const key of ROLE_ORDER) c[key] = 0;
  return c;
}

/* ------------------------------------------------------------------ */
/* 占い・霊媒                                                           */
/* ------------------------------------------------------------------ */

/** 占い結果。狂人は「人間」と出る。 */
export function divineResult(targetRole) {
  return targetRole === 'werewolf' ? 'wolf' : 'human';
}

/**
 * 夜の開始時点で霊媒師に配る結果（前日の処刑者）。
 * @param {Array<{id:string, role:Role, status:Status}>} players
 * @param {string|null} lastExecutedId
 */
export function mediumResults(players, lastExecutedId, day) {
  if (!lastExecutedId) return [];
  const target = players.find((p) => p.id === lastExecutedId);
  if (!target) return [];
  return players
    .filter((p) => p.status === 'alive' && p.role === 'medium')
    .map((m) => ({
      type: 'medium',
      day,
      actorId: m.id,
      targetId: target.id,
      result: divineResult(target.role),
      visibleTo: [m.id],
    }));
}

/* ------------------------------------------------------------------ */
/* 夜の解決                                                             */
/* ------------------------------------------------------------------ */

/**
 * 人狼の襲撃先を決める。生存する人狼の投票の多数決、同数はランダム。
 * 誰も選ばなかった場合は生存する人狼以外からランダム。
 */
export function decideWolfTarget(wolfVotes, players, rng = Math.random) {
  const alive = players.filter((p) => p.status === 'alive');
  const aliveWolfIds = new Set(alive.filter((p) => p.role === 'werewolf').map((p) => p.id));
  const candidates = alive.filter((p) => p.role !== 'werewolf').map((p) => p.id);
  if (!aliveWolfIds.size || !candidates.length) return null;

  const counts = new Map();
  for (const [voterId, targetId] of Object.entries(wolfVotes || {})) {
    if (!aliveWolfIds.has(voterId)) continue;
    if (!candidates.includes(targetId)) continue;
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  if (!counts.size) return pickRandom(candidates, rng);

  const max = Math.max(...counts.values());
  const top = [...counts.entries()].filter(([, n]) => n === max).map(([id]) => id);
  return top.length === 1 ? top[0] : pickRandom(top, rng);
}

/**
 * 夜を解決する（襲撃と護衛のみ。占いは実行時点で即時解決、霊媒は夜の開始時点で配布済み）。
 *
 * @param {object} ctx
 * @param {number} ctx.day
 * @param {Array<{id:string,role:Role,status:Status}>} ctx.players
 * @param {{wolfVotes:Record<string,string>, knightTargets:Record<string,string>}} ctx.night
 * @param {boolean} ctx.firstNightAttack 初日の襲撃を行うか
 * @returns {{deaths:Array<{id:string,cause:Status}>, logs:object[], attackTargetId:string|null, guardedIds:string[], attackBlocked:boolean, attacked:boolean}}
 */
export function resolveNight(ctx, rng = Math.random) {
  const { day, players, night } = ctx;
  const byId = new Map(players.map((p) => [p.id, p]));
  const logs = [];
  const deaths = [];

  // --- 1. 護衛 ---
  const guardedIds = [];
  for (const [knightId, targetId] of Object.entries(night.knightTargets || {})) {
    const knight = byId.get(knightId);
    const target = byId.get(targetId);
    if (!knight || knight.status !== 'alive' || knight.role !== 'knight') continue;
    if (!target || target.status !== 'alive') continue;
    if (targetId === knightId) continue; // 自分自身は護衛できない
    guardedIds.push(targetId);
    logs.push({ type: 'guard', day, actorId: knightId, targetId, visibleTo: [knightId] });
  }

  // --- 2. 襲撃 ---
  const aliveWolves = players.filter((p) => p.status === 'alive' && p.role === 'werewolf');
  const skipAttack = day === 1 && !ctx.firstNightAttack;
  let attackTargetId = null;
  let attackBlocked = false;

  if (aliveWolves.length && !skipAttack) {
    attackTargetId = decideWolfTarget(night.wolfVotes, players, rng);
    if (attackTargetId) {
      if (guardedIds.includes(attackTargetId)) {
        attackBlocked = true;
      } else {
        deaths.push({ id: attackTargetId, cause: 'killedByWolf' });
      }
      logs.push({
        type: 'attack',
        day,
        actorId: null,
        targetId: attackTargetId,
        blocked: attackBlocked,
        visibleTo: aliveWolves.map((w) => w.id),
      });
    }
  }

  return {
    deaths,
    logs,
    attackTargetId,
    guardedIds,
    attackBlocked,
    attacked: attackTargetId !== null,
  };
}

/* ------------------------------------------------------------------ */
/* 投票                                                                */
/* ------------------------------------------------------------------ */

/**
 * 投票を集計する。同票の場合はランダムに1人を処刑する（確定仕様）。
 * 無投票（棄権）は集計に含めない。全員が棄権した場合は処刑なし。
 *
 * @param {Record<string,string>} votes voterId -> targetId
 * @param {string[]} aliveIds
 * @returns {{executedId:string|null, counts:Record<string,number>, tied:string[], reason:'majority'|'tieRandom'|'noVotes'}}
 */
export function tallyVotes(votes, aliveIds, rng = Math.random) {
  const aliveSet = new Set(aliveIds);
  const counts = {};
  for (const [voterId, targetId] of Object.entries(votes || {})) {
    if (!aliveSet.has(voterId) || !aliveSet.has(targetId)) continue;
    counts[targetId] = (counts[targetId] || 0) + 1;
  }

  const entries = Object.entries(counts);
  if (!entries.length) return { executedId: null, counts, tied: [], reason: 'noVotes' };

  const max = Math.max(...entries.map(([, n]) => n));
  const top = entries.filter(([, n]) => n === max).map(([id]) => id);
  if (top.length === 1) return { executedId: top[0], counts, tied: [], reason: 'majority' };
  return { executedId: pickRandom(top, rng), counts, tied: top, reason: 'tieRandom' };
}

/* ------------------------------------------------------------------ */
/* 勝敗判定                                                             */
/* ------------------------------------------------------------------ */

/**
 * 勝敗を判定する。決着がついていなければ null。
 * 狂人は人数としては「人間」側に数えるが、勝利陣営は人狼陣営。
 *
 * @param {Array<{role:Role,status:Status}>} players
 * @returns {{winner:'village'|'wolf', reason:string}|null}
 */
export function checkWin(players) {
  const alive = players.filter((p) => p.status === 'alive');
  const wolves = alive.filter((p) => p.role === 'werewolf').length;
  const humans = alive.length - wolves;

  if (wolves === 0) {
    return { winner: 'village', reason: '生存している人狼がいなくなりました' };
  }
  if (wolves >= humans) {
    return { winner: 'wolf', reason: '人狼の数が村人の数と同数以上になりました' };
  }
  return null;
}

/** その役職が勝利陣営に含まれるか */
export function isWinner(role, winner) {
  return ROLES[role].team === winner;
}
