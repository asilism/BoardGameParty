// 실시간 게임 세션(④ 서버 권위). 방 하나당 하나.
//  - 서버가 engine 시뮬을 고정틱으로 굴리고(60Hz), 20Hz로 스냅샷을 바이너리 델타로 방송한다.
//  - 입력/액션은 어느 기기든 받아 "그 기기가 조종하는 엔티티"에만 적용(소유권은 서버가 판정).
//  - 사람이 나가면 그 엔티티는 봇이 인계.
import { RealtimeSim } from '../src/net/realtime/sim.js'
import { encodeSnapshot } from '../src/net/realtime/codec.js'
import { racerIdFor } from '../src/net/realtime/roster.js'
import { GAMES } from './games.js'

const TICK_MS = 50 // 20Hz 방송 / 시뮬은 실제 경과만큼 60Hz로 따라잡음

function allPlayersOf(room) {
  const out = []
  for (const dev of room.devices.values()) out.push(...dev.players)
  return out
}

// sendTo(deviceId, Uint8Array) : 바이너리 프레임 실제 전송(index.js가 주입)
export function createRealtimeSession(gameId, room, sendTo) {
  const adapter = GAMES[gameId]
  if (!adapter) return null

  let sim = null // 게임 진행 중에만 존재. null이면 셋업 단계.
  let lastView = null // 직전 방송 view(델타 기준)
  let lastNow = Date.now()
  let timer = null
  let paused = false // 방장이 일시정지하면 시뮬을 멈춘다(방송은 계속)
  const needsFull = new Set() // 중간 합류 등으로 full이 필요한 기기

  function broadcast() {
    // 일시정지 상태는 view에 실어 보낸다(클라가 오버레이/예측정지 판단)
    const view = sim ? { ...sim.view(), paused } : { phase: 'setup' }
    const delta = encodeSnapshot(lastView, view)
    let full = null // 필요할 때만 만든다
    const getFull = () => (full || (full = encodeSnapshot(null, view)))
    for (const devId of room.devices.keys()) {
      if (lastView == null || needsFull.has(devId)) sendTo(devId, getFull())
      else sendTo(devId, delta)
    }
    needsFull.clear()
    lastView = view
  }

  function tick() {
    if (sim) {
      const now = Date.now()
      // 일시정지 중엔 시뮬을 진행하지 않는다. lastNow는 갱신해 둬야
      // 재개 시 멈춰 있던 시간만큼 한꺼번에 따라잡지 않는다.
      if (!paused) sim.advance(now - lastNow)
      lastNow = now
    }
    broadcast()
  }

  return {
    gameId,

    begin() {
      lastNow = Date.now()
      if (!timer) timer = setInterval(tick, TICK_MS)
    },
    end() {
      if (timer) clearInterval(timer)
      timer = null
      sim = null
    },

    // 호스트가 시작/리매치 — 설정으로 시뮬 생성
    start(config) {
      const { players, opts } = adapter.buildParticipants(allPlayersOf(room), config || {})
      sim = new RealtimeSim(adapter, adapter.createGame(players, opts))
      lastNow = Date.now()
      lastView = null // 다음 방송은 전원 full
      paused = false
    },
    // 호스트가 셋업으로 복귀(맵/팀 다시 고르기)
    reset() {
      sim = null
      lastView = null
      paused = false
    },
    // 방장 전용: 일시정지/재개. 재개 직후 한 틱이 폭주하지 않게 lastNow를 맞춘다.
    setPaused(value) {
      paused = !!value
      if (!paused) lastNow = Date.now()
    },

    input(deviceId, input) {
      if (!sim || !input || paused) return
      const id = racerIdFor(allPlayersOf(room), deviceId)
      if (id) sim.setInput(id, input)
    },
    action(deviceId, action) {
      if (!sim || !action || paused) return
      const id = racerIdFor(allPlayersOf(room), deviceId)
      if (id) sim.applyAction(action, id)
    },

    deviceJoined(deviceId) {
      needsFull.add(deviceId) // 다음 틱에 full 한 장
    },
    // 나간 기기의 엔티티를 봇이 인계
    takeOver(leftPlayerIds) {
      if (!sim) return
      for (const pid of leftPlayerIds || []) adapter.makeBot?.(sim.state, pid)
    },
  }
}
