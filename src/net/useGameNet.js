import { useCallback, useEffect, useRef, useState } from 'react'

// 게임 컴포넌트용 동기화 훅 (호스트 권위 모델).
//
//  - 오프라인(net=null): online=false, isHost=true → 게임은 기존 핫시트 그대로 동작.
//  - 온라인 호스트: 게임 로직(타이머/랜덤/판정)을 전부 돌리고,
//      publish(view)로 "그릴 수 있는 직렬화 상태"를 모두에게 전파하며
//      게스트 입력은 onAction(action, fromDeviceId)으로 받는다.
//  - 온라인 게스트: remote(호스트가 publish한 최신 상태)로 화면을 그리고,
//      입력은 sendAction으로 호스트에게 보낸다.
//
//  canControl(playerId): 이 기기가 조작할 수 있는 참가자인지.
//   (오프라인이면 전부, 온라인이면 이 기기에서 등록한 참가자만)
//
//  resume: 호스트 전용. 서버는 호스트에게 보통 state를 보내지 않으므로,
//   호스트가 state를 받았다는 건 "새로고침/재접속 복구" 시점뿐이다.
//   게임은 useHostResume으로 이 스냅샷에서 진행 상황을 복원한다.
export function useGameNet(net, onAction) {
  const online = !!net?.online
  const isHost = !online || net.isHost
  // 구독을 걸기 전에 이미 도착한 상태도 초기값으로 줍는다(마운트 타이밍 경쟁 방지)
  const [remote, setRemote] = useState(() => (online && !isHost && net.getLastState?.()) || null)
  const [resume, setResume] = useState(() => (online && isHost && net.getLastState?.()) || null)

  const handlerRef = useRef(onAction)
  handlerRef.current = onAction
  const lastViewRef = useRef(null) // 호스트가 마지막으로 publish한 상태(재접속 시 재전송용)

  useEffect(() => {
    if (!online) return
    if (isHost) {
      const offAction = net.subscribeAction((a, from) => handlerRef.current?.(a, from))
      const offState = net.subscribeState(setResume) // 복구 스냅샷(위 주석 참고)
      // 호스트가 잠깐 끊겼다 돌아오면 끊긴 동안의 변화를 모두에게 다시 보낸다
      const offOpen = net.subscribeOpen?.(() => {
        if (lastViewRef.current != null) net.sendState(lastViewRef.current)
      })
      return () => {
        offAction?.()
        offState?.()
        offOpen?.()
      }
    }
    return net.subscribeState(setRemote)
  }, [online, isHost, net])

  const publish = useCallback(
    (view) => {
      if (!online || !isHost) return
      lastViewRef.current = view
      net.sendState(view)
    },
    [online, isHost, net]
  )

  const sendAction = useCallback(
    (action) => {
      if (online && !isHost) net.sendAction(action)
    },
    [online, isHost, net]
  )

  const canControl = useCallback(
    (playerId) => {
      if (!online) return true
      const p = net.players.find((pl) => pl.id === playerId)
      return !!p && p.deviceId === net.deviceId
    },
    [online, net]
  )

  // 호스트가 입력(action)을 적용하기 전 소유권 검증용
  const ownerDevice = useCallback(
    (playerId) => (online ? net.players.find((pl) => pl.id === playerId)?.deviceId : null),
    [online, net]
  )

  return { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice }
}

// 호스트 새로고침 복구: 서버가 보관하던 마지막 view로 게임을 한 번만 복원한다.
//  - canApply(): 아직 게임을 시작하지 않은 상태(설정 화면)일 때만 true를 반환할 것.
//    (게임이 이미 돌고 있는 중의 단순 재접속에는 적용하지 않기 위함)
//  - apply(view): 게임별 복원 로직. view는 그 게임이 publish하던 형태 그대로.
export function useHostResume(resume, canApply, apply) {
  const doneRef = useRef(false)
  const fnRef = useRef(null)
  fnRef.current = { canApply, apply }
  useEffect(() => {
    if (doneRef.current || !resume || resume.phase !== 'play') return
    if (!fnRef.current.canApply()) return
    doneRef.current = true
    fnRef.current.apply(resume)
  }, [resume])
}
