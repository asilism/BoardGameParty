import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoomClient } from './RoomClient.js'
import { saveSession, clearSession } from '../shared/storage.js'

// 온라인 방 상태를 앱 전체에 제공하는 컨텍스트.
//  - 방 스냅샷(room): 코드/호스트/참가자/현재 화면 — 서버가 관리
//  - 게임 state/action 채널: 게임 컴포넌트가 useGameNet으로 직접 구독
const RoomCtx = createContext(null)

export function useRoom() {
  return useContext(RoomCtx)
}

// intent: { kind: 'create' } | { kind: 'join', code }
export function RoomProvider({ intent, onLeft, children }) {
  const clientRef = useRef(null)
  if (!clientRef.current) clientRef.current = createRoomClient()
  const client = clientRef.current

  // 'connecting'  : 첫 접속/방 입장 시도 중
  // 'in'          : 방에 들어와 있음
  // 'reconnecting': 쓰던 중 끊김 → 자동 재접속 중 (방 정보는 유지)
  // 'error'/'closed': 실패/방 닫힘 → 처음으로 돌아가야 함
  const [status, setStatus] = useState('connecting')
  const statusRef = useRef('connecting')
  const setStat = (v) => {
    statusRef.current = v
    setStatus(v)
  }
  const [room, setRoom] = useState(null)
  const [notice, setNotice] = useState(null) // { text, tone: 'warn' | 'info' }
  const everInRoom = useRef(false)
  // 서버가 보내준 마지막 게임 상태. 게임 컴포넌트가 마운트되기 전에 도착해도
  // 잃어버리지 않게 여기 보관한다 (게스트 미러링 초기값 + 호스트 새로고침 복구용).
  const gameStateRef = useRef(null)
  const screenSeenRef = useRef(null)

  useEffect(() => {
    const offs = [
      client.on('open', () => {
        // 재접속이면 서버가 hello만으로 방을 복구하므로 다시 만들거나 참여하지 않는다
        if (everInRoom.current) return
        if (intent.kind === 'create') client.createRoom()
        else client.joinRoom(intent.code)
      }),
      client.on('room', ({ room }) => {
        everInRoom.current = true
        saveSession(room.code) // 튕겨도 다시 켜면 이 방으로 복귀
        if (room.screen !== screenSeenRef.current) {
          screenSeenRef.current = room.screen
          gameStateRef.current = null // 화면이 바뀜 → 이전 게임 상태는 폐기
        }
        setRoom(room)
        if (statusRef.current === 'reconnecting') setNotice({ text: '🔌 다시 연결됐어요!', tone: 'info' })
        setStat('in')
      }),
      client.on('error', ({ message }) => {
        setNotice({ text: message, tone: 'warn' })
        // 아직 방에 못 들어간 상태의 에러(없는 코드 등)는 실패로 처리
        if (statusRef.current === 'connecting') {
          clearSession()
          setStat('error')
        }
      }),
      client.on('closed', ({ reason }) => {
        clearSession()
        setNotice({ text: reason, tone: 'warn' })
        setStat('closed')
      }),
      client.on('state', ({ data }) => {
        gameStateRef.current = data
      }),
      client.on('reconnecting', () => {
        // 방에 있다가 끊긴 경우만. (첫 접속 재시도는 'connecting' 그대로 둔다)
        if (statusRef.current === 'in') setStat('reconnecting')
      }),
      client.on('fail', () => {
        setNotice({ text: '서버에 연결할 수 없어요. 네트워크를 확인하고 다시 시도해 주세요.', tone: 'warn' })
        setStat('error')
      }),
    ]
    client.connect()
    return () => {
      offs.forEach((off) => off())
      client.close()
    }
    // intent는 마운트 시 한 번만 사용
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // 안내 토스트 자동 닫기
  useEffect(() => {
    if (!notice || status !== 'in') return
    const t = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(t)
  }, [notice, status])

  const value = useMemo(() => {
    const isHost = room && room.hostId === client.deviceId
    return {
      status,
      room,
      notice,
      deviceId: client.deviceId,
      isHost: !!isHost,
      addPlayer: client.addPlayer,
      removePlayer: client.removePlayer,
      setScreen: client.setScreen,
      leaveRoom: () => {
        clearSession()
        client.leaveRoom()
        onLeft?.()
      },
      // 게임 컴포넌트에 내려줄 네트워크 핸들 (useGameNet이 사용)
      net: room
        ? {
            online: true,
            isHost: !!isHost,
            deviceId: client.deviceId,
            players: room.players,
            sendState: client.sendState,
            sendAction: client.sendAction,
            subscribeState: (fn) => client.on('state', ({ data }) => fn(data)),
            subscribeAction: (fn) => client.on('action', ({ data, deviceId }) => fn(data, deviceId)),
            // 재접속 완료 시점 구독(호스트가 최신 상태를 다시 쏘는 용도)
            subscribeOpen: (fn) => client.on('open', fn),
            // 구독 전에 이미 도착해 있던 마지막 게임 상태
            getLastState: () => gameStateRef.current,
          }
        : null,
    }
  }, [status, room, notice, client, onLeft])

  return <RoomCtx.Provider value={value}>{children}</RoomCtx.Provider>
}
