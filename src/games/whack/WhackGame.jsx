import { useEffect, useRef, useState } from 'react'
import WhackSetup from './WhackSetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import { createGame, whack, winners, DURATION_MS, HOLES } from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote } from '../../net/NetParts.jsx'

const POP_MIN = 700
const POP_MAX = 1150

// 온라인 동기화(호스트 권위): 두더지 등장 타이밍/판정은 호스트가 굴리고
// 90ms 틱마다 view(구멍 상태 + 호스트 시계)를 publish. 게스트는 자기 칸만 두드린다.
export default function WhackGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'play'
  const [game, setGame] = useState(null)
  const [holes, setHoles] = useState({}) // `${pid}-${i}` -> upUntil(ms)
  const [now, setNow] = useState(0)
  const [timeLeft, setTimeLeft] = useState(Math.round(DURATION_MS / 1000))
  const [done, setDone] = useState(false)
  const [soundOn, setSoundOn] = useState(true)

  const endRef = useRef(0)
  const holesRef = useRef({})
  const tickRef = useRef(null)
  const spawnRef = useRef(null)
  const doneRef = useRef(false)
  doneRef.current = done

  function clearLoops() {
    clearInterval(tickRef.current)
    clearInterval(spawnRef.current)
  }
  useEffect(() => clearLoops, [])

  // 게스트 입력(호스트에서만 호출). 자기 참가자 칸만 인정.
  function handleAction(a, fromDevice) {
    if (a.type !== 'hit') return
    if (ownerDevice(a.pid) !== fromDevice) return
    hit(a.pid, Number(a.i))
  }

  // 호스트 → 게스트 화면 상태 전파 (now가 90ms마다 갱신되므로 같이 흘러간다)
  useEffect(() => {
    if (!online || !isHost) return
    if (phase !== 'play' || !game) {
      publish({ phase: 'setup' })
      return
    }
    publish({ phase: 'play', players: game.players, holes, now, timeLeft, done })
  }, [online, isHost, publish, phase, game, holes, now, timeLeft, done])

  // 호스트가 게임 도중 새로고침 → 점수/남은 시간을 이어받아 라운드 재개
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    setGame({ players: v.players, status: 'playing' })
    if (v.done) {
      setPhase('play')
      setDone(true)
      setHoles({})
      setNow(Date.now())
      setTimeLeft(0)
    } else {
      beginRun(v.players, Math.max(1, v.timeLeft) * 1000)
    }
  })

  function startGame() {
    sound.setEnabled(soundOn)
    const players = roster.map((p) => ({
      id: p.id,
      name: p.name,
      zodiacId: p.zodiacId,
      color: getZodiac(p.zodiacId)?.color,
    }))
    setGame(createGame(players))
    beginRun(players, DURATION_MS)
  }

  // 라운드 진행(시작/복구 공용): 타이머 + 두더지 등장 루프를 돌린다
  function beginRun(players, durationMs) {
    holesRef.current = {}
    setHoles({})
    setDone(false)
    setTimeLeft(Math.ceil(durationMs / 1000))
    setPhase('play')
    const start = Date.now()
    endRef.current = start + durationMs
    setNow(start)
    clearLoops()
    tickRef.current = setInterval(() => {
      const t = Date.now()
      setNow(t)
      setTimeLeft(Math.max(0, Math.ceil((endRef.current - t) / 1000)))
      if (t >= endRef.current) {
        clearLoops()
        setDone(true)
        setTimeout(() => sound.win(), 150)
      }
    }, 90)
    spawnRef.current = setInterval(() => {
      const t = Date.now()
      if (t >= endRef.current) return
      const h = { ...holesRef.current }
      players.forEach((p) => {
        if (Math.random() < 0.85) {
          const down = []
          for (let i = 0; i < HOLES; i++) if (!(h[`${p.id}-${i}`] > t)) down.push(i)
          if (down.length) {
            const i = down[Math.floor(Math.random() * down.length)]
            h[`${p.id}-${i}`] = t + POP_MIN + Math.random() * (POP_MAX - POP_MIN)
          }
        }
      })
      holesRef.current = h
      setHoles(h)
    }, 620)
  }

  function hit(pid, i) {
    if (doneRef.current) return
    const key = `${pid}-${i}`
    if (!(holesRef.current[key] > Date.now())) return // 두더지 없음 → 헛스윙
    holesRef.current = { ...holesRef.current, [key]: 0 }
    setHoles(holesRef.current)
    setGame((g) => whack(g, pid))
    sound.step()
  }

  function toggleSound() {
    const n = !soundOn
    setSoundOn(n)
    sound.setEnabled(n)
    if (n) sound.unlock()
  }

  // ── 게스트: 호스트 view 미러링 ──
  if (online && !isHost) {
    if (!remote || remote.phase !== 'play') {
      return <NetWaiting text="호스트가 두더지를 깨우고 있어요..." onExit={onExit} />
    }
    return (
      <WhackRemoteView
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
    return <WhackSetup roster={roster} onStart={startGame} onExit={onExit} />
  }

  const hostView = { players: game.players, holes, now, timeLeft, done }
  return (
    <WhackPlay
      view={hostView}
      canHit={(pid) => !online || canControl(pid)}
      onHit={hit}
      onRestart={startGame}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 자기 구역만 두드릴 수 있다.
function WhackRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  const totalScore = view.players.reduce((s, p) => s + p.score, 0)
  useEffect(() => {
    if (totalScore > 0) sound.step()
  }, [totalScore])
  useEffect(() => {
    if (view.done) sound.win()
  }, [view.done])

  return (
    <WhackPlay
      view={view}
      canHit={canControl}
      onHit={(pid, i) => sendAction({ type: 'hit', pid, i })}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 플레이 화면(호스트/게스트 공용). view만 보고 그린다.
function WhackPlay({ view, canHit, onHit, onRestart, onExit, soundOn, onToggleSound }) {
  const { players, holes, now, timeLeft, done } = view
  const win = done ? winners(view) : []

  return (
    <div className="whack">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        <div className="turn-indicator">{done ? '🏁 끝!' : `⏱️ ${timeLeft}초`}</div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className="whack__zones">
        {players.map((p) => {
          const z = getZodiac(p.zodiacId)
          const mine = canHit(p.id)
          return (
            <div
              className={`whack-zone ${!mine ? 'whack-zone--other' : ''}`}
              key={p.id}
              style={{ '--z-color': p.color }}
            >
              <div className="whack-zone__head">
                <span>{z?.emoji} {p.name}</span>
                <span className="whack-zone__score">{p.score}</span>
              </div>
              <div className="whack-grid">
                {Array.from({ length: HOLES }).map((_, i) => {
                  const up = holes[`${p.id}-${i}`] > now
                  return (
                    <button
                      key={i}
                      className={`whack-hole ${up ? 'is-up' : ''}`}
                      disabled={done || !mine}
                      onPointerDown={() => mine && onHit(p.id, i)}
                    >
                      <span className="whack-mole">🐹</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {done && (
        <div className="win-modal">
          <Fireworks />
          <div className="win-modal__card" style={{ '--z-color': win[0]?.color }}>
            <div className="win-modal__emoji">🏆</div>
            {win.length > 1 ? (
              <>
                <h2>공동 우승! 🎉</h2>
                <p>{win.map((p) => p.name).join(', ')} · {win[0].score}마리</p>
              </>
            ) : (
              <>
                <h2>{win[0]?.name} 우승! 🎉</h2>
                <p>{win[0]?.score}마리 잡았어요!</p>
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
