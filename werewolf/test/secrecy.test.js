/**
 * 実際にサーバーを起動し、WebSocket で流れるペイロードを1件残らず記録して
 * 「役職が漏れていないこと」を検証する統合テスト。
 *
 * この設計の中心的な主張（サーバーが秘匿を保証する）を守る回帰テストなので、
 * ここが落ちたらリリースしてはいけない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const PORT = 34781;
const URL = `http://localhost:${PORT}`;

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバーが起動しませんでした')), 10000);
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('起動')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (buf) => process.stderr.write(buf));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`サーバーが終了しました code=${code}`)); });
  });
}

/** 受信した state をすべて記録するクライアント */
function connect() {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const client = { socket, states: [], raw: [], latest: null, id: null };
  socket.on('state', (view) => {
    client.raw.push(JSON.stringify(view));
    client.states.push(view);
    client.latest = view;
  });
  return client;
}

const call = (client, event, payload) =>
  new Promise((resolve) => client.socket.emit(event, payload || {}, resolve));

const waitFor = (client, predicate, label) =>
  new Promise((resolve, reject) => {
    if (client.latest && predicate(client.latest)) return resolve(client.latest);
    const timer = setTimeout(() => reject(new Error(`タイムアウト: ${label}`)), 8000);
    const onState = (view) => {
      if (!predicate(view)) return;
      clearTimeout(timer);
      client.socket.off('state', onState);
      resolve(view);
    };
    client.socket.on('state', onState);
  });

test('役職は本人・仲間の人狼・ゲーム終了後にしか送信されない', async (t) => {
  const server = await startServer();
  const clients = [];
  t.after(() => {
    for (const c of clients) c.socket.close();
    server.kill();
  });

  // --- 6人でルームを作る ---
  const host = connect();
  clients.push(host);
  const created = await call(host, 'room:create', { name: 'ホスト' });
  assert.equal(created.ok, true);
  host.id = created.playerId;
  const roomId = created.roomId;

  for (const name of ['B', 'C', 'D', 'E', 'F']) {
    const c = connect();
    clients.push(c);
    const res = await call(c, 'room:join', { roomId, name });
    assert.equal(res.ok, true, res.error);
    c.id = res.playerId;
  }

  // --- 開始 ---
  await call(host, 'config:update', { nightSeconds: 300, discussionSeconds: 300, voteSeconds: 300 });
  const started = await call(host, 'game:start');
  assert.equal(started.ok, true, started.error);
  for (const c of clients) await call(c, 'player:ready');
  await waitFor(host, (v) => v.room.phase === 'night', '夜への移行');

  const roleOf = (c) => c.latest.me.role;
  const wolves = clients.filter((c) => roleOf(c) === 'werewolf');
  const nonWolves = clients.filter((c) => roleOf(c) !== 'werewolf');
  assert.ok(wolves.length >= 1, '人狼が配られていること');

  // --- 1. 人狼以外は、自分以外の役職を一切受け取っていない ---
  for (const c of nonWolves) {
    for (const view of c.states) {
      for (const p of view.players) {
        if (p.id === c.id) continue;
        assert.equal(p.role, null, `${c.latest.me.name} に ${p.name} の役職が漏れています`);
      }
    }
  }

  // --- 2. 人狼が見えるのは「仲間の人狼」だけ ---
  for (const c of wolves) {
    for (const p of c.latest.players) {
      if (p.id === c.id) continue;
      if (p.role !== null) assert.equal(p.role, 'werewolf', '人狼に人狼以外の役職が見えています');
    }
  }

  // --- 3. 再接続トークンが他人に漏れていない ---
  for (const c of clients) {
    for (const raw of c.raw) {
      assert.ok(!raw.includes('"token"'), 'ビューに token が含まれています');
    }
  }

  // --- 4. 占い結果は占い師本人にしか届かない ---
  const seer = clients.find((c) => roleOf(c) === 'seer');
  if (seer) {
    const target = seer.latest.players.find((p) => p.id !== seer.id && p.alive);
    await call(seer, 'night:action', { kind: 'divine', targetId: target.id });
    await waitFor(seer, (v) => v.logs.some((l) => l.type === 'divine'), '占い結果');
    const divineLog = seer.latest.logs.find((l) => l.type === 'divine');
    assert.ok(divineLog.result === 'wolf' || divineLog.result === 'human');
    for (const c of clients) {
      if (c === seer) continue;
      assert.equal(c.latest.logs.some((l) => l.type === 'divine'), false, '占い結果が他人に見えています');
    }
  }

  // --- 5. 襲撃ログは人狼にしか見えない ---
  const wolf = wolves[0];
  const prey = wolf.latest.players.find((p) => p.alive && p.role !== 'werewolf' && p.id !== wolf.id);
  await call(wolf, 'night:action', { kind: 'attack', targetId: prey.id });
  const knight = clients.find((c) => roleOf(c) === 'knight');
  if (knight) {
    const gTarget = knight.latest.players.find((p) => p.id !== knight.id && p.alive);
    await call(knight, 'night:action', { kind: 'guard', targetId: gTarget.id });
  }
  await waitFor(host, (v) => v.room.phase !== 'night', '朝への移行');
  for (const c of nonWolves) {
    assert.equal(c.latest.logs.some((l) => l.type === 'attack'), false, '襲撃ログが人狼以外に見えています');
  }

  // --- 6. 権限のない操作は拒否される ---
  const notHost = clients.find((c) => !c.latest.me.isHost);
  const denied = await call(notHost, 'host:skip');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /ホスト/);

  const villager = clients.find((c) => roleOf(c) === 'villager' && c.latest.me.alive);
  if (villager) {
    const bogus = await call(villager, 'night:action', { kind: 'divine', targetId: host.id });
    assert.equal(bogus.ok, false, '市民が占いを実行できてしまいます');
  }

  // --- 7. ゲーム終了まで進めると、全員の役職が公開される ---
  for (let guard = 0; guard < 12 && host.latest.room.phase !== 'gameOver'; guard++) {
    const phase = host.latest.room.phase;
    if (phase === 'vote') {
      const alive = clients.filter((c) => c.latest.me.alive);
      const victim = alive.find((c) => roleOf(c) === 'werewolf') || alive[0];
      for (const c of alive) {
        const target = c === victim ? alive.find((x) => x !== victim) : victim;
        if (target) await call(c, 'vote:cast', { targetId: target.id });
      }
    } else if (phase === 'night') {
      for (const c of clients.filter((x) => x.latest.me.alive && x.latest.night?.myAction && !x.latest.night.myAction.targetId)) {
        const kind = c.latest.night.myAction.kind;
        const pool = c.latest.players.filter(
          (p) => p.alive && p.id !== c.id && (kind !== 'attack' || p.role !== 'werewolf'),
        );
        if (pool.length) await call(c, 'night:action', { kind, targetId: pool[0].id });
      }
    } else {
      await call(host, 'host:skip');
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  assert.equal(host.latest.room.phase, 'gameOver', 'ゲームが終了すること');
  for (const p of host.latest.players) {
    assert.ok(p.role, `終了後は ${p.name} の役職が公開されること`);
  }
  assert.ok(['village', 'wolf'].includes(host.latest.result.winner));
});
