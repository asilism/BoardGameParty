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

export function createRoomClient({ url = wsUrl(), deviceId = getDeviceId() } = {}) {
  let ws = null
  let closedByUser = false
  const listeners = new Map() // type -> Set<fn>

  const emit = (type, payload) => {
    const set = listeners.get(type)
    if (set) [...set].forEach((fn) => fn(payload))
  }

  function connect() {
    closedByUser = false
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer' // 실시간 스냅샷은 바이너리 프레임으로 온다
    ws.onopen = () => {
      send({ t: 'hello', deviceId })
      emit('open')
    }
    ws.onmessage = (ev) => {
      // 바이너리 프레임 = 실시간 게임 스냅샷(델타/full). JSON 파싱하지 않고 그대로 넘긴다.
      if (typeof ev.data !== 'string') {
        emit('rt', new Uint8Array(ev.data))
        return
      }
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      emit(msg.t, msg)
    }
    ws.onclose = () => {
      if (!closedByUser) emit('disconnect')
    }
    ws.onerror = () => {}
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function close() {
    closedByUser = true
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
    leaveRoom: () => send({ t: 'leave' }),
    addPlayer: (player) => send({ t: 'addPlayer', player }),
    removePlayer: (playerId) => send({ t: 'removePlayer', playerId }),
    setScreen: (screen) => send({ t: 'setScreen', screen }),
    sendState: (data) => send({ t: 'state', data }),
    sendAction: (data) => send({ t: 'action', data }),
    // 실시간 게임(④ 서버 권위)
    rtStart: (config) => send({ t: 'rtStart', config }),
    rtStop: () => send({ t: 'rtStop' }),
    rtPause: (paused) => send({ t: 'rtPause', paused: !!paused }),
    rtInput: (input) => send({ t: 'rtInput', input }),
    rtAction: (action) => send({ t: 'rtAction', action }),
  }
}
