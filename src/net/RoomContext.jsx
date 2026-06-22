import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoomClient } from './RoomClient.js'

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

  const [status, setStatus] = useState('connecting') // 'connecting' | 'in' | 'closed' | 'error'
  const [room, setRoom] = useState(null)
  const [notice, setNotice] = useState(null) // 서버 에러/안내 토스트
  const [reconnecting, setReconnecting] = useState(false) // 끊겨서 재연결 시도 중

  useEffect(() => {
    const offs = [
      client.on('open', () => {
        if (intent.kind === 'create') client.createRoom()
        else client.joinRoom(intent.code)
      }),
      client.on('room', ({ room }) => {
        setRoom(room)
        setStatus('in')
        // 재연결로 방이 복구되면 "재연결 중" 안내를 거둔다.
        setReconnecting((wasReconnecting) => {
          if (wasReconnecting) setNotice(null)
          return false
        })
      }),
      client.on('error', ({ message }) => {
        setNotice(message)
        // 아직 방에 못 들어간 상태의 에러(없는 코드 등)는 실패로 처리
        setStatus((s) => (s === 'connecting' ? 'error' : s))
      }),
      client.on('closed', ({ reason }) => {
        setNotice(reason)
        setStatus('closed')
      }),
      // 끊겼지만 아직 포기 전 — 게임/로비는 그대로 두고 안내만 띄운다.
      client.on('reconnecting', () => {
        setReconnecting(true)
        setNotice('연결이 끊겼어요. 다시 연결 중이에요…')
      }),
      // 소켓은 다시 열렸다(hello 전송됨). 곧 올 room 스냅샷을 기다린다.
      client.on('reopen', () => {}),
      client.on('disconnect', () => {
        setReconnecting(false)
        setNotice('서버와 연결이 끊어졌어요.')
        setStatus('closed')
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

  // 안내 토스트 자동 닫기 (재연결 중에는 계속 보여준다)
  useEffect(() => {
    if (!notice || status !== 'in' || reconnecting) return
    const t = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(t)
  }, [notice, status, reconnecting])

  const value = useMemo(() => {
    const isHost = room && room.hostId === client.deviceId
    return {
      status,
      room,
      notice,
      reconnecting,
      deviceId: client.deviceId,
      isHost: !!isHost,
      addPlayer: client.addPlayer,
      removePlayer: client.removePlayer,
      setScreen: client.setScreen,
      leaveRoom: () => {
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
            // 실시간 게임(④ 서버 권위): 바이너리 스냅샷 구독 + 시작/입력/액션
            subscribeSnapshot: (fn) => client.on('rt', (bytes) => fn(bytes)),
            rtStart: client.rtStart,
            rtStop: client.rtStop,
            rtPause: client.rtPause,
            rtInput: client.rtInput,
            rtAction: client.rtAction,
          }
        : null,
    }
  }, [status, room, notice, reconnecting, client, onLeft])

  return <RoomCtx.Provider value={value}>{children}</RoomCtx.Provider>
}
