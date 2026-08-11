/**
 * ルームの状態管理とフェーズ遷移。
 *
 * 設計上の絶対規則:
 *   Room オブジェクトを丸ごとクライアントに送らない。
 *   必ず viewFor(room, playerId) を通し、「そのプレイヤーが知ってよい情報」だけを組み立てる。
 */

import { randomUUID, randomBytes } from 'node:crypto';
import {
  ROLES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  assignRoles,
  validateComposition,
  suggestComposition,
  emptyCounts,
  divineResult,
  mediumResults,
  resolveNight,
  tallyVotes,
  checkWin,
} from './game.js';

/** @type {Map<string, object>} */
const rooms = new Map();

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2時間放置で破棄
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300; // 公開時にメモリを食い潰されないための上限
const ANNOUNCE_SECONDS = 8; // 朝／処刑結果の演出時間
const ROLE_REVEAL_LIMIT = 180; // 役職確認の安全タイムアウト
const HOST_GRACE_MS = 20 * 1000; // ホストが落ちてから権限を移すまでの猶予（リロード対策）

const DEFAULT_CONFIG = {
  nightSeconds: 90,
  discussionSeconds: 300,
  voteSeconds: 60,
  firstNightAttack: true,
  // CPUは喋れないので、既定では役職抽選から外して「頭数」に徹させる。
  // ここをOFFにするとCPUが人狼や占い師を引くが、まともなゲームにはならない。
  botsAreVillagersOnly: true,
  botsVote: true,
};

/** CPUの表示名。人間と紛れないよう、画面には常に CPU タグを併記する */
const BOT_NAMES = ['サクラ', 'カエデ', 'ツバキ', 'スミレ', 'ナズナ', 'ヒイラギ', 'フジ', 'キリ'];

let broadcast = () => {};

/** index.js から1度だけ設定する。room の状態が変わるたびに呼ばれる。 */
export function setBroadcaster(fn) {
  broadcast = fn;
}

/* ------------------------------------------------------------------ */
/* 生成・参加                                                           */
/* ------------------------------------------------------------------ */

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  let id;
  do {
    id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function makePlayer(name, seat, isHost, isBot = false) {
  return {
    id: randomUUID(),
    token: isBot ? null : randomBytes(16).toString('hex'), // 再接続用。本人以外には絶対に出さない
    name,
    seat,
    isHost,
    isBot,
    role: null,
    status: 'alive',
    ready: false,
    connected: true, // CPUは常に接続扱い
    socketId: null,
  };
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().slice(0, 12);
  return trimmed || '名無し';
}

export function createRoom(hostName) {
  if (rooms.size >= MAX_ROOMS) {
    throw new UserError('サーバーが混み合っています。しばらくしてから作り直してください');
  }
  const room = {
    id: makeRoomId(),
    hostId: null,
    phase: 'lobby',
    day: 0,
    players: new Map(),
    config: { ...DEFAULT_CONFIG, roleCounts: emptyCounts() },
    phaseEndsAt: null,
    timer: null,
    night: { wolfVotes: {}, seerTargets: {}, knightTargets: {} },
    votes: {},
    logs: [],
    announcements: [],
    lastExecutedId: null,
    initialCount: 0,
    result: null,
    updatedAt: Date.now(),
  };
  const host = makePlayer(sanitizeName(hostName), 0, true);
  room.hostId = host.id;
  room.ownerId = host.id; // ルームを作った人。再接続したらホストが戻る
  room.players.set(host.id, host);
  room.config.roleCounts = suggestComposition(1);
  rooms.set(room.id, room);
  return { room, player: host };
}

export function getRoom(roomId) {
  // 長大な文字列を投げつけられても無駄な処理をしないよう先に切り詰める
  return rooms.get(String(roomId || '').slice(0, 12).toUpperCase());
}

export function joinRoom(roomId, name) {
  const room = getRoom(roomId);
  if (!room) throw new UserError('ルームが見つかりません');
  if (room.phase !== 'lobby') throw new UserError('このルームはすでにゲームが始まっています');
  if (room.players.size >= MAX_PLAYERS) throw new UserError(`満員です（最大${MAX_PLAYERS}人）`);

  const seat = Math.max(-1, ...[...room.players.values()].map((p) => p.seat)) + 1;
  const player = makePlayer(sanitizeName(name), seat, false);
  room.players.set(player.id, player);
  // 参加者が増えたら推奨構成に追従する（ホストが手で触っていたら上書きしない）
  if (!room.compositionTouched) {
    room.config.roleCounts = suggestComposition(room.players.size);
  }
  touch(room);
  return { room, player };
}

/* ------------------------------------------------------------------ */
/* CPUプレイヤー                                                        */
/* ------------------------------------------------------------------ */

export function addBot(room, playerId) {
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw new UserError('ゲーム中はCPUを追加できません');
  if (room.players.size >= MAX_PLAYERS) throw new UserError(`満員です（最大${MAX_PLAYERS}人）`);

  const used = new Set([...room.players.values()].map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || `CPU${room.players.size + 1}`;
  const seat = Math.max(-1, ...[...room.players.values()].map((p) => p.seat)) + 1;
  const bot = makePlayer(name, seat, false, true);
  room.players.set(bot.id, bot);
  if (!room.compositionTouched) room.config.roleCounts = suggestComposition(room.players.size);
  touch(room);
  return bot;
}

export function removeBot(room, playerId, botId) {
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw new UserError('ゲーム中はCPUを外せません');
  const bots = [...room.players.values()].filter((p) => p.isBot).sort((a, b) => a.seat - b.seat);
  const target = botId ? room.players.get(botId) : bots[bots.length - 1];
  if (!target || !target.isBot) throw new UserError('外せるCPUがいません');
  room.players.delete(target.id);
  if (!room.compositionTouched) room.config.roleCounts = suggestComposition(room.players.size);
  touch(room);
}

export function botCount(room) {
  return [...room.players.values()].filter((p) => p.isBot).length;
}

/** CPUを市民固定にする場合の、確定役職テーブル */
function fixedBotRoles(room) {
  if (!room.config.botsAreVillagersOnly) return {};
  const fixed = {};
  for (const p of room.players.values()) if (p.isBot) fixed[p.id] = 'villager';
  return fixed;
}

function compositionOptions(room) {
  return { villagerFloor: room.config.botsAreVillagersOnly ? botCount(room) : 0 };
}

/* ------------------------------------------------------------------ */

export function reconnect(roomId, playerId, token) {
  const room = getRoom(roomId);
  if (!room) throw new UserError('ルームが見つかりません');
  const player = room.players.get(playerId);
  if (!player || player.isBot || !token || player.token !== token) {
    throw new UserError('再接続できませんでした');
  }
  player.connected = true;
  if (room.hostGraceTimer && room.hostId === player.id) {
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
  }
  // タブのリロードや一時的な通信断でホストを失わないよう、作成者が戻ってきたら返す
  if (room.ownerId === player.id && room.hostId !== player.id) {
    for (const p of room.players.values()) p.isHost = p.id === player.id;
    room.hostId = player.id;
  }
  touch(room);
  return { room, player };
}

export function attachSocket(room, player, socketId) {
  player.socketId = socketId;
  player.connected = true;
  touch(room);
}

export function handleDisconnect(room, player) {
  if (!room || !player) return;
  player.connected = false;
  player.socketId = null;

  if (room.phase === 'lobby') {
    // ロビー中の離脱は完全に抜ける扱い
    room.players.delete(player.id);
    if (!room.players.size) {
      destroyRoom(room);
      return;
    }
    if (room.hostId === player.id) transferHost(room);
    if (!room.compositionTouched) room.config.roleCounts = suggestComposition(room.players.size);
  } else if (room.hostId === player.id) {
    // すぐに移譲するとリロードのたびにホストが入れ替わるので、少し待つ
    scheduleHostTransfer(room);
  }
  touch(room);
}

function scheduleHostTransfer(room) {
  if (room.hostGraceTimer) return;
  room.hostGraceTimer = setTimeout(() => {
    room.hostGraceTimer = null;
    const host = room.players.get(room.hostId);
    if (host && !host.connected) { transferHost(room); touch(room); }
  }, HOST_GRACE_MS);
  room.hostGraceTimer.unref?.();
}

function transferHost(room) {
  // CPUはホストになれない（誰も進行できなくなる）
  const candidates = [...room.players.values()].filter((p) => !p.isBot).sort((a, b) => a.seat - b.seat);
  const next =
    candidates.find((p) => p.connected && p.status === 'alive') ||
    candidates.find((p) => p.connected) ||
    candidates[0];
  if (!next) return;
  for (const p of room.players.values()) p.isHost = p.id === next.id;
  room.hostId = next.id;
  // 作成者がルームから完全にいなくなった場合だけ、オーナー権も引き継ぐ
  if (!room.players.has(room.ownerId)) room.ownerId = next.id;
  announce(room, `${next.name} さんが新しいホストになりました`, 'system');
}

export function leaveRoom(room, player) {
  handleDisconnect(room, player);
}

function destroyRoom(room) {
  clearTimer(room);
  clearBotTimers(room);
  if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
  rooms.delete(room.id);
}

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */

export function updateConfig(room, playerId, patch) {
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw new UserError('ゲーム中は設定を変更できません');

  if (patch.roleCounts) {
    const counts = emptyCounts();
    for (const key of Object.keys(counts)) {
      const n = Number(patch.roleCounts[key]);
      counts[key] = Number.isFinite(n) ? Math.max(0, Math.min(MAX_PLAYERS, Math.floor(n))) : 0;
    }
    room.config.roleCounts = counts;
    room.compositionTouched = true;
  }
  const nums = {
    nightSeconds: [20, 300],
    discussionSeconds: [30, 900],
    voteSeconds: [15, 300],
  };
  for (const [key, [lo, hi]] of Object.entries(nums)) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (Number.isFinite(n)) room.config[key] = Math.max(lo, Math.min(hi, Math.round(n)));
  }
  for (const key of ['firstNightAttack', 'botsAreVillagersOnly', 'botsVote']) {
    if (patch[key] !== undefined) room.config[key] = !!patch[key];
  }
  touch(room);
}

/** 現在の人数に合わせた推奨構成を適用する */
export function applySuggested(room, playerId) {
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw new UserError('ゲーム中は設定を変更できません');
  room.config.roleCounts = suggestComposition(room.players.size);
  room.compositionTouched = false;
  touch(room);
}

/* ------------------------------------------------------------------ */
/* フェーズ遷移                                                         */
/* ------------------------------------------------------------------ */

export function startGame(room, playerId) {
  requireHost(room, playerId);
  if (room.phase !== 'lobby') throw new UserError('すでにゲームが始まっています');

  const players = [...room.players.values()].sort((a, b) => a.seat - b.seat);
  const error = validateComposition(room.config.roleCounts, players.length, compositionOptions(room));
  if (error) throw new UserError(error);
  if (!players.some((p) => !p.isBot)) throw new UserError('人間のプレイヤーがいません');

  const roles = assignRoles(
    players.map((p) => p.id),
    room.config.roleCounts,
    Math.random,
    fixedBotRoles(room),
  );
  for (const p of players) {
    p.role = roles[p.id];
    p.status = 'alive';
    p.ready = false;
  }

  room.day = 1;
  room.logs = [];
  room.announcements = [];
  room.lastExecutedId = null;
  room.result = null;
  room.initialCount = players.length;

  setPhase(room, 'roleReveal', ROLE_REVEAL_LIMIT);
  announce(room, 'ゲームを開始します。自分の役職を確認してください。', 'system');
  touch(room);
}

export function setReady(room, playerId) {
  if (room.phase !== 'roleReveal') return;
  const player = room.players.get(playerId);
  if (!player) return;
  player.ready = true;
  touch(room);
  const everyone = [...room.players.values()].every((p) => p.ready || !p.connected);
  if (everyone) beginNight(room);
}

function beginNight(room) {
  room.night = { wolfVotes: {}, seerTargets: {}, knightTargets: {} };
  room.votes = {};
  setPhase(room, 'night', room.config.nightSeconds);
  announce(room, `${room.day}日目の夜になりました。`, 'night');

  // 霊媒師には夜の開始時点で前日の処刑者の結果が届く
  const snapshot = playerSnapshot(room);
  for (const log of mediumResults(snapshot, room.lastExecutedId, room.day)) {
    pushLog(room, log);
  }
  touch(room);
  maybeFinishNight(room);
}

export function submitNightAction(room, playerId, kind, targetId) {
  if (room.phase !== 'night') throw new UserError('今は夜ではありません');
  const actor = room.players.get(playerId);
  if (!actor || actor.status !== 'alive') throw new UserError('あなたは行動できません');
  const target = room.players.get(targetId);
  if (!target || target.status !== 'alive') throw new UserError('その相手は選べません');

  if (kind === 'divine') {
    if (actor.role !== 'seer') throw new UserError('占いはできません');
    if (room.night.seerTargets[actor.id]) throw new UserError('今夜はすでに占っています');
    if (target.id === actor.id) throw new UserError('自分は占えません');
    room.night.seerTargets[actor.id] = target.id;
    // 3-3「即座に結果を表示する」— 夜明けを待たずにこの場で解決する
    pushLog(room, {
      type: 'divine',
      day: room.day,
      actorId: actor.id,
      targetId: target.id,
      result: divineResult(target.role),
      visibleTo: [actor.id],
    });
  } else if (kind === 'guard') {
    if (actor.role !== 'knight') throw new UserError('護衛はできません');
    if (target.id === actor.id) throw new UserError('自分は護衛できません');
    room.night.knightTargets[actor.id] = target.id;
  } else if (kind === 'attack') {
    if (actor.role !== 'werewolf') throw new UserError('襲撃はできません');
    if (target.role === 'werewolf') throw new UserError('仲間の人狼は襲撃できません');
    room.night.wolfVotes[actor.id] = target.id;
  } else {
    throw new UserError('不明な行動です');
  }

  touch(room);
  maybeFinishNight(room);
}

/** 夜に行動が必要な生存プレイヤー */
function nightActors(room) {
  return [...room.players.values()].filter((p) => p.status === 'alive' && ROLES[p.role]?.night);
}

function hasActed(room, player) {
  const kind = ROLES[player.role]?.night;
  if (kind === 'divine') return !!room.night.seerTargets[player.id];
  if (kind === 'guard') return !!room.night.knightTargets[player.id];
  if (kind === 'attack') return !!room.night.wolfVotes[player.id];
  return true;
}

function maybeFinishNight(room) {
  if (room.phase !== 'night') return;
  // 一時的に切断しているだけの人を「行動済み」扱いにすると、
  // 通信が切れた瞬間に夜が終わってしまう。切断者は制限時間で救う。
  const pending = nightActors(room).filter((p) => !hasActed(room, p));
  if (pending.length === 0) finishNight(room);
}

function finishNight(room) {
  clearTimer(room);
  const snapshot = playerSnapshot(room);
  const outcome = resolveNight(
    { day: room.day, players: snapshot, night: room.night, firstNightAttack: room.config.firstNightAttack },
    Math.random,
  );

  for (const log of outcome.logs) pushLog(room, log);
  for (const death of outcome.deaths) {
    const victim = room.players.get(death.id);
    if (victim) victim.status = death.cause;
  }

  room.day += 1;
  setPhase(room, 'morning', ANNOUNCE_SECONDS);

  if (outcome.deaths.length) {
    const names = outcome.deaths.map((d) => room.players.get(d.id)?.name).filter(Boolean);
    announce(room, `朝になりました。${names.join('、')} さんが無惨な姿で発見されました。`, 'death');
  } else if (outcome.attackBlocked) {
    announce(room, '朝になりました。犠牲者は出ませんでした。', 'safe');
  } else {
    announce(room, '朝になりました。犠牲者は出ませんでした。', 'safe');
  }

  touch(room);
  if (finishIfDecided(room)) return;
  scheduleTimer(room, ANNOUNCE_SECONDS, () => beginDiscussion(room));
}

function beginDiscussion(room) {
  const alive = aliveCount(room);
  // 生存人数に応じて短くなる（初期人数を基準に按分、下限90秒）
  const scaled = Math.round((room.config.discussionSeconds * alive) / Math.max(1, room.initialCount));
  const seconds = Math.max(90, Math.min(room.config.discussionSeconds, scaled));
  setPhase(room, 'discussion', seconds);
  announce(room, `${room.day}日目の議論を始めてください。残り${formatDuration(seconds)}。`, 'day');
  touch(room);
  scheduleTimer(room, seconds, () => beginVote(room));
}

function beginVote(room) {
  room.votes = {};
  setPhase(room, 'vote', room.config.voteSeconds);
  announce(room, '投票の時間です。処刑したい人を1人選んでください。', 'vote');
  touch(room);
}

export function castVote(room, playerId, targetId) {
  if (room.phase !== 'vote') throw new UserError('今は投票時間ではありません');
  const voter = room.players.get(playerId);
  if (!voter || voter.status !== 'alive') throw new UserError('あなたは投票できません');
  const target = room.players.get(targetId);
  if (!target || target.status !== 'alive') throw new UserError('その相手には投票できません');
  if (target.id === voter.id) throw new UserError('自分には投票できません');

  room.votes[voter.id] = target.id;
  touch(room);

  // 棄権設定のCPUは永久に投票しないので、待ち人数から外す
  const pending = [...room.players.values()].filter(
    (p) => p.status === 'alive' && !room.votes[p.id] && !(p.isBot && !room.config.botsVote),
  );
  if (!pending.length) finishVote(room);
}

function finishVote(room) {
  clearTimer(room);
  const aliveIds = [...room.players.values()].filter((p) => p.status === 'alive').map((p) => p.id);
  const tally = tallyVotes(room.votes, aliveIds, Math.random);

  room.voteResult = {
    counts: tally.counts,
    tied: tally.tied,
    reason: tally.reason,
    ballots: { ...room.votes },
    executedId: tally.executedId,
  };
  pushLog(room, {
    type: 'execute',
    day: room.day,
    actorId: null,
    targetId: tally.executedId,
    reason: tally.reason,
    visibleTo: 'all',
  });

  if (tally.executedId) {
    const victim = room.players.get(tally.executedId);
    victim.status = 'executed';
    room.lastExecutedId = victim.id;
    const suffix =
      tally.reason === 'tieRandom'
        ? `（同票のため${tally.tied.length}人の中からランダムに決定されました）`
        : '';
    announce(room, `投票の結果、${victim.name} さんが処刑されました。${suffix}`, 'death');
  } else {
    room.lastExecutedId = null;
    announce(room, '有効な投票がなかったため、今日は誰も処刑されませんでした。', 'safe');
  }

  setPhase(room, 'execution', ANNOUNCE_SECONDS);
  touch(room);
  if (finishIfDecided(room)) return;
  scheduleTimer(room, ANNOUNCE_SECONDS, () => beginNight(room));
}

/** 勝敗がついていれば終了処理をして true */
function finishIfDecided(room) {
  const result = checkWin(playerSnapshot(room));
  if (!result) return false;
  clearTimer(room);
  room.result = {
    winner: result.winner,
    reason: result.reason,
    winners: [...room.players.values()]
      .filter((p) => ROLES[p.role].team === result.winner)
      .map((p) => p.id),
  };
  room.phase = 'gameOver';
  room.phaseEndsAt = null;
  // 終了時に全ログを公開してリプレイできるようにする
  for (const log of room.logs) log.visibleTo = 'all';
  announce(
    room,
    result.winner === 'village' ? `村人陣営の勝利！ ${result.reason}` : `人狼陣営の勝利！ ${result.reason}`,
    'result',
  );
  touch(room);
  return true;
}

/** ホストによるフェーズ強制スキップ */
export function skipPhase(room, playerId) {
  requireHost(room, playerId);
  switch (room.phase) {
    case 'roleReveal':
      beginNight(room);
      break;
    case 'night':
      finishNight(room);
      break;
    case 'morning':
      clearTimer(room);
      beginDiscussion(room);
      break;
    case 'discussion':
      clearTimer(room);
      beginVote(room);
      break;
    case 'vote':
      finishVote(room);
      break;
    case 'execution':
      clearTimer(room);
      beginNight(room);
      break;
    default:
      throw new UserError('今はスキップできません');
  }
}

/** 終了後、同じメンバーでロビーに戻る */
export function restartGame(room, playerId) {
  requireHost(room, playerId);
  if (room.phase !== 'gameOver') throw new UserError('ゲーム中は再戦できません');
  clearTimer(room);
  room.phase = 'lobby';
  room.day = 0;
  room.phaseEndsAt = null;
  room.logs = [];
  room.announcements = [];
  room.votes = {};
  room.voteResult = null;
  room.lastExecutedId = null;
  room.result = null;
  room.night = { wolfVotes: {}, seerTargets: {}, knightTargets: {} };
  for (const p of room.players.values()) {
    p.role = null;
    p.status = 'alive';
    p.ready = false;
  }
  // 切断済みの人はロビーに戻る時点で整理する
  for (const p of [...room.players.values()]) {
    if (!p.connected) room.players.delete(p.id);
  }
  if (!room.players.has(room.hostId)) transferHost(room);
  if (!room.compositionTouched) room.config.roleCounts = suggestComposition(room.players.size);
  touch(room);
}

/* ------------------------------------------------------------------ */
/* 内部ヘルパー                                                         */
/* ------------------------------------------------------------------ */

export class UserError extends Error {}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) throw new UserError('ホストのみ操作できます');
}

function playerSnapshot(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, role: p.role, status: p.status }));
}

function aliveCount(room) {
  return [...room.players.values()].filter((p) => p.status === 'alive').length;
}

function setPhase(room, phase, seconds) {
  clearTimer(room);
  clearBotTimers(room);
  room.phase = phase;
  room.phaseEndsAt = seconds ? Date.now() + seconds * 1000 : null;
  if (phase === 'night' || phase === 'vote') {
    scheduleTimer(room, seconds, () => (phase === 'night' ? finishNight(room) : finishVote(room)));
  } else if (phase === 'roleReveal') {
    scheduleTimer(room, seconds, () => beginNight(room));
  }
  scheduleBots(room);
}

/* ------------------------------------------------------------------ */
/* CPUの行動                                                            */
/* ------------------------------------------------------------------ */

function clearBotTimers(room) {
  for (const t of room.botTimers || []) clearTimeout(t);
  room.botTimers = [];
}

/** 人間らしく見えるよう、少し間を置いてから行動させる */
function laterAsBot(room, minMs, maxMs, fn) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  const timer = setTimeout(() => {
    try {
      fn();
    } catch (err) {
      // 対象が死んだ直後など、行動が無効になっているだけなら無視してよい
      if (!(err instanceof UserError)) console.error('[bot]', err);
    }
  }, delay);
  timer.unref?.();
  (room.botTimers ||= []).push(timer);
}

const pickOne = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

/** 現在のフェーズに応じて、全CPUの行動を予約する */
function scheduleBots(room) {
  clearBotTimers(room);
  const bots = [...room.players.values()].filter((p) => p.isBot);
  if (!bots.length) return;

  if (room.phase === 'roleReveal') {
    for (const bot of bots) laterAsBot(room, 400, 1500, () => setReady(room, bot.id));
    return;
  }

  if (room.phase === 'night') {
    for (const bot of bots) {
      if (bot.status !== 'alive') continue;
      const kind = ROLES[bot.role]?.night;
      if (!kind) continue; // 市民固定なら基本ここで終わる
      laterAsBot(room, 1500, Math.min(6000, room.config.nightSeconds * 500), () => {
        const targets = [...room.players.values()].filter(
          (p) => p.status === 'alive' && p.id !== bot.id && (kind !== 'attack' || p.role !== 'werewolf'),
        );
        const target = pickOne(targets);
        if (target) submitNightAction(room, bot.id, kind, target.id);
      });
    }
    return;
  }

  if (room.phase === 'vote' && room.config.botsVote) {
    for (const bot of bots) {
      if (bot.status !== 'alive') continue;
      laterAsBot(room, 2000, Math.min(8000, room.config.voteSeconds * 500), () => {
        const targets = [...room.players.values()].filter((p) => p.status === 'alive' && p.id !== bot.id);
        const target = pickOne(targets);
        if (target) castVote(room, bot.id, target.id);
      });
    }
  }
}

function scheduleTimer(room, seconds, fn) {
  clearTimer(room);
  room.phaseEndsAt = Date.now() + seconds * 1000;
  room.timer = setTimeout(() => {
    room.timer = null;
    try {
      fn();
    } catch (err) {
      console.error('[phase timer]', err);
    }
  }, seconds * 1000);
  // HTTP サーバーがイベントループを保持しているので unref して問題ない。
  // こうしておかないと、テストや CLI から使ったときにプロセスが終われない。
  room.timer.unref?.();
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function announce(room, text, kind = 'system') {
  room.announcements.push({ id: randomUUID(), day: room.day, phase: room.phase, text, kind, at: Date.now() });
  if (room.announcements.length > 200) room.announcements.shift();
}

function pushLog(room, log) {
  room.logs.push({ id: randomUUID(), at: Date.now(), ...log });
}

function touch(room) {
  room.updatedAt = Date.now();
  broadcast(room);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m && s) return `${m}分${s}秒`;
  if (m) return `${m}分`;
  return `${s}秒`;
}

/* ------------------------------------------------------------------ */
/* プレイヤー向けビューの組み立て（秘匿の要）                             */
/* ------------------------------------------------------------------ */

export function viewFor(room, playerId) {
  const me = room.players.get(playerId);
  const over = room.phase === 'gameOver';
  const iAmWolf = me?.role === 'werewolf';
  const inGame = room.phase !== 'lobby';

  const players = [...room.players.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      // 役職を渡してよいのは「自分」「ゲーム終了後」「人狼から見た仲間の人狼」だけ
      const showRole = over || p.id === playerId || (iAmWolf && p.role === 'werewolf');
      return {
        id: p.id,
        name: p.name,
        seat: p.seat,
        isHost: p.isHost,
        isBot: p.isBot,
        connected: p.connected,
        ready: p.ready,
        alive: p.status === 'alive',
        status: inGame ? p.status : 'alive',
        role: showRole ? p.role : null,
        isMe: p.id === playerId,
        // 「誰が投票済みか」は公開情報（3-5）。夜の行動状況は役職が漏れるので出さない
        hasVoted: room.phase === 'vote' ? !!room.votes[p.id] : undefined,
        votedFor: over || room.phase === 'execution' ? room.voteResult?.ballots?.[p.id] ?? null : null,
      };
    });

  const view = {
    serverNow: Date.now(),
    room: {
      id: room.id,
      phase: room.phase,
      day: room.day,
      phaseEndsAt: room.phaseEndsAt,
      hostId: room.hostId,
      config: room.config,
      playerCount: room.players.size,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    },
    me: me
      ? {
          id: me.id,
          name: me.name,
          isHost: me.isHost,
          role: me.role,
          roleInfo: me.role ? ROLES[me.role] : null,
          status: me.status,
          alive: me.status === 'alive',
          ready: me.ready,
        }
      : null,
    players,
    announcements: room.announcements.slice(-40),
    logs: room.logs
      .filter((l) => l.visibleTo === 'all' || l.visibleTo.includes(playerId))
      .map((l) => ({ ...l, visibleTo: undefined })),
    botCount: botCount(room),
    compositionError:
      room.phase === 'lobby'
        ? validateComposition(room.config.roleCounts, room.players.size, compositionOptions(room))
        : null,
  };

  if (room.phase === 'night') {
    const actors = nightActors(room);
    view.night = {
      // 個々人の行動状況は伏せ、集計だけ見せる（役職構成は公開情報なので分母は漏れてよい）
      actorTotal: actors.length,
      actorDone: actors.filter((p) => hasActed(room, p)).length,
      myAction: me ? currentAction(room, me) : null,
      // 人狼はチャットの代わりに仲間の襲撃投票が見える
      wolfVotes: iAmWolf && me.status === 'alive' ? { ...room.night.wolfVotes } : null,
    };
  }

  if (room.phase === 'vote') {
    view.vote = { myVote: room.votes[playerId] || null, castCount: Object.keys(room.votes).length };
  }

  if (room.phase === 'execution' || over) {
    view.voteResult = room.voteResult || null;
  }

  if (over) {
    view.result = room.result;
  }

  return view;
}

function currentAction(room, player) {
  const kind = ROLES[player.role]?.night;
  if (!kind) return null;
  const targetId =
    kind === 'divine'
      ? room.night.seerTargets[player.id]
      : kind === 'guard'
        ? room.night.knightTargets[player.id]
        : room.night.wolfVotes[player.id];
  return { kind, targetId: targetId || null, locked: kind === 'divine' && !!targetId };
}

/* ------------------------------------------------------------------ */
/* 掃除                                                                */
/* ------------------------------------------------------------------ */

export function startJanitor() {
  return setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      // CPUは常に接続扱いなので、人間が誰も残っていなければ空室とみなす
      const empty = ![...room.players.values()].some((p) => p.connected && !p.isBot);
      if (now - room.updatedAt > ROOM_TTL_MS || (empty && now - room.updatedAt > 10 * 60 * 1000)) {
        destroyRoom(room);
      }
    }
  }, 60 * 1000).unref();
}

export function roomCount() {
  return rooms.size;
}
