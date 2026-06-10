// 보드게임 파티 온라인 서버.
//  - /ws : 방(로비) 관리 + 게임 메시지 릴레이 WebSocket
//  - 그 외 : dist/ 정적 파일 서빙(빌드돼 있을 때) → 한 포트로 배포 가능
//
// 동기화 모델(호스트 권위):
//  - 로비(참가자/화면)는 서버가 관리해 모든 기기에 room 스냅샷을 보낸다.
//  - 게임 진행은 호스트 기기가 계산하고 'state'로 모두에게 전파,
//    게스트 기기의 입력은 'action'으로 호스트에게 릴레이된다.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createRoomStore } from './rooms.js'

const PORT = Number(process.env.PORT || 8787)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

const httpServer = http.createServer((req, res) => {
  // 정적 서빙(프로덕션). dist가 없으면 안내만.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath)
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end()
    return
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('BoardGameParty 서버 동작 중. 앱은 `npm run build` 후 이 포트로, 개발 중엔 vite(5173)로 접속하세요.')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
const store = createRoomStore()

// 연결이 끊긴 기기를 방에서 내보내기 전 기다려주는 시간.
// 이 안에 재접속하면 참가자/게임 화면을 그대로 이어간다.
const OFFLINE_GRACE_MS = 60_000

// deviceId -> { ws, room } (한 기기당 연결 1개)
const conns = new Map()
// `${roomCode}:${deviceId}` -> 유예 만료 타이머
const offlineTimers = new Map()

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastRoom(room) {
  const snap = store.snapshot(room)
  for (const devId of room.devices.keys()) {
    const c = conns.get(devId)
    if (c) send(c.ws, { t: 'room', room: snap })
  }
}

function closeRoom(room, reason) {
  for (const devId of [...room.devices.keys()]) {
    cancelOfflineCleanup(room, devId)
    const c = conns.get(devId)
    if (c) {
      c.room = null
      send(c.ws, { t: 'closed', reason })
    }
  }
  store.rooms.delete(room.code)
}

function cancelOfflineCleanup(room, deviceId) {
  const key = `${room.code}:${deviceId}`
  const t = offlineTimers.get(key)
  if (t) {
    clearTimeout(t)
    offlineTimers.delete(key)
  }
}

// 유예 시간 안에 돌아오지 않은 기기를 방에서 내보낸다.
// 호스트가 끝내 돌아오지 않으면 그때서야 방을 닫는다.
function scheduleOfflineCleanup(room, deviceId) {
  cancelOfflineCleanup(room, deviceId)
  const key = `${room.code}:${deviceId}`
  offlineTimers.set(key, setTimeout(() => {
    offlineTimers.delete(key)
    if (store.rooms.get(room.code) !== room) return
    const dev = room.devices.get(deviceId)
    if (!dev || dev.online) return // 이미 떠났거나 복귀함
    if (store.leave(room, deviceId) === 'closed') closeRoom(room, '호스트가 돌아오지 않아 방을 닫았어요.')
    else broadcastRoom(room)
  }, OFFLINE_GRACE_MS))
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
  let deviceId = null

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    try {
      handle(msg)
    } catch (err) {
      send(ws, { t: 'error', message: err.message || '오류가 발생했어요.' })
    }
  })

  function handle(msg) {
    if (msg.t === 'hello') {
      deviceId = String(msg.deviceId || '').slice(0, 64)
      if (!deviceId) throw new Error('deviceId가 필요해요.')
      // 같은 기기의 이전 연결이 남아 있으면 교체(새로고침 등)
      const prev = conns.get(deviceId)
      if (prev && prev.ws !== ws) prev.ws.terminate()
      // 끊겼던(유예 중) 기기면 원래 방으로 복귀시킨다
      const room =
        (prev?.room && store.rooms.get(prev.room.code) === prev.room ? prev.room : null) ||
        store.findRoomByDevice(deviceId)
      conns.set(deviceId, { ws, room })
      if (room) {
        cancelOfflineCleanup(room, deviceId)
        store.setOnline(room, deviceId, true)
        broadcastRoom(room)
        // 게임 중이었다면 마지막 상태도 다시 보내 화면을 이어 그리게 한다
        if (room.lastState != null && room.hostId !== deviceId) send(ws, { t: 'state', data: room.lastState })
      } else if (msg.room) {
        // 클라이언트는 방에 있었다고 알고 있지만 서버엔 없음(유예 만료/서버 재시작)
        send(ws, { t: 'closed', reason: '방이 닫혔어요. 처음 화면에서 다시 시작해 주세요.' })
      }
      return
    }
    if (!deviceId) throw new Error('먼저 hello를 보내야 해요.')
    const conn = conns.get(deviceId)

    switch (msg.t) {
      case 'create': {
        if (conn.room) store.leave(conn.room, deviceId)
        conn.room = store.create(deviceId)
        broadcastRoom(conn.room)
        break
      }
      case 'join': {
        const room = store.join(msg.code, deviceId)
        conn.room = room
        cancelOfflineCleanup(room, deviceId) // 유예 중 재참여면 그대로 복귀
        broadcastRoom(room)
        // 게임 중간에 들어온 기기도 화면을 그릴 수 있게 마지막 상태를 보내준다
        if (room.lastState != null && room.hostId !== deviceId) send(ws, { t: 'state', data: room.lastState })
        break
      }
      case 'leave': {
        if (!conn.room) break
        const room = conn.room
        conn.room = null
        if (store.leave(room, deviceId) === 'closed') closeRoom(room, '호스트가 방을 나갔어요.')
        else broadcastRoom(room)
        break
      }
      case 'addPlayer': {
        if (!conn.room) throw new Error('방에 먼저 참여해 주세요.')
        store.addPlayer(conn.room, deviceId, msg.player || {})
        broadcastRoom(conn.room)
        break
      }
      case 'removePlayer': {
        if (!conn.room) break
        store.removePlayer(conn.room, deviceId, msg.playerId)
        broadcastRoom(conn.room)
        break
      }
      case 'setScreen': {
        if (!conn.room) break
        store.setScreen(conn.room, deviceId, msg.screen)
        conn.room.lastState = null // 새 화면 → 이전 게임 상태 폐기
        broadcastRoom(conn.room)
        break
      }
      case 'state': {
        // 호스트 → 게스트 전원에게 게임 상태 전파
        const room = conn.room
        if (!room || room.hostId !== deviceId) break
        room.lastState = msg.data
        for (const devId of room.devices.keys()) {
          if (devId === deviceId) continue
          const c = conns.get(devId)
          if (c) send(c.ws, { t: 'state', data: msg.data })
        }
        break
      }
      case 'action': {
        // 게스트 → 호스트에게 입력 릴레이
        const room = conn.room
        if (!room) break
        const host = conns.get(room.hostId)
        if (host) send(host.ws, { t: 'action', data: msg.data, deviceId })
        break
      }
      default:
        break
    }
  }

  ws.on('close', () => {
    if (!deviceId) return
    const conn = conns.get(deviceId)
    if (!conn || conn.ws !== ws) return // 새 연결로 교체된 경우
    conns.delete(deviceId)
    const room = conn.room
    if (!room || store.rooms.get(room.code) !== room) return
    // 바로 내보내지 않고 잠시 기다린다 — 새로고침/순간 끊김이면 그대로 복귀.
    // 호스트가 끊긴 동안 게스트들은 hostOnline=false 스냅샷으로 안내를 본다.
    store.setOnline(room, deviceId, false)
    broadcastRoom(room)
    scheduleOfflineCleanup(room, deviceId)
  })
})

// 죽은 연결 정리(킵얼라이브)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 25000)
wss.on('close', () => clearInterval(heartbeat))

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[boardgameparty] 서버 시작: http://0.0.0.0:${PORT} (ws: /ws)`)
})
