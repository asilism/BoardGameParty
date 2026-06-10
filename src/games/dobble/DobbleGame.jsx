import { useEffect, useMemo, useRef, useState } from 'react'
import DobbleSetup from './DobbleSetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import ShootingStars from '../../shared/ShootingStars.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import { createGame, tapSymbol, winners } from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote } from '../../net/NetParts.jsx'

const N = 5 // 보통 난이도: 카드당 6문양
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 진 사람(그 라운드 못 맞춘 사람) 격려 메시지
const ENCOURAGE = ['할 수 있어!', '조금만 더 힘내!', '끝까지 집중하자!', '거의 다 왔어!', '다음엔 네가!']

// 플레이어 수에 따른 좌석 배치 — 와이드 화면에 맞게 2인은 좌우, 3·4인은 꼭지점.
const SEATS = {
  1: ['bc'],
  2: ['left', 'right'],
  3: ['bl', 'br', 'tl'], // 4인처럼 꼭지점에, 한 자리(우상단)만 비움
  4: ['bl', 'br', 'tl', 'tr'],
}
// 정답 카드가 날아갈 방향(좌석별, vw/vh)
const FLY_VEC = {
  left: { tx: -40, ty: 0 },
  right: { tx: 40, ty: 0 },
  tl: { tx: -32, ty: -28 },
  tr: { tx: 32, ty: -28 },
  bl: { tx: -32, ty: 28 },
  br: { tx: 32, ty: 28 },
  bc: { tx: 0, ty: 34 },
}
const seatOf = (n, idx) => (SEATS[n] || SEATS[4])[idx] || 'bl'

// 문양 배치를 카드 내용으로 결정(같은 카드는 항상 같은 배치 → 모든 기기에서 동일).
// 링(+중앙)에 균등 배치 후, 각 문양의 최대 반지름을 "이웃까지 거리/2"와 "테두리까지"로
// 제한 → 절대 겹치지 않게. 크기는 그 한도 내에서 랜덤(74~100%)이라 크고 작고 섞이고
// 카드를 꽉 채운다. (size = 폰트 크기 %)
function makeLayout(symbols) {
  let seed = symbols.reduce((s, v) => (s * 31 + v + 7) >>> 0, 9)
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const count = symbols.length
  const hasCenter = count >= 5
  const ringCount = hasCenter ? count - 1 : count
  const R = 30 // 링 반지름(%)
  const EDGE = 47 // 카드 안쪽 반지름(%)
  const rot0 = rng() * Math.PI * 2
  const pts = []
  for (let i = 0; i < ringCount; i++) {
    const ang = rot0 + (i / ringCount) * Math.PI * 2
    pts.push({ x: 50 + Math.cos(ang) * R, y: 50 + Math.sin(ang) * R })
  }
  if (hasCenter) pts.push({ x: 50, y: 50 })

  return pts.map((p, i) => {
    let maxR = EDGE - Math.hypot(p.x - 50, p.y - 50) // 테두리까지
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue
      const half = Math.hypot(p.x - pts[j].x, p.y - pts[j].y) / 2
      if (half < maxR) maxR = half
    }
    const r = maxR * (0.74 + rng() * 0.26) // 한도 내 랜덤 크기
    // 문양은 0~360° 완전 무작위 회전 → 어느 좌석에서 봐도 공평
    return { x: p.x, y: p.y, size: r * 1.85, rot: rng() * 360 }
  })
}

function DobbleCard({ symbols, emojiOf, onTap, disabled, highlight }) {
  const layout = useMemo(() => makeLayout(symbols), [symbols.join(',')])
  return (
    <div className="dobble-card">
      {symbols.map((s, i) => {
        const L = layout[i] || { x: 50, y: 50, rot: 0, size: 22 }
        const style = {
          left: `${L.x}%`,
          top: `${L.y}%`,
          fontSize: `${L.size}cqmin`,
          transform: `translate(-50%, -50%) rotate(${L.rot}deg)`,
        }
        const cls = `dobble-sym ${s === highlight ? 'is-match' : ''}`
        const inner = <span className="dobble-sym__in">{emojiOf(s)}</span>
        if (!onTap) return <span key={s} className={cls} style={style}>{inner}</span>
        return (
          <button
            key={s}
            type="button"
            className="dobble-sym"
            style={style}
            disabled={disabled}
            onPointerDown={() => onTap(s)}
          >
            {inner}
          </button>
        )
      })}
    </div>
  )
}

// 온라인 동기화(호스트 권위): 판정/연출 타이밍은 호스트가 결정해 view를 publish,
// 게스트는 자기 카드의 문양 탭만 action으로 보낸다.
export default function DobbleGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'play'
  const [game, setGame] = useState(null)
  const [flash, setFlash] = useState(null) // { id, ok, key }
  const [fly, setFly] = useState(null) // 정답 카드 날아가는 연출 { seat, card, symbol, color, key }
  const [celebrate, setCelebrate] = useState(null) // { winnerId, combo, enc, key }
  const [inputLocked, setInputLocked] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const comboRef = useRef({ id: null, n: 0 })

  // 게스트 입력(호스트에서만 호출). 자기 참가자 카드만 인정.
  function handleAction(a, fromDevice) {
    if (a.type !== 'tap') return
    if (ownerDevice(a.playerId) !== fromDevice) return
    handleTap(a.playerId, Number(a.symbol))
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
      symbols: game.symbols,
      players: game.players,
      center: game.center,
      remaining: game.centerQueue.length - game.centerPos,
      locked: game.locked,
      status: game.status,
      flash,
      fly,
      celebrate,
      inputLocked,
      // 화면엔 안 쓰이지만 호스트 새로고침 복구에 필요한 덱 정보
      n: game.n,
      centerQueue: game.centerQueue,
      centerPos: game.centerPos,
    })
  }, [online, isHost, publish, phase, game, flash, fly, celebrate, inputLocked])

  // 호스트가 게임 도중 새로고침 → 서버가 보관한 마지막 view로 이어가기
  useHostResume(resume, () => phase === 'setup', (v) => {
    if (!Array.isArray(v.centerQueue)) return // 덱 정보 없는 옛 스냅샷은 복구 불가
    sound.setEnabled(soundOn)
    setGame({
      n: v.n ?? N,
      symbols: v.symbols,
      players: v.players,
      centerQueue: v.centerQueue,
      centerPos: v.centerPos,
      center: v.center,
      locked: v.locked,
      status: v.status,
    })
    setFlash(null)
    setFly(null)
    setCelebrate(null)
    setInputLocked(false)
    comboRef.current = { id: null, n: 0 }
    setPhase('play')
  })

  function startGame() {
    sound.setEnabled(soundOn)
    const players = roster.slice(0, 4).map((p) => ({
      id: p.id,
      name: p.name,
      zodiacId: p.zodiacId,
      color: getZodiac(p.zodiacId)?.color,
    }))
    setGame(createGame(players, N))
    setFlash(null)
    setFly(null)
    setCelebrate(null)
    setInputLocked(false)
    comboRef.current = { id: null, n: 0 }
    setPhase('play')
  }

  function restart() {
    startGame()
  }

  function toggleSound() {
    const next = !soundOn
    setSoundOn(next)
    sound.setEnabled(next)
    if (next) sound.unlock()
  }

  async function handleTap(playerId, symbol) {
    if (!game || game.status === 'finished' || inputLocked) return
    const r = tapSymbol(game, playerId, symbol)
    if (r.result === 'ignored' || r.result === 'locked') return
    setFlash({ id: playerId, ok: r.result === 'correct', key: Date.now() })

    if (r.result !== 'correct') {
      setGame(r.state)
      sound.chuteDown()
      return
    }

    // 정답 → 콤보 계산 + 카드 날아가는 연출 + 진 사람 격려 + 전체 입력 잠금
    sound.ladderUp()
    setInputLocked(true)
    const idx = game.players.findIndex((p) => p.id === playerId)
    const prev = comboRef.current
    const combo = prev.id === playerId ? prev.n + 1 : 1
    comboRef.current = { id: playerId, n: combo }
    // 진 사람(나머지)에게 격려 메시지 랜덤 배정
    const enc = {}
    game.players.forEach((pl) => {
      if (pl.id !== playerId) enc[pl.id] = ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)]
    })
    const key = Date.now()
    setFly({ seat: seatOf(game.players.length, idx), card: game.center, symbol, color: game.players[idx]?.color, key })
    setCelebrate({ winnerId: playerId, combo, enc, key })
    if (combo >= 4) sound.win() // 폭죽과 함께 팡파르

    await sleep(combo >= 4 ? 1300 : 950)
    setFly(null)
    setCelebrate(null)
    setGame(r.state) // 이제 중앙 카드 교체 + 점수 반영
    setInputLocked(false)
    if (r.finished) {
      await sleep(150)
      sound.win()
    }
  }

  // ── 게스트: 호스트 view 미러링 ──
  if (online && !isHost) {
    if (!remote || remote.phase !== 'play') {
      return <NetWaiting text="호스트가 카드를 섞고 있어요..." onExit={onExit} />
    }
    return (
      <DobbleRemoteView
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
    return <DobbleSetup roster={roster} onStart={startGame} onExit={onExit} />
  }

  const hostView = {
    symbols: game.symbols,
    players: game.players,
    center: game.center,
    remaining: game.centerQueue.length - game.centerPos,
    locked: game.locked,
    status: game.status,
    flash,
    fly,
    celebrate,
    inputLocked,
  }
  return (
    <DobbleTable
      view={hostView}
      canTap={(id) => !online || canControl(id)}
      onTap={handleTap}
      onRestart={restart}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 효과음은 view 변화로 재생
function DobbleRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  useEffect(() => {
    if (!view.flash) return
    view.flash.ok ? sound.ladderUp() : sound.chuteDown()
  }, [view.flash?.key])
  useEffect(() => {
    if (view.celebrate?.combo >= 4) sound.win()
  }, [view.celebrate?.key])
  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])

  return (
    <DobbleTable
      view={view}
      canTap={canControl}
      onTap={(id, s) => sendAction({ type: 'tap', playerId: id, symbol: s })}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 테이블 화면(호스트/게스트 공용). view만 보고 그린다.
function DobbleTable({ view, canTap, onTap, onRestart, onExit, soundOn, onToggleSound }) {
  const { symbols, players, center, remaining, locked, status, flash, fly, celebrate, inputLocked } = view
  const emojiOf = (idx) => symbols[idx]
  const finished = status === 'finished'
  const seats = SEATS[players.length] || SEATS[4]
  const win = finished ? winners(view) : []

  return (
    <div className="dobble">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        <div className="turn-indicator">{finished ? '🏁 게임 끝!' : `🔍 남은 카드 ${remaining}`}</div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className={`dobble__table dobble__table--p${players.length}`}>
        {players.map((p, i) => {
          const z = getZodiac(p.zodiacId)
          const isLocked = locked.includes(p.id)
          const flashing = flash && flash.id === p.id
          const mine = canTap(p.id)
          return (
            <div key={p.id} className={`dobble-seat seat--${seats[i] || 'bottom'}`}>
              <div className="dobble-seat__label" style={{ '--z-color': p.color }}>
                <span className="dobble-seat__emoji">{z?.emoji}</span>
                <span className="dobble-seat__name">{p.name}</span>
                <span className="dobble-seat__score">{p.score}점</span>
                {isLocked && <span className="dobble-seat__lock">🚫</span>}
              </div>
              <div
                key={flashing ? flash.key : p.id}
                className={`dobble-card-wrap ${isLocked ? 'is-locked' : ''} ${
                  flashing ? (flash.ok ? 'flash-ok' : 'flash-bad') : ''
                }`}
                style={{ '--z-color': p.color }}
              >
                <DobbleCard
                  symbols={p.card}
                  emojiOf={emojiOf}
                  onTap={mine ? (s) => onTap(p.id, s) : null}
                  disabled={finished || isLocked || inputLocked || !mine}
                />
              </div>
              {celebrate && (
                <div className={`dobble-cele seat-rot--${seats[i] || 'bl'}`}>
                  {celebrate.winnerId === p.id ? (
                    <div className="dobble-pop" style={{ '--z-color': p.color }}>
                      +1 Point
                    </div>
                  ) : (
                    <div className="dobble-enc">{celebrate.enc[p.id]}</div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div className="dobble-seat seat--center">
          <div className="dobble-card-wrap dobble-card-wrap--center">
            {center && !fly && <DobbleCard symbols={center} emojiOf={emojiOf} />}
          </div>
        </div>

        {/* 정답 카드가 그 사람에게 날아가는 연출(맞춘 문양 강조) */}
        {fly && (
          <div
            key={fly.key}
            className="dobble-fly"
            style={{
              '--tx': `${(FLY_VEC[fly.seat] || FLY_VEC.bl).tx}vw`,
              '--ty': `${(FLY_VEC[fly.seat] || FLY_VEC.bl).ty}vh`,
              '--z-color': fly.color,
            }}
          >
            <DobbleCard symbols={fly.card} emojiOf={emojiOf} highlight={fly.symbol} />
          </div>
        )}
      </div>

      {/* 콤보 배너 + 폭죽(4콤보~) + 별똥별(6콤보~) */}
      {celebrate && celebrate.combo >= 2 && (
        <div key={celebrate.key} className="dobble-combo-banner">
          🔥 {celebrate.combo} COMBO!
        </div>
      )}
      {celebrate && celebrate.combo >= 4 && (
        <div className="dobble-fx">
          <Fireworks />
          {celebrate.combo >= 6 && <ShootingStars />}
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
