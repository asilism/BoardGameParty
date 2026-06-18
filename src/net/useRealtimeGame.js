import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodeSnapshot } from './realtime/codec.js'
import { racerIdFor } from './realtime/roster.js'

// 실시간 게임용 공통 동기화 훅 (④ 서버 권위 + ① 예측/화해 + ③ 보간 + ② 바이너리 델타).
//
//  - 서버가 권위 스냅샷을 바이너리 델타로 보낸다 → 누적 디코드해 view로 노출.
//  - 남의 엔티티: INTERP_DELAY 지연 버퍼로 보간(부드럽게).
//  - 내 엔티티: 입력을 "즉시" 반영(예측)하고, 권위 스냅샷이 오면 부드럽게 보정 →
//      내 조작 지연(왕복 RTT + 보간 지연)이 사라져 즉각 반응한다.
//  - 입력은 변했을 때만 INPUT_MS 주기로 서버에 보낸다.
//
// 게임은 adapter(netgame.js)와 입력 ref(ctrlRef)만 넘기면 된다. 다른 게임도 동일.
const INTERP_DELAY = 110 // 남의 엔티티 보간 지연(ms)
const INPUT_MS = 66 // 입력 전송 주기(ms)
const EASE = 0.22 // 예측 → 권위 보정 강도(프레임당)
const SNAP_DIST = 14 // 이 이상 어긋나면(리스폰/순간이동) 즉시 맞춘다

function angLerp(a, b, f) {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * f
}

export function useRealtimeGame(net, adapter, ctrlRef) {
  const isHost = !!net?.isHost
  const myId = useMemo(() => (net ? racerIdFor(net.players, net.deviceId) : null), [net])

  const [view, setView] = useState(null) // 최신 권위 스냅샷(HUD/phase/사운드용)
  const bufRef = useRef([]) // 보간 버퍼 [{at, v}]
  const lastViewRef = useRef(null) // 델타 누적 기준(서버 lastView와 일치)
  const predRef = useRef(null) // 내 엔티티 예측 위치 {x,z,ang}
  const lastFrameRef = useRef(0)
  const lastStatusRef = useRef(null)
  const lastSentRef = useRef('')

  // ── 스냅샷 수신: 바이너리 델타 → 누적 디코드 ──
  useEffect(() => {
    if (!net?.subscribeSnapshot) return undefined
    return net.subscribeSnapshot((bytes) => {
      let v
      try {
        v = decodeSnapshot(lastViewRef.current, bytes)
      } catch {
        return // 깨진 프레임은 무시(다음 full로 복구)
      }
      lastViewRef.current = v
      if (v.phase === 'play') {
        bufRef.current.push({ at: performance.now(), v })
        if (bufRef.current.length > 16) bufRef.current.shift()
      } else {
        bufRef.current = []
        predRef.current = null
      }
      setView(v)
    })
  }, [net])

  // 새 판(카운트다운) 시작 시 예측/입력 추적을 깨끗이 비운다
  useEffect(() => {
    const st = view?.status
    if (st === 'countdown' && lastStatusRef.current !== 'countdown') {
      predRef.current = null
      lastSentRef.current = ''
    }
    lastStatusRef.current = st ?? null
  }, [view])

  // ── 입력 전송: 변했을 때만 INPUT_MS 주기로 ──
  useEffect(() => {
    if (!net?.rtInput || !myId || !ctrlRef) return undefined
    const t = setInterval(() => {
      const sig = adapter.inputSig(ctrlRef.current)
      if (sig === lastSentRef.current) return
      lastSentRef.current = sig
      net.rtInput(adapter.readInput(ctrlRef.current))
    }, INPUT_MS)
    return () => clearInterval(t)
  }, [net, myId, adapter, ctrlRef])

  // ── 렌더용 view: 남은 보간 + 내 엔티티 예측 ──
  const sample = useCallback(() => {
    const buf = bufRef.current
    if (!buf.length) return null
    const base = adapter.interpolate(buf, performance.now() - INTERP_DELAY)
    if (!base || base.phase !== 'play' || !myId) return base
    // 일시정지 중엔 내 영웅도 멈춰 있어야 한다 — 예측을 건너뛰고 권위 위치 그대로.
    if (base.paused) return base

    const latest = buf[buf.length - 1].v
    const list = latest[adapter.localKey]
    const authMe = list && list.find((e) => e.id === myId)
    if (!authMe) {
      predRef.current = null
      return base
    }

    const now = performance.now()
    let dt = (now - lastFrameRef.current) / 1000
    lastFrameRef.current = now
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60

    const af = adapter.angleField
    let pred = predRef.current
    if (!pred) pred = predRef.current = { x: authMe.x, z: authMe.z, ang: authMe[af] }

    adapter.predictLocal(pred, ctrlRef.current, authMe, dt) // 입력 즉시 반영
    // 권위값으로 보정 — 멀면 스냅, 가까우면 부드럽게
    const dx = authMe.x - pred.x
    const dz = authMe.z - pred.z
    if (Math.hypot(dx, dz) > SNAP_DIST) {
      pred.x = authMe.x
      pred.z = authMe.z
      pred.ang = authMe[af]
    } else {
      pred.x += dx * EASE
      pred.z += dz * EASE
      pred.ang = angLerp(pred.ang, authMe[af], EASE)
    }

    const meRender = { ...authMe, x: pred.x, z: pred.z, [af]: pred.ang }
    const merged = base[adapter.localKey].map((e) => (e.id === myId ? meRender : e))
    return { ...base, [adapter.localKey]: merged }
  }, [adapter, myId, ctrlRef])

  const start = useCallback((config) => net?.rtStart?.(config), [net])
  const stop = useCallback(() => net?.rtStop?.(), [net])
  const pause = useCallback((paused) => net?.rtPause?.(paused), [net])
  const sendAction = useCallback((action) => net?.rtAction?.(action), [net])

  return { view, sample, myId, isHost, start, stop, pause, sendAction }
}
