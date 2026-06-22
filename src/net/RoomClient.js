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

// 재연결 백오프(ms). 마지막 값을 한도까지 반복하다 포기한다.
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000, 10000]

export function createRoomClient({ url = wsUrl(), deviceId = getDeviceId() } = {}) {
  let ws = null
  let closedByUser = false
  let started = false // 첫 연결 성공 여부(이후 끊김은 재연결로 본다)
  let attempts = 0 // 연속 재연결 시도 횟수
  let reconnectTimer = null
  const listeners = new Map() // type -> Set<fn>

  const emit = (type, payload) => {
    const set = listeners.get(type)
    if (set) [...set].forEach((fn) => fn(payload))
  }

  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return
    if (attempts >= RECONNECT_DELAYS.length) {
      emit('disconnect') // 한도까지 시도했지만 실패 → 최종 끊김
      return
    }
    const delay = RECONNECT_DELAYS[attempts]
    attempts++
    emit('reconnecting', { attempt: attempts, delay })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!closedByUser) open()
    }, delay)
  }

  function open() {
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer' // 실시간 스냅샷은 바이너리 프레임으로 온다
    ws.onopen = () => {
      attempts = 0 // 성공했으니 백오프 초기화
      // hello가 서버의 유예 타이머를 취소하고 방을 복구해 준다(재연결 시).
      send({ t: 'hello', deviceId })
      if (!started) {
        started = true
        emit('open') // 첫 연결 → RoomProvider가 create/join 의도를 수행
      } else {
        emit('reopen') // 재연결 → 서버가 보내줄 room 스냅샷을 기다린다
      }
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
      // 의도치 않은 끊김은 바로 포기하지 않고 백오프로 재연결을 시도한다.
      if (!closedByUser) scheduleReconnect()
    }
    ws.onerror = () => {}
  }

  function connect() {
    closedByUser = false
    started = false
    attempts = 0
    open()
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function close() {
    closedByUser = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
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
