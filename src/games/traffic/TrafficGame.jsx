import { useEffect, useRef, useState } from 'react'
import TrafficSetup from './TrafficSetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import { createGame, roundWinner, applyRound, winners } from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote } from '../../net/NetParts.jsx'

const GO_WINDOW = 2500 // 초록불 후 응답 대기

// 온라인 동기화(호스트 권위): 라운드 타이밍/채점은 호스트가 굴린다.
// 반응시간(ms)은 각 게스트가 "자기 화면이 초록불로 바뀐 순간"부터 직접 재서 보내므로
// 네트워크 지연이 있어도 공평하다.
export default function TrafficGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'play'
  const [roundPhase, setRoundPhase] = useState('wait') // 'wait'(빨강) | 'go'(초록) | 'result'
  const [game, setGame] = useState(null)
  const [presses, setPresses] = useState({}) // id -> { ms } | { falseStart:true }
  const [roundWin, setRoundWin] = useState(undefined) // 라운드 승자 id | null
  const [soundOn, setSoundOn] = useState(true)

  const greenRef = useRef(0)
  const pressRef = useRef({})
  const timers = useRef([])
  const gameRef = useRef(null)
  const roundPhaseRef = useRef('wait')
  roundPhaseRef.current = roundPhase

  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }
  useEffect(() => clearTimers, [])

  // 게스트 입력(호스트에서만 호출). 자기 참가자만, 게스트가 잰 반응시간을 기록.
  function handleAction(a, fromDevice) {
    if (a.type !== 'press') return
    if (ownerDevice(a.id) !== fromDevice) return
    if (a.falseStart) recordPress(a.id, { falseStart: true })
    else {
      const ms = Math.round(Number(a.ms))
      if (ms >= 0 && ms < 60000) recordPress(a.id, { ms })
    }
  }

  // 호스트 → 게스트 화면 상태 전파
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
      presses,
      roundWin,
    })
  }, [online, isHost, publish, phase, game, roundPhase, presses, roundWin])

  // 호스트가 게임 도중 새로고침 → 점수/판을 이어받고, 진행 중이던 판은 다시 시작
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    const g = { players: v.players, round: v.round, rounds: v.rounds, status: v.status }
    gameRef.current = g
    setGame(g)
    setPhase('play')
    if (v.status === 'finished') {
      setRoundPhase('result')
      setRoundWin(null)
    } else {
      startRound()
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
    const g = createGame(players)
    gameRef.current = g
    setGame(g)
    setPhase('play')
    startRound()
  }

  function startRound() {
    clearTimers()
    pressRef.current = {}
    setPresses({})
    setRoundWin(undefined)
    setRoundPhase('wait')
    const delay = 1400 + Math.random() * 2600 // 빨강 유지 시간
    timers.current.push(
      setTimeout(() => {
        greenRef.current = Date.now()
        setRoundPhase('go')
        sound.ladderUp()
        timers.current.push(setTimeout(() => evaluate(), GO_WINDOW))
      }, delay)
    )
  }

  // 응답 기록(호스트 로컬 탭 + 게스트 action 공용). 전원 응답 시 즉시 채점.
  function recordPress(id, entry) {
    if (roundPhaseRef.current === 'result') return
    if (pressRef.current[id]) return // 이미 응답
    pressRef.current = { ...pressRef.current, [id]: entry }
    entry.falseStart ? sound.chuteDown() : sound.step()
    setPresses({ ...pressRef.current })
    if (gameRef.current.players.every((p) => pressRef.current[p.id])) evaluate()
  }

  function press(id) {
    if (roundPhaseRef.current === 'wait') recordPress(id, { falseStart: true })
    else if (roundPhaseRef.current === 'go') recordPress(id, { ms: Date.now() - greenRef.current })
  }

  function evaluate() {
    if (roundPhaseRef.current === 'result') return
    clearTimers()
    const g = gameRef.current
    const entries = g.players.map((p) => {
      const e = pressRef.current[p.id]
      return { id: p.id, ms: e?.ms ?? null, falseStart: !!e?.falseStart }
    })
    const wid = roundWinner(entries)
    setRoundWin(wid)
    const next = applyRound(g, wid)
    gameRef.current = next
    setGame(next)
    setRoundPhase('result')
    if (wid) setTimeout(() => sound.win(), 100)
  }

  function nextRound() {
    if (gameRef.current.status === 'finished') return
    startRound()
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
      return <NetWaiting text="호스트가 신호등을 켜고 있어요..." onExit={onExit} />
    }
    return (
      <TrafficRemoteView
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
    return <TrafficSetup roster={roster} onStart={startGame} onExit={onExit} />
  }

  const hostView = {
    players: game.players,
    round: game.round,
    rounds: game.rounds,
    status: game.status,
    roundPhase,
    presses,
    roundWin,
  }
  return (
    <TrafficPlay
      view={hostView}
      canPress={(id) => !online || canControl(id)}
      onPress={press}
      onNext={nextRound}
      onRestart={startGame}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 초록불이 "내 화면"에 뜬 순간부터 반응시간을 직접 잰다.
function TrafficRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  const greenAtRef = useRef(0)
  const sentRef = useRef({}) // 중복 전송 방지 (view 반영 전 연타)

  useEffect(() => {
    if (view.roundPhase === 'go') {
      greenAtRef.current = Date.now()
      sound.ladderUp()
    }
    if (view.roundPhase === 'wait') sentRef.current = {}
  }, [view.roundPhase, view.round])
  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])

  function pressLocal(id) {
    if (view.roundPhase === 'result') return
    if (view.presses[id] || sentRef.current[id]) return
    sentRef.current[id] = true
    if (view.roundPhase === 'wait') {
      sound.chuteDown()
      sendAction({ type: 'press', id, falseStart: true })
    } else {
      sound.step()
      sendAction({ type: 'press', id, ms: Date.now() - greenAtRef.current })
    }
  }

  return (
    <TrafficPlay
      view={view}
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

// 플레이 화면(호스트/게스트 공용). view만 보고 그린다.
function TrafficPlay({ view, canPress, onPress, onNext, onRestart, onExit, soundOn, onToggleSound }) {
  const { players, round, rounds, status, roundPhase, presses, roundWin } = view
  const finished = status === 'finished'
  const win = finished ? winners(view) : []
  const lightText =
    roundPhase === 'wait' ? '준비…' : roundPhase === 'go' ? '지금 눌러!' : roundWin ? '🏆' : '아무도!'

  return (
    <div className="traffic">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        <div className="turn-indicator">{finished ? '🏁 게임 끝!' : `🚦 ${round}/${rounds} 판`}</div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className="traffic__main">
        <div className={`traffic-light is-${roundPhase}`}>
          <span className="traffic-light__text">{lightText}</span>
        </div>
      </div>

      <div className="traffic__btns">
        {players.map((p) => {
          const z = getZodiac(p.zodiacId)
          const e = presses[p.id]
          const isWin = roundPhase === 'result' && roundWin === p.id
          const mine = canPress(p.id)
          let label = `${z?.emoji} ${p.name}`
          if (e?.falseStart) label = '❌ 부정출발'
          else if (e?.ms != null) label = `${e.ms}ms`
          if (isWin) label = `🏆 ${p.name}`
          return (
            <button
              key={p.id}
              className={`traffic-btn ${e?.falseStart ? 'is-bad' : ''} ${isWin ? 'is-win' : ''} ${
                !mine ? 'traffic-btn--other' : ''
              }`}
              style={{ '--z-color': p.color }}
              disabled={roundPhase === 'result' || !!presses[p.id] || !mine}
              onPointerDown={() => mine && onPress(p.id)}
            >
              {label}
            </button>
          )
        })}
      </div>

      {roundPhase === 'result' && !finished && (
        <div className="thrill__next">
          {onNext ? (
            <button className="btn btn--primary" onClick={onNext}>
              다음 판 →
            </button>
          ) : (
            <p className="net-guest-note">🌐 호스트가 다음 판을 시작해요</p>
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
                <p>{win.map((p) => p.name).join(', ')} · {win[0].score}판</p>
              </>
            ) : (
              <>
                <h2>{win[0]?.name} 우승! 🎉</h2>
                <p>{win[0]?.score}판 이겼어요!</p>
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
