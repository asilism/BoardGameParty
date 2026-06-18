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
import { createRealtimeSession } from './realtime.js'
import { isRealtimeGame } from './games.js'

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

// deviceId -> { ws, room } (한 기기당 연결 1개)
const conns = new Map()

// room.code -> 실시간 게임 세션(④ 서버 권위). 실시간 게임 화면일 때만 존재.
const rtSessions = new Map()

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

// 실시간 스냅샷(바이너리 프레임)을 한 기기로 전송
function sendBytes(devId, bytes) {
  const c = conns.get(devId)
  if (c && c.ws.readyState === c.ws.OPEN) c.ws.send(bytes)
}

function ensureSession(room, gameId) {
  const cur = rtSessions.get(room.code)
  if (cur && cur.gameId === gameId) return cur
  if (cur) cur.end()
  const s = createRealtimeSession(gameId, room, sendBytes)
  if (!s) {
    rtSessions.delete(room.code)
    return null
  }
  rtSessions.set(room.code, s)
  s.begin()
  return s
}

function dropSession(room) {
  const s = rtSessions.get(room.code)
  if (s) {
    s.end()
    rtSessions.delete(room.code)
  }
}

function broadcastRoom(room) {
  const snap = store.snapshot(room)
  for (const devId of room.devices.keys()) {
    const c = conns.get(devId)
    if (c) send(c.ws, { t: 'room', room: snap })
  }
}

function closeRoom(room, reason) {
  dropSession(room)
  for (const devId of [...room.devices.keys()]) {
    const c = conns.get(devId)
    if (c) {
      c.room = null
      send(c.ws, { t: 'closed', reason })
    }
  }
  store.rooms.delete(room.code)
}

// 한 기기가 방에서 빠질 때(나가기/연결 끊김) 공통 처리:
// 방이 닫히면 세션 정리, 아니면 그 기기의 엔티티를 봇이 인계한다.
function handleDeparture(room, deviceId) {
  const leftIds = (room.devices.get(deviceId)?.players || []).map((p) => p.id)
  if (store.leave(room, deviceId) === 'closed') {
    closeRoom(room, deviceId === room.hostId ? '호스트가 방을 나갔어요.' : '방이 닫혔어요.')
    return 'closed'
  }
  broadcastRoom(room)
  rtSessions.get(room.code)?.takeOver(leftIds)
  return 'left'
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
      conns.set(deviceId, { ws, room: prev?.room || null })
      if (prev?.room) {
        send(ws, { t: 'room', room: store.snapshot(prev.room) })
        // 재연결: 실시간 게임 중이면 다음 틱에 full 스냅샷을 받아 델타 누적을 재동기화
        rtSessions.get(prev.room.code)?.deviceJoined(deviceId)
      }
      return
    }
    if (!deviceId) throw new Error('먼저 hello를 보내야 해요.')
    const conn = conns.get(deviceId)

    switch (msg.t) {
      case 'create': {
        if (conn.room) {
          const old = conn.room
          if (store.leave(old, deviceId) === 'closed') dropSession(old)
        }
        conn.room = store.create(deviceId)
        broadcastRoom(conn.room)
        break
      }
      case 'join': {
        const room = store.join(msg.code, deviceId)
        conn.room = room
        broadcastRoom(room)
        // 게임 중간에 들어온 기기도 화면을 그릴 수 있게 마지막 상태를 보내준다
        if (room.lastState != null) send(ws, { t: 'state', data: room.lastState })
        // 실시간 게임 진행 중이면 다음 틱에 full 스냅샷 한 장을 받도록 표시
        rtSessions.get(room.code)?.deviceJoined(deviceId)
        break
      }
      case 'leave': {
        if (!conn.room) break
        const room = conn.room
        conn.room = null
        handleDeparture(room, deviceId)
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
        // 실시간 게임 화면이면 서버 권위 세션을 띄우고, 아니면 정리한다.
        if (isRealtimeGame(msg.screen)) ensureSession(conn.room, msg.screen)
        else dropSession(conn.room)
        break
      }
      // ── 실시간 게임(④ 서버 권위) ──
      case 'rtStart': {
        const s = conn.room && rtSessions.get(conn.room.code)
        if (s && conn.room.hostId === deviceId) s.start(msg.config)
        break
      }
      case 'rtStop': {
        const s = conn.room && rtSessions.get(conn.room.code)
        if (s && conn.room.hostId === deviceId) s.reset()
        break
      }
      case 'rtPause': {
        // 방장만 일시정지/재개할 수 있다
        const s = conn.room && rtSessions.get(conn.room.code)
        if (s && conn.room.hostId === deviceId) s.setPaused(msg.paused)
        break
      }
      case 'rtInput': {
        const s = conn.room && rtSessions.get(conn.room.code)
        if (s) s.input(deviceId, msg.input)
        break
      }
      case 'rtAction': {
        const s = conn.room && rtSessions.get(conn.room.code)
        if (s) s.action(deviceId, msg.action)
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
    if (!room) return
    handleDeparture(room, deviceId)
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
