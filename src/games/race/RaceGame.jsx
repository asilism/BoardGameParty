import { useEffect, useRef, useState } from 'react'
import RaceSetup from './RaceSetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import { createGame, tapRun, progress, ranking, winner } from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote } from '../../net/NetParts.jsx'

// 온라인 동기화(호스트 권위): 게스트의 연타가 action으로 들어오고
// 호스트가 진행률/순위를 계산해 view를 publish 한다.
export default function RaceGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'play'
  const [roundPhase, setRoundPhase] = useState('ready') // 'ready'(카운트다운) | 'run' | 'done'
  const [count, setCount] = useState(3) // 3,2,1,0(출발)
  const [game, setGame] = useState(null)
  const [soundOn, setSoundOn] = useState(true)
  const timers = useRef([])
  const roundPhaseRef = useRef('ready')
  roundPhaseRef.current = roundPhase

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // 게스트 연타 입력(호스트에서만 호출). 자기 참가자만 인정.
  function handleAction(a, fromDevice) {
    if (a.type !== 'tap') return
    if (ownerDevice(a.playerId) !== fromDevice) return
    tap(a.playerId)
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
      status: game.status,
      finishOrder: game.finishOrder,
      roundPhase,
      count,
    })
  }, [online, isHost, publish, phase, game, roundPhase, count])

  // 호스트가 게임 도중 새로고침 → 서버가 보관한 마지막 view로 이어가기
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    setGame({ players: v.players, finishOrder: v.finishOrder, status: v.status })
    setPhase('play')
    if (v.roundPhase === 'ready') beginCountdown()
    else {
      setCount(0)
      setRoundPhase(v.roundPhase)
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
    setPhase('play')
    beginCountdown()
  }

  function beginCountdown() {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setRoundPhase('ready')
    setCount(3)
    ;[1, 2].forEach((n) => {
      timers.current.push(setTimeout(() => { setCount(3 - n); sound.step() }, n * 800))
    })
    timers.current.push(
      setTimeout(() => {
        setCount(0) // 출발!
        sound.ladderUp()
        setRoundPhase('run')
      }, 3 * 800)
    )
  }

  function tap(id) {
    if (roundPhaseRef.current !== 'run') return
    setGame((g) => {
      const next = tapRun(g, id)
      if (next.status === 'finished' && g.status !== 'finished') {
        setRoundPhase('done')
        setTimeout(() => sound.win(), 120)
      }
      return next
    })
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
      return <NetWaiting text="호스트가 출발을 준비하고 있어요..." onExit={onExit} />
    }
    return (
      <RaceRemoteView
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
    return <RaceSetup roster={roster} onStart={startGame} onExit={onExit} />
  }

  const hostView = {
    players: game.players,
    status: game.status,
    finishOrder: game.finishOrder,
    roundPhase,
    count,
  }
  return (
    <RacePlay
      view={hostView}
      canTap={(id) => !online || canControl(id)}
      onTap={tap}
      onRestart={startGame}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 자기 레인만 두드릴 수 있다. 효과음은 view 변화로 재생.
function RaceRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  useEffect(() => {
    if (view.roundPhase === 'ready') sound.step()
    if (view.roundPhase === 'run') sound.ladderUp()
  }, [view.roundPhase, view.count])
  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])

  return (
    <RacePlay
      view={view}
      canTap={canControl}
      onTap={(id) => sendAction({ type: 'tap', playerId: id })}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 플레이 화면(호스트/게스트 공용). view만 보고 그린다.
function RacePlay({ view, canTap, onTap, onRestart, onExit, soundOn, onToggleSound }) {
  const { players, status, roundPhase, count } = view
  const finished = status === 'finished'
  const win = finished ? winner(view) : null
  const order = finished ? ranking(view) : []

  return (
    <div className="race">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        <div className="turn-indicator">{finished ? '🏁 도착!' : '🏃 달리기 경주'}</div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className="race__track">
        {players.map((p) => {
          const z = getZodiac(p.zodiacId)
          const pr = progress(p)
          const mine = canTap(p.id)
          return (
            <button
              key={p.id}
              className={`race-lane ${!mine ? 'race-lane--other' : ''}`}
              style={{ '--z-color': p.color }}
              disabled={roundPhase !== 'run' || !mine}
              onPointerDown={() => mine && onTap(p.id)}
            >
              <span className="race-lane__name">
                {z?.emoji} {p.name}
              </span>
              <span className="race-lane__rail">
                <span className="race-lane__goal">🏁</span>
                <span className="race-lane__runner" style={{ left: `calc(4% + ${pr * 88}%)` }}>
                  {z?.emoji}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {roundPhase === 'ready' && (
        <div className="race__count" key={count}>
          {count === 0 ? '출발!' : count}
        </div>
      )}
      {roundPhase === 'run' && <div className="race__hint">내 칸을 마구 두드려요! 👆👆</div>}

      {finished && (
        <div className="win-modal">
          <Fireworks />
          <div className="win-modal__card" style={{ '--z-color': win?.color }}>
            <div className="win-modal__emoji">🏆</div>
            <h2>{win?.name} 우승! 🎉</h2>
            <p>
              {order.map((p, i) => `${i + 1}등 ${getZodiac(p.zodiacId)?.emoji}${p.name}`).join('  ·  ')}
            </p>
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
