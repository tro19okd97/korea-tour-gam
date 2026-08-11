/**
 * HTTP（静的配信）+ Socket.IO のエントリポイント。
 * ここはトランスポート層だけ。ゲームの判断は一切書かない。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import * as R from './rooms.js';
import { ROLES, ROLE_ORDER, MIN_PLAYERS, MAX_PLAYERS } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 外部公開を前提とした最低限のセキュリティヘッダ */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // 外部リソースを一切読まない作りなので self だけ許可すれば足りる
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  // ホスティング先のヘルスチェック用
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: R.roomCount(), uptime: Math.round(process.uptime()) }));
    return;
  }

  const rel = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC_DIR, rel);

  // SPA なので未知のパス（/r/ABC123 など）は index.html に落とす
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

const io = new Server(server, {
  // CORS は設定しない = 同一オリジンのみ。
  // ここを '*' にすると、他人のサイトから勝手にソケットを張って
  // ルーム作成やイベント送信ができてしまう。
  maxHttpBufferSize: 8 * 1024, // このアプリの送信はどれも数百バイト
  pingTimeout: 30000, // スマホのバックグラウンド移行で切れにくくする
});

/** room の状態が変わるたびに、各プレイヤー専用のビューだけを配る */
R.setBroadcaster((room) => {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('state', R.viewFor(room, player.id));
  }
});
R.startJanitor();

/* ---------- 流量制限 ---------- */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_EVENTS = 120; // 人力の操作なら10秒で120回も送らない
// ルーム作成は「間隔」ではなく「回数」で抑える。
// 一定秒数あけさせる方式にすると、作り直したいだけの人まで止めてしまう。
const CREATE_WINDOW_MS = 10 * 60_000;
const CREATE_MAX = 10;

/** 1接続あたりのイベント流量を制限する。超えたら切断する。 */
function withinRate(socket) {
  const now = Date.now();
  const d = socket.data;
  if (!d.rate || now - d.rate.start > RATE_WINDOW_MS) d.rate = { start: now, count: 0 };
  d.rate.count += 1;
  return d.rate.count <= RATE_MAX_EVENTS;
}

/** ack を必ず {ok:boolean} 形式で返すラッパー */
function handle(socket, event, fn) {
  socket.on(event, async (payload, ack) => {
    if (!withinRate(socket)) {
      if (typeof ack === 'function') ack({ ok: false, error: '操作が多すぎます' });
      socket.disconnect(true);
      return;
    }
    try {
      const result = (await fn(payload || {})) || {};
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof R.UserError ? err.message : 'エラーが発生しました';
      if (!(err instanceof R.UserError)) console.error(`[${event}]`, err);
      if (typeof ack === 'function') ack({ ok: false, error: message });
      else socket.emit('error:toast', message);
    }
  });
}

/** ソケットに紐づく room / player を取り出す。無ければ UserError */
function context(socket) {
  const { roomId, playerId } = socket.data;
  const room = roomId && R.getRoom(roomId);
  const player = room && room.players.get(playerId);
  if (!room || !player) throw new R.UserError('ルームに参加していません');
  return { room, player };
}

function bind(socket, room, player) {
  socket.data.roomId = room.id;
  socket.data.playerId = player.id;
  socket.join(room.id);
  R.attachSocket(room, player, socket.id);
  return { roomId: room.id, playerId: player.id, token: player.token };
}

io.on('connection', (socket) => {
  // 役職メタデータは静的なので接続時に1度だけ渡す
  socket.emit('meta', { roles: ROLES, roleOrder: ROLE_ORDER, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS });

  handle(socket, 'room:create', ({ name }) => {
    const now = Date.now();
    const d = socket.data;
    if (!d.creates || now - d.creates.start > CREATE_WINDOW_MS) d.creates = { start: now, count: 0 };
    if (d.creates.count >= CREATE_MAX) {
      throw new R.UserError('ルームを作りすぎです。しばらくしてからお試しください');
    }
    const { room, player } = R.createRoom(name);
    d.creates.count += 1;
    const info = bind(socket, room, player);
    console.log(`[room:create] ${room.id} by ${player.name} (rooms=${R.roomCount()})`);
    return info;
  });

  handle(socket, 'room:join', ({ roomId, name }) => {
    const { room, player } = R.joinRoom(roomId, name);
    return bind(socket, room, player);
  });

  handle(socket, 'room:reconnect', ({ roomId, playerId, token }) => {
    const { room, player } = R.reconnect(roomId, playerId, token);
    return bind(socket, room, player);
  });

  handle(socket, 'config:update', (patch) => {
    const { room, player } = context(socket);
    R.updateConfig(room, player.id, patch);
  });

  handle(socket, 'bot:add', () => {
    const { room, player } = context(socket);
    R.addBot(room, player.id);
  });

  handle(socket, 'bot:remove', ({ botId }) => {
    const { room, player } = context(socket);
    R.removeBot(room, player.id, botId);
  });

  handle(socket, 'config:suggest', () => {
    const { room, player } = context(socket);
    R.applySuggested(room, player.id);
  });

  handle(socket, 'game:start', () => {
    const { room, player } = context(socket);
    R.startGame(room, player.id);
  });

  handle(socket, 'player:ready', () => {
    const { room, player } = context(socket);
    R.setReady(room, player.id);
  });

  handle(socket, 'night:action', ({ kind, targetId }) => {
    const { room, player } = context(socket);
    R.submitNightAction(room, player.id, kind, targetId);
  });

  handle(socket, 'vote:cast', ({ targetId }) => {
    const { room, player } = context(socket);
    R.castVote(room, player.id, targetId);
  });

  handle(socket, 'host:skip', () => {
    const { room, player } = context(socket);
    R.skipPhase(room, player.id);
  });

  handle(socket, 'game:restart', () => {
    const { room, player } = context(socket);
    R.restartGame(room, player.id);
  });

  handle(socket, 'room:leave', () => {
    const { room, player } = context(socket);
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerId = null;
    R.leaveRoom(room, player);
  });

  socket.on('disconnect', () => {
    const { roomId, playerId } = socket.data;
    const room = roomId && R.getRoom(roomId);
    const player = room && room.players.get(playerId);
    if (room && player && player.socketId === socket.id) R.handleDisconnect(room, player);
  });
});

server.listen(PORT, () => {
  console.log(`🐺 人狼サーバー起動: http://localhost:${PORT}`);
});

// ホスティング先の再起動時に、接続中のプレイヤーへ理由を伝えてから落とす
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} を受信。サーバーを停止します`);
    io.emit('error:toast', 'サーバーを再起動します。進行中のゲームは終了します');
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
