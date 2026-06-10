import { useEffect, useRef, useState } from 'react'
import ThrillSetup from './ThrillSetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import {
  createGame,
  scoreRound,
  applyRoundScores,
  winners,
  randomDuration,
  TRAVEL_MS,
} from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote } from '../../net/NetParts.jsx'

const READY_MS = 1000
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const lerp = (a, b, t) => a + (b - a) * t

// 좌표(% of arena)
const HOLE = { x: 50, y: 22 } // 블랙홀(폭탄 회전) 중심
const DISC = { rx: 19, ry: 14 } // 블랙홀 디스크 반지름(가로%/세로%) → 타원
const ORX = DISC.rx - 4 // 폭탄 궤도 가로 반지름(디스크 안쪽)
const ORY = DISC.ry - 4 // 폭탄 궤도 세로 반지름
const ENTRY = { x: 50, y: 44 } // 튜브 입구(블랙홀 아래)
const STACK_BOTTOM = 86 // 맨 아래 공 중심 y%
// 공 간격 = 공 지름(var(--ballh))의 0.92배 → 살짝 겹쳐 실제로 쌓인 것처럼 딱 붙음
const slotY = (k) => `calc(${STACK_BOTTOM}% - ${(k * 0.92).toFixed(3)} * var(--ballh))`
const CORNERS = {
  tl: { x: 13, y: 32 },
  tr: { x: 87, y: 32 },
  bl: { x: 13, y: 84 },
  br: { x: 87, y: 84 },
}
const SEATS = { 1: ['bl'], 2: ['bl', 'br'], 3: ['bl', 'br', 'tl'], 4: ['bl', 'br', 'tl', 'tr'] }

// 폭탄: 완만하게 ~10바퀴 돌며 내려오다, 막판에 오일러 디스크처럼 급가속 + 여러 번 튀기며 중앙 구멍으로 쏙.
const EULER_TURNS = 10
const BOUNCES = 6
function bombOrbit(p) {
  const c = clamp01(p)
  const env = 1 - c // 반지름 외곽선: 선형(완만) 강하 → 천천히 안으로
  // 막판으로 갈수록 강해지는 감쇠 튀김(오일러 disk rattle)
  const bounce = 1 - 0.35 * c * Math.abs(Math.sin(Math.pow(c, 1.6) * BOUNCES * Math.PI))
  const k = env * bounce
  const turns = 0.45 * c + 0.55 * Math.pow(c, 3) // 각속도: 막판 급가속
  const ang = -Math.PI / 2 + turns * EULER_TURNS * Math.PI * 2
  const scale = 1 - 0.2 * Math.pow(c, 3) // 살짝만 작아짐(원근감) → 최종 ≈ 0.8
  return { x: HOLE.x + ORX * k * Math.cos(ang), y: HOLE.y + ORY * k * Math.sin(ang), scale }
}

// 온라인 동기화(호스트 권위 + 로컬 시계):
//  - 호스트가 라운드 진행/채점을 결정하고 view(라운드 단계/폭탄 시각 T/누른 기록)를 publish.
//  - 폭탄 애니메이션은 각 기기가 "자기 화면에서 라운드가 시작된 순간"부터 자기 시계로 돌리고,
//    누른 시각(t)도 그 시계로 재서 보낸다 → 네트워크 지연이 있어도 보이는 대로 공평.
export default function ThrillGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [game, setGame] = useState(null)
  const [phase, setPhase] = useState('setup')
  const [roundPhase, setRoundPhase] = useState('ready')
  const [elapsed, setElapsed] = useState(0)
  const [pressed, setPressed] = useState({})
  const [soundOn, setSoundOn] = useState(true)

  const durRef = useRef(0)
  const startRef = useRef(0)
  const pressRef = useRef({})
  const rafRef = useRef(0)
  const droppedRef = useRef(false)
  const readyTimerRef = useRef(null)
  const roundPhaseRef = useRef('ready')
  roundPhaseRef.current = roundPhase

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(readyTimerRef.current)
    },
    []
  )

  // 게스트 입력(호스트에서만 호출). 자기 참가자만, 게스트 시계로 잰 t를 기록.
  function handleAction(a, fromDevice) {
    if (a.type !== 'press') return
    if (ownerDevice(a.id) !== fromDevice) return
    const t = Math.round(Number(a.t))
    if (t >= 0) recordPress(a.id, t)
  }

  // 호스트 → 게스트 상태 전파 (elapsed는 보내지 않는다 — 각자 자기 시계로 돌린다)
  useEffect(() => {
    if (!online || !isHost) return
    if (phase !== 'play' || !game) {
      publish({ phase: 'setup' })
      return
    }
    publish({
      phase: 'play',
      players: game.players,
      round: game.round,
      rounds: game.rounds,
      status: game.status,
      roundPhase,
      T: durRef.current || 3000,
      pressed,
    })
  }, [online, isHost, publish, phase, game, roundPhase, pressed])

  // 호스트가 게임 도중 새로고침 → 점수/라운드를 이어받는다.
  // 진행 중이던 라운드는 폭탄 시각을 알 수 없으므로 그 라운드를 처음부터 다시 시작.
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    setGame({ players: v.players, round: v.round, rounds: v.rounds, status: v.status })
    setPhase('play')
    if (v.status === 'finished') setRoundPhase('result')
    else beginRound()
  })

  function startGame() {
    sound.setEnabled(soundOn)
    const players = roster.slice(0, 4).map((p) => ({
      id: p.id,
      name: p.name,
      zodiacId: p.zodiacId,
      color: getZodiac(p.zodiacId)?.color,
    }))
    setGame(createGame(players))
    setPhase('play')
    beginRound()
  }

  function beginRound() {
    durRef.current = randomDuration()
    pressRef.current = {}
    droppedRef.current = false
    setPressed({})
    setElapsed(0)
    setRoundPhase('ready')
    clearTimeout(readyTimerRef.current)
    readyTimerRef.current = setTimeout(() => {
      startRef.current = Date.now()
      setRoundPhase('running')
    }, READY_MS)
  }

  useEffect(() => {
    if (roundPhase !== 'running') return
    let active = true
    const tick = () => {
      if (!active) return
      const e = Date.now() - startRef.current
      setElapsed(e)
      if (!droppedRef.current && e >= durRef.current) {
        droppedRef.current = true
        sound.chuteDown() // 폭탄이 쏙(쌓임)
      }
      if (e >= durRef.current + TRAVEL_MS + 250) {
        finalizeRound()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundPhase])

  // 누름 기록(호스트 로컬 탭 + 게스트 action 공용)
  function recordPress(id, t) {
    if (roundPhaseRef.current !== 'running') return
    if (pressRef.current[id] != null) return
    if (t >= durRef.current) return
    pressRef.current[id] = t
    setPressed({ ...pressRef.current })
    sound.step()
  }

  function press(id) {
    recordPress(id, Date.now() - startRef.current)
  }

  function finalizeRound() {
    const entries = game.players.map((p) => ({ id: p.id, pressAt: pressRef.current[p.id] ?? null }))
    const s = scoreRound(entries, durRef.current, TRAVEL_MS)
    setRoundPhase('result')
    const next = applyRoundScores(game, s.points)
    setGame(next)
    if (next.status === 'finished') setTimeout(() => sound.win(), 200)
  }

  function toggleSound() {
    const nx = !soundOn
    setSoundOn(nx)
    sound.setEnabled(nx)
    if (nx) sound.unlock()
  }

  // ── 게스트: 호스트 view + 자기 시계로 렌더 ──
  if (online && !isHost) {
    if (!remote || remote.phase !== 'play') {
      return <NetWaiting text="호스트가 폭탄에 불을 붙이고 있어요..." onExit={onExit} />
    }
    return (
      <ThrillRemoteView
        view={remote}
        canControl={canControl}
        sendAction={sendAction}
        onExit={onExit}
        soundOn={soundOn}
        onToggleSound={toggleSound}
      />
    )
  }

  if (phase === 'setup') {
    return <ThrillSetup roster={roster} onStart={startGame} onExit={onExit} />
  }

  const hostView = {
    players: game.players,
    round: game.round,
    rounds: game.rounds,
    status: game.status,
    roundPhase,
    T: durRef.current || 3000,
    pressed,
  }
  return (
    <ThrillArena
      view={hostView}
      elapsed={elapsed}
      canPress={(id) => !online || canControl(id)}
      onPress={press}
      onNext={beginRound}
      onRestart={startGame}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 라운드가 "내 화면"에서 시작된 순간부터 자기 시계로 폭탄을 돌린다.
function ThrillRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  const [elapsed, setElapsed] = useState(0)
  const startLocalRef = useRef(0)
  const droppedRef = useRef(false)
  const sentRef = useRef({})

  useEffect(() => {
    if (view.roundPhase === 'ready') {
      setElapsed(0)
      sentRef.current = {}
      droppedRef.current = false
      return
    }
    if (view.roundPhase === 'result') {
      // 최종 스택이 보이도록 라운드 끝 시점으로 고정
      setElapsed(view.T + TRAVEL_MS + 1000)
      return
    }
    // running: 자기 시계로 애니메이션
    startLocalRef.current = Date.now()
    droppedRef.current = false
    let active = true
    const tick = () => {
      if (!active) return
      const e = Date.now() - startLocalRef.current
      setElapsed(e)
      if (!droppedRef.current && e >= view.T) {
        droppedRef.current = true
        sound.chuteDown()
      }
      if (e < view.T + TRAVEL_MS + 600) rafRef = requestAnimationFrame(tick)
    }
    let rafRef = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafRef)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.roundPhase, view.round])

  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])

  function pressLocal(id) {
    if (view.roundPhase !== 'running') return
    if (view.pressed[id] != null || sentRef.current[id]) return
    const t = Date.now() - startLocalRef.current
    if (t >= view.T) return
    sentRef.current[id] = true
    sound.step()
    sendAction({ type: 'press', id, t })
  }

  return (
    <ThrillArena
      view={view}
      elapsed={elapsed}
      canPress={canControl}
      onPress={pressLocal}
      onNext={null}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 아레나 화면(호스트/게스트 공용). view + elapsed(각자 시계)만 보고 그린다.
function ThrillArena({ view, elapsed, canPress, onPress, onNext, onRestart, onExit, soundOn, onToggleSound }) {
  const { players, round, rounds, status, roundPhase, pressed } = view
  const T = view.T || 3000
  const finished = status === 'finished'
  const win = finished ? winners(view) : []
  const seats = SEATS[players.length] || SEATS[4]

  // 도착(파이프 진입) 정보
  const bombDropped = elapsed >= T
  // 폭탄이 떨어진 순간부터는 누름 시각이 확정 → 라운드 점수를 바로 계산해 표시
  const scored = bombDropped
    ? scoreRound(
        players.map((p) => ({ id: p.id, pressAt: pressed[p.id] ?? null })),
        T,
        TRAVEL_MS
      )
    : null
  const items = players
    .filter((p) => pressed[p.id] != null)
    .map((p) => ({ kind: 'player', id: p.id, color: p.color, arrival: pressed[p.id] + TRAVEL_MS }))
  items.push({ kind: 'bomb', id: '__bomb', arrival: T })
  const inPipe = items.filter((it) => elapsed >= it.arrival).sort((a, b) => a.arrival - b.arrival)
  const bombIdx = inPipe.findIndex((it) => it.kind === 'bomb')

  return (
    <div className="thrill">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        <div className="turn-indicator">
          {finished ? '🏁 게임 끝!' : `💣 ${round}/${rounds} 라운드`}
        </div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className="thrill__arena">
        {/* 각자 파이프(코너 → 튜브 입구) */}
        <svg className="thrill__pipes" viewBox="0 0 100 100" preserveAspectRatio="none">
          {players.map((p, i) => {
            const c = CORNERS[seats[i] || 'bl']
            return (
              <line
                key={p.id}
                x1={c.x}
                y1={c.y}
                x2={ENTRY.x}
                y2={ENTRY.y}
                stroke={p.color}
                strokeWidth="3.2"
                strokeLinecap="round"
                opacity="0.5"
              />
            )
          })}
        </svg>

        {/* 중앙 세로 튜브 */}
        <div
          className="thrill__tube"
          style={{ left: `${ENTRY.x}%`, top: `${ENTRY.y}%`, height: `${STACK_BOTTOM + 5 - ENTRY.y}%` }}
        />

        {/* 블랙홀(아래가 살짝 뾰족한 깔때기, 폭탄 전용) */}
        <div
          className="thrill__blackhole"
          style={{
            left: `${HOLE.x}%`,
            top: `${HOLE.y}%`,
            width: `${DISC.rx * 2}%`,
            height: `${DISC.ry * 2}%`,
          }}
        />
        {/* 가운데 실제 구멍(공 크기 + 약간 여유로 고정) */}
        <div className="thrill__hole" style={{ left: `${HOLE.x}%`, top: `${HOLE.y}%` }} />

        {/* 폭탄: 도착 전 블랙홀에서 회전 */}
        {!bombDropped &&
          (() => {
            const o = bombOrbit(elapsed / T)
            return (
              <div
                className="thrill-bomb"
                style={{ left: `${o.x}%`, top: `${o.y}%`, transform: `translate(-50%, -50%) scale(${o.scale})` }}
              >
                💣
              </div>
            )
          })()}

        {/* 파이프로 이동 중인 플레이어 공 */}
        {players.map((p, i) => {
          const pa = pressed[p.id]
          if (pa == null) return null
          const tp = (elapsed - pa) / TRAVEL_MS
          if (tp >= 1) return null // 도착 → 스택에서 렌더
          const c = CORNERS[seats[i] || 'bl']
          const x = lerp(c.x, ENTRY.x, tp)
          const y = lerp(c.y, ENTRY.y, tp)
          return (
            <span
              key={p.id}
              className="thrill-ball thrill-ball--rolling"
              style={{ left: `${x}%`, top: `${y}%`, '--z-color': p.color }}
            />
          )
        })}

        {/* 튜브에 쌓인 공들(도착 순서대로) */}
        {inPipe.map((it, k) => {
          const y = slotY(k)
          if (it.kind === 'bomb') {
            return (
              <div key="__bomb" className="thrill-bomb thrill-bomb--stacked" style={{ left: `${ENTRY.x}%`, top: y }}>
                💣
              </div>
            )
          }
          const disq = bombIdx >= 0 && k > bombIdx // 폭탄보다 위(늦음) → 실격
          return (
            <span
              key={it.id}
              className={`thrill-ball thrill-ball--stacked ${disq ? 'is-disq' : ''}`}
              style={{ left: `${ENTRY.x}%`, top: y, '--z-color': it.color }}
            />
          )
        })}

        {/* 폭탄 낙하 순간, 파이프 옆에 각 공의 라운드 점수 표시 */}
        {scored &&
          inPipe.map((it, k) => {
            if (it.kind === 'bomb') return null
            const row = scored.rows.find((r) => r.id === it.id)
            const ok = row && !row.busted
            const pl = players.find((p) => p.id === it.id)
            const z = pl && getZodiac(pl.zodiacId)
            return (
              <div
                key={`s-${it.id}`}
                className={`thrill-pipescore ${ok ? 'ok' : 'bust'}`}
                style={{ left: `${ENTRY.x + 9}%`, top: slotY(k), '--z-color': it.color }}
              >
                <span className="thrill-pipescore__who">
                  {z?.emoji} {pl?.name}
                </span>
                <span className="thrill-pipescore__pt">{ok ? `+${scored.points[it.id]}` : '실격'}</span>
              </div>
            )
          })}

        {/* 코너 버튼(스테이션) — 아레나 좌표계 안에서 파이프 시작점과 정렬 */}
        {players.map((p, i) => {
          const z = getZodiac(p.zodiacId)
          const c = CORNERS[seats[i] || 'bl']
          const done = pressed[p.id] != null
          const mine = canPress(p.id)
          return (
            <button
              key={p.id}
              className={`thrill-station ${done ? 'is-done' : ''} ${!mine ? 'thrill-station--other' : ''}`}
              style={{ left: `${c.x}%`, top: `${c.y}%`, '--z-color': p.color }}
              disabled={roundPhase !== 'running' || done || !mine}
              onPointerDown={() => mine && onPress(p.id)}
            >
              <span className="thrill-station__emoji">{z?.emoji}</span>
              <span className="thrill-station__name">{p.name}</span>
              <span className="thrill-station__score">{p.score}점</span>
            </button>
          )
        })}

        {roundPhase === 'ready' && <div className="thrill__banner">준비… 💣</div>}
      </div>

      {roundPhase === 'running' && !bombDropped && (
        <div className="thrill__hint">폭탄보다 늦지 않게! 폭탄 바로 아래에 쌓일수록 고득점 ⏱️</div>
      )}
      {roundPhase === 'result' && !finished && (
        <div className="thrill__next">
          {onNext ? (
            <button className="btn btn--primary" onClick={onNext}>
              다음 라운드 →
            </button>
          ) : (
            <p className="net-guest-note">🌐 호스트가 다음 라운드를 시작해요</p>
          )}
        </div>
      )}

      {finished && (
        <div className="win-modal">
          <Fireworks />
          <div className="win-modal__card" style={{ '--z-color': win[0]?.color }}>
            <div className="win-modal__emoji">🏆</div>
            {win.length > 1 ? (
              <>
                <h2>공동 우승! 🎉</h2>
                <p>{win.map((p) => p.name).join(', ')} · {win[0].score}점</p>
              </>
            ) : (
              <>
                <h2>{win[0]?.name} 우승! 🎉</h2>
                <p>{win[0]?.score}점으로 1등!</p>
              </>
            )}
            <div className="win-modal__btns">
              {onRestart ? (
                <>
                  <button className="btn btn--primary" onClick={onRestart}>
                    다시하기
                  </button>
                  <button className="btn btn--ghost" onClick={onExit}>
                    로비로
                  </button>
                </>
              ) : (
                <>
                  <GuestRestartNote />
                  <button className="btn btn--ghost" onClick={onExit}>
                    방 나가기
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
