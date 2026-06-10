// 온라인 방 WebSocket 클라이언트.
// 서버 메시지(room/state/action/error/closed)를 구독자에게 전달하는 얇은 래퍼.
// React 쪽은 RoomContext가 이걸 감싸서 상태로 노출한다.

const DEVICE_KEY = 'bgp.deviceId.v1'

// 기기 식별자: 한 번 만들어 localStorage에 보관 → 새로고침해도 같은 기기로 인식
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = `dev-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return `dev-${Math.random().toString(36).slice(2, 10)}`
  }
}

// 서버 주소: 같은 호스트의 /ws (개발 중엔 vite가 8787로 프록시)
export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

// 첫 접속이 이만큼 연달아 실패하면 그제야 실패로 알린다
// (서버가 막 깨어나는 중 등 일시 실패는 "접속 중..."인 채로 조용히 재시도)
const FIRST_CONNECT_TRIES = 5

export function createRoomClient({ url = wsUrl(), deviceId = getDeviceId() } = {}) {
  let ws = null
  let closedByUser = false
  let everOpened = false // 한 번이라도 접속에 성공했는지
  let failStreak = 0 // 연속 실패 횟수(재시도 간격 계산용)
  let retryTimer = null
  let roomCode = null // 현재 들어가 있는 방 코드(재접속 시 hello에 실어 보냄)
  const listeners = new Map() // type -> Set<fn>

  const emit = (type, payload) => {
    const set = listeners.get(type)
    if (set) [...set].forEach((fn) => fn(payload))
  }

  function connect() {
    closedByUser = false
    ws = new WebSocket(url)
    ws.onopen = () => {
      everOpened = true
      failStreak = 0
      // 방에 있던 중 끊겼다면 서버가 hello만으로 방/게임 상태를 복구해 준다
      send({ t: 'hello', deviceId, room: roomCode })
      emit('open')
    }
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.t === 'room') roomCode = msg.room?.code || null
      if (msg.t === 'closed') roomCode = null
      emit(msg.t, msg)
    }
    ws.onclose = () => {
      if (closedByUser) return
      failStreak++
      if (!everOpened && failStreak >= FIRST_CONNECT_TRIES) {
        emit('fail') // 첫 접속 자체가 안 됨 → 그만 시도하고 실패 화면
        return
      }
      if (everOpened) emit('reconnecting') // 쓰던 중 끊김 → 무한 재시도
      retryTimer = setTimeout(connect, Math.min(700 * 2 ** (failStreak - 1), 8000))
    }
    ws.onerror = () => {}
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function close() {
    closedByUser = true
    clearTimeout(retryTimer)
    try {
      ws?.close()
    } catch {
      /* 무시 */
    }
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type)?.delete(fn)
  }

  return {
    deviceId,
    connect,
    close,
    on,
    createRoom: () => send({ t: 'create' }),
    joinRoom: (code) => send({ t: 'join', code }),
    leaveRoom: () => {
      roomCode = null
      send({ t: 'leave' })
    },
    addPlayer: (player) => send({ t: 'addPlayer', player }),
    removePlayer: (playerId) => send({ t: 'removePlayer', playerId }),
    setScreen: (screen) => send({ t: 'setScreen', screen }),
    sendState: (data) => send({ t: 'state', data }),
    sendAction: (data) => send({ t: 'action', data }),
  }
}
