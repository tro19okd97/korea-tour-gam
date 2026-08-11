/**
 * 手動テスト用のボット。起動中のサーバーの既存ルームに参加し、自動でプレイする。
 *
 *   node test/bots.js <ROOM_ID> [人数] [http://localhost:3000]
 *
 * ブラウザ側でホストとして進行を確認したいときに使う。
 */
import { io } from 'socket.io-client';

const [, , roomId, countArg, urlArg] = process.argv;
if (!roomId) {
  console.error('使い方: node test/bots.js <ROOM_ID> [人数] [URL]');
  process.exit(1);
}
const count = Number(countArg) || 4;
const url = urlArg || 'http://localhost:3000';
const NAMES = ['ボットA', 'ボットB', 'ボットC', 'ボットD', 'ボットE', 'ボットF', 'ボットG', 'ボットH'];

for (let i = 0; i < count; i++) spawnBot(NAMES[i] || `ボット${i}`);

function spawnBot(name) {
  const socket = io(url, { transports: ['websocket'] });
  let me = null;

  socket.on('connect', () => {
    socket.emit('room:join', { roomId, name }, (res) => {
      if (!res.ok) { console.error(`${name}: ${res.error}`); process.exit(1); }
      me = res.playerId;
      console.log(`${name} が参加しました`);
    });
  });

  socket.on('state', (S) => {
    if (!S.me) return;
    const alive = S.players.filter((p) => p.alive && p.id !== me);
    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    if (S.room.phase === 'roleReveal' && !S.me.ready) {
      setTimeout(() => socket.emit('player:ready'), 300 + Math.random() * 700);
    }

    if (S.room.phase === 'night' && S.me.alive && S.night?.myAction && !S.night.myAction.targetId) {
      const kind = S.night.myAction.kind;
      const pool = kind === 'attack' ? alive.filter((p) => p.role !== 'werewolf') : alive;
      if (pool.length) {
        setTimeout(() => socket.emit('night:action', { kind, targetId: pick(pool).id }), 500 + Math.random() * 2000);
      }
    }

    if (S.room.phase === 'vote' && S.me.alive && !S.vote?.myVote && alive.length) {
      setTimeout(() => socket.emit('vote:cast', { targetId: pick(alive).id }), 800 + Math.random() * 2500);
    }

    if (S.room.phase === 'gameOver' && !socket._reported) {
      socket._reported = true;
      console.log(`${name}(${S.me.role}) — ${S.result.winner === 'village' ? '村人陣営' : '人狼陣営'}の勝利`);
    }
  });
}
