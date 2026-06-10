// 온라인 방(룸) 순수 로직. 네트워크(ws)와 분리되어 테스트 가능.
//
// 구조:
//  - 방 하나 = 호스트 기기 1대 + 게스트 기기 N대.
//  - 각 "기기(device)"는 참가자(플레이어)를 0명 이상 등록할 수 있다.
//    (호스트 태블릿에 아이 2명 + 폰으로 접속한 친구 1명 같은 혼합 구성 가능)
//  - 참가자 말(12지신)은 방 전체에서 중복 불가, 최대 인원 제한.
//  - 로비(참가자 명단/화면 전환)는 서버가 관리하고, 게임 진행 상태는
//    호스트 기기가 권위를 갖고 state 브로드캐스트 / 게스트 action 릴레이로 동작.

export const MAX_PLAYERS = 5
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 헷갈리는 글자(I,L,O,0,1) 제외
const ZODIAC_IDS = [
  'rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake',
  'horse', 'goat', 'monkey', 'rooster', 'dog', 'pig',
]

export function createRoomStore(rng = Math.random) {
  const rooms = new Map() // code -> room

  function genCode() {
    for (let tries = 0; tries < 100; tries++) {
      let code = ''
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]
      if (!rooms.has(code)) return code
    }
    throw new Error('방 코드를 만들 수 없습니다')
  }

  // 방 생성. 만든 기기가 호스트가 된다.
  function create(deviceId) {
    const code = genCode()
    const room = {
      code,
      hostId: deviceId,
      screen: 'lobby', // 'lobby' | 게임 id ('ladder' 등)
      devices: new Map([[deviceId, { players: [], online: true }]]),
    }
    rooms.set(code, room)
    return room
  }

  // 코드로 방 참여. 실패 시 에러 메시지 throw.
  // 이미 있던 기기면(끊겼다 재참여 등) 참가자를 유지한 채 온라인으로 복귀한다.
  function join(code, deviceId) {
    const room = rooms.get(normalizeCode(code))
    if (!room) throw new Error('방을 찾을 수 없어요. 코드를 확인해 주세요.')
    const dev = room.devices.get(deviceId)
    if (dev) dev.online = true
    else room.devices.set(deviceId, { players: [], online: true })
    return room
  }

  // 연결 상태 표시. 끊겨도 기기를 바로 내보내지 않고(유예) 표시만 바꾼다.
  function setOnline(room, deviceId, online) {
    const dev = room.devices.get(deviceId)
    if (!dev) return false
    dev.online = online
    return true
  }

  // 재접속한 기기가 속해 있던 방 찾기
  function findRoomByDevice(deviceId) {
    for (const room of rooms.values()) {
      if (room.devices.has(deviceId)) return room
    }
    return null
  }

  // 기기 이탈. 그 기기의 참가자도 함께 제거된다.
  // 호스트가 나가면 방 자체가 닫힌다 → 'closed' 반환.
  function leave(room, deviceId) {
    room.devices.delete(deviceId)
    if (deviceId === room.hostId || room.devices.size === 0) {
      rooms.delete(room.code)
      return 'closed'
    }
    return 'left'
  }

  // 참가자 추가(기기 단위). 말 중복/정원 초과 시 에러 throw.
  function addPlayer(room, deviceId, { zodiacId, name }) {
    const dev = room.devices.get(deviceId)
    if (!dev) throw new Error('방에 참여하지 않은 기기예요.')
    if (!ZODIAC_IDS.includes(zodiacId)) throw new Error('알 수 없는 말이에요.')
    if (countPlayers(room) >= MAX_PLAYERS) throw new Error(`최대 ${MAX_PLAYERS}명까지 참가할 수 있어요.`)
    if (allPlayers(room).some((p) => p.zodiacId === zodiacId)) throw new Error('이미 누가 고른 말이에요.')
    const safeName = String(name || '').trim().slice(0, 6)
    dev.players.push({ id: zodiacId, zodiacId, name: safeName, deviceId })
    return room
  }

  // 참가자 제거. 자기 기기 참가자이거나 호스트면 가능.
  function removePlayer(room, deviceId, playerId) {
    for (const [devId, dev] of room.devices) {
      const idx = dev.players.findIndex((p) => p.id === playerId)
      if (idx === -1) continue
      if (devId !== deviceId && deviceId !== room.hostId) throw new Error('내 참가자만 뺄 수 있어요.')
      dev.players.splice(idx, 1)
      return room
    }
    return room
  }

  // 화면 전환(게임 시작/로비 복귀). 호스트만 가능.
  function setScreen(room, deviceId, screen) {
    if (deviceId !== room.hostId) throw new Error('호스트만 게임을 시작할 수 있어요.')
    room.screen = String(screen)
    return room
  }

  function allPlayers(room) {
    const out = []
    for (const dev of room.devices.values()) out.push(...dev.players)
    return out
  }

  const countPlayers = (room) => allPlayers(room).length

  // 클라이언트로 보낼 방 스냅샷 (참가자별/호스트 연결 상태 포함)
  function snapshot(room) {
    const players = []
    for (const dev of room.devices.values()) {
      for (const p of dev.players) players.push({ ...p, online: dev.online !== false })
    }
    return {
      code: room.code,
      hostId: room.hostId,
      screen: room.screen,
      players,
      deviceCount: [...room.devices.values()].filter((d) => d.online !== false).length,
      hostOnline: room.devices.get(room.hostId)?.online !== false,
    }
  }

  return { rooms, create, join, leave, addPlayer, removePlayer, setScreen, setOnline, findRoomByDevice, allPlayers, snapshot }
}

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase()
}
