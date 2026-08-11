/**
 * 「ルームを出て、別のルームを作り直す」流れの回帰テスト。
 * 乱用対策を入れたときに、この普通の操作まで塞いでしまったことがある。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const PORT = 34782;
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
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`サーバー終了 code=${code}`)); });
  });
}

const call = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload || {}, resolve));

test('ルームを出たあと、すぐに別のルームを作り直せる', async (t) => {
  const server = await startServer();
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  t.after(() => { socket.close(); server.kill(); });
  await new Promise((r) => socket.on('connect', r));

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const created = await call(socket, 'room:create', { name: 'テスト' });
    assert.equal(created.ok, true, `${i + 1}回目の作成が失敗: ${created.error}`);
    ids.push(created.roomId);
    const left = await call(socket, 'room:leave');
    assert.equal(left.ok, true, `${i + 1}回目の退出が失敗: ${left.error}`);
  }
  assert.equal(new Set(ids).size, 3, '毎回ちがうルームIDになること');
});

test('退出したルームには、同じ接続でも入り直せない（ロビーなら消える）', async (t) => {
  const server = await startServer();
  const a = io(URL, { transports: ['websocket'], forceNew: true });
  t.after(() => { a.close(); server.kill(); });
  await new Promise((r) => a.on('connect', r));

  const created = await call(a, 'room:create', { name: 'ホスト' });
  await call(a, 'room:leave');

  // ロビー中の退出は完全に抜ける扱いなので、最後の1人が抜けた部屋は消えている
  const rejoin = await call(a, 'room:join', { roomId: created.roomId, name: 'ホスト' });
  assert.equal(rejoin.ok, false);
  assert.match(rejoin.error, /見つかりません/);
});

test('ルームの作りすぎは止める（乱用対策は残っている）', async (t) => {
  const server = await startServer();
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  t.after(() => { socket.close(); server.kill(); });
  await new Promise((r) => socket.on('connect', r));

  let blockedAt = null;
  for (let i = 1; i <= 15; i++) {
    const res = await call(socket, 'room:create', { name: 'x' });
    if (!res.ok) { blockedAt = i; break; }
    await call(socket, 'room:leave');
  }
  assert.ok(blockedAt !== null, '無制限に作れてしまいます');
  assert.ok(blockedAt > 5, `通常利用を妨げる厳しさです（${blockedAt}回目で遮断）`);
});
