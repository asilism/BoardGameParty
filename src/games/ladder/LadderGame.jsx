import { useEffect, useMemo, useRef, useState } from 'react'
import Board from './Board.jsx'
import LadderSetup from './LadderSetup.jsx'
import Dice from '../../shared/Dice.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import TurnOrderRoll from '../../shared/TurnOrderRoll.jsx'
import { BOARD_SIZES, generateBoard } from './board.config.js'
import { createGame, applyMove, computeMove, rollDice } from './engine.js'
import { randomCardId, resolveKeyCard, getCard } from './keycards.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote, shufflePlayers } from '../../net/NetParts.jsx'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 발판/열쇠칸 하나가 순차 등장하는 간격(ms). Board의 CSS 딜레이와 맞춘다.
const REVEAL_STEP = 130

// 온라인 동기화(호스트 권위):
//  - 호스트가 게임 로직/연출 타이밍을 전부 결정하고 view를 publish.
//  - 게스트는 view를 그대로 그리고, 자기 차례의 주사위/카드 입력만 action으로 보낸다.
export default function LadderGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'order' | 'play'
  const [size, setSize] = useState(BOARD_SIZES[0]) // 선택된 보드 크기(30칸/50칸)
  const [order, setOrder] = useState(roster) // 확정된 플레이어 순서
  const [config, setConfig] = useState(() => generateBoard(BOARD_SIZES[0])) // 생성된 맵
  const [game, setGame] = useState(null)
  const [displayPos, setDisplayPos] = useState({}) // id -> tile (애니메이션용)
  const [animating, setAnimating] = useState(false)
  const [revealing, setRevealing] = useState(false) // 맵 순차 등장 중 입력 잠금
  const [mapKey, setMapKey] = useState(0) // 새 맵마다 증가 → Board 리마운트로 등장 연출 재생
  const [center, setCenter] = useState(null) // { value, key }
  const [banner, setBanner] = useState(null) // { text, key } — "○○ 차례!"
  const [cardEvent, setCardEvent] = useState(null) // { slots:[id x5], chosen, revealed }
  const [soundOn, setSoundOn] = useState(true)
  const prevTurnRef = useRef(-1)
  const cardBaseRef = useRef(null) // 카드 적용 직전의 게임 상태
  const revealTimerRef = useRef(null)

  // 게스트 입력 처리(호스트에서만 호출됨). 현재 차례 플레이어의 기기인지 검증한다.
  function handleAction(a, fromDevice) {
    if (phase !== 'play' || !game || game.status !== 'playing') return
    const cur = game.players[game.currentIndex]
    if (!cur || ownerDevice(cur.id) !== fromDevice) return
    if (a.type === 'roll' && !animating && !revealing && !cardEvent) {
      const max = config.diceCount * config.diceSides
      const v = Math.round(Number(a.value))
      if (v >= 1 && v <= max) handleResult(v)
    }
    if (a.type === 'pickCard' && cardEvent && cardEvent.chosen == null) {
      const i = Math.round(Number(a.index))
      if (i >= 0 && i < cardEvent.slots.length) handleCardPick(i)
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
      config,
      mapKey,
      players: game.players,
      currentIndex: game.currentIndex,
      status: game.status,
      winnerId: game.winnerId,
      displayPos,
      center,
      banner,
      cardEvent,
      revealing,
      animating,
    })
  }, [online, isHost, publish, phase, game, config, mapKey, displayPos, center, banner, cardEvent, revealing, animating])

  // 턴이 바뀔 때마다 "○○ 차례!" 배너 표시 (첫 턴 포함)
  useEffect(() => {
    if (online && !isHost) return
    if (!game || game.status !== 'playing') return
    if (prevTurnRef.current === game.currentIndex) return
    prevTurnRef.current = game.currentIndex
    const p = game.players[game.currentIndex]
    setBanner({ text: `${p.name} 차례!`, key: Date.now() })
    const t = setTimeout(() => setBanner(null), 1300)
    return () => clearTimeout(t)
  }, [game, online, isHost])

  // 호스트가 게임 도중 새로고침 → 서버가 보관한 마지막 view로 이어가기.
  // 진행 중이던 이동 연출은 버리고 확정된 칸에서, 카드 고르던 중이면 새 카드 5장으로 다시.
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    const cfg = v.config
    setConfig(cfg)
    setSize(BOARD_SIZES.find((s) => s.tileCount === cfg.tileCount) || BOARD_SIZES[0])
    setOrder(v.players)
    const g = {
      config: cfg,
      players: v.players,
      currentIndex: v.currentIndex,
      status: v.status,
      winnerId: v.winnerId ?? null,
      lastRoll: null,
    }
    setGame(g)
    setDisplayPos(Object.fromEntries(g.players.map((p) => [p.id, p.position])))
    prevTurnRef.current = v.currentIndex
    setMapKey((k) => k + 1)
    setRevealing(false)
    setAnimating(false)
    setPhase('play')
    if (v.cardEvent && v.status === 'playing') openKeyCard(g)
  })

  // 보드 크기 선택 → 차례 정하기 단계로 (온라인은 무작위 순서로 바로 시작)
  function chooseSize(boardSize) {
    setSize(boardSize)
    if (online) beginGame(shufflePlayers(roster), boardSize)
    else setPhase('order')
  }

  // 게임 시작: 맵을 매번 새로 생성하고, 발판/열쇠칸이 순차 등장하는 동안 입력을 잠근다.
  // players = 확정된 순서
  function beginGame(players, boardSize = size) {
    sound.setEnabled(soundOn)
    setOrder(players)
    const cfg = generateBoard(boardSize)
    setConfig(cfg)
    prevTurnRef.current = -1
    setCardEvent(null)
    setAnimating(false)
    cardBaseRef.current = null
    const g = createGame(players, cfg)
    setGame(g)
    setDisplayPos(Object.fromEntries(g.players.map((p) => [p.id, p.position])))
    setMapKey((k) => k + 1)
    setPhase('play')

    // 순차 등장 연출 시간 동안 주사위 잠금
    const specials = Object.keys(cfg.platforms).length + cfg.keyTiles.length
    const dur = specials * REVEAL_STEP + 700
    setRevealing(true)
    clearTimeout(revealTimerRef.current)
    revealTimerRef.current = setTimeout(() => setRevealing(false), dur)
  }

  // 다시하기: 정해진 차례 그대로 새 맵으로
  function restart() {
    beginGame(order)
  }

  useEffect(() => () => clearTimeout(revealTimerRef.current), [])

  function toggleSound() {
    const next = !soundOn
    setSoundOn(next)
    sound.setEnabled(next)
    if (next) sound.unlock()
  }

  async function handleResult(roll) {
    if (!game || animating || game.status === 'finished') return
    setAnimating(true)
    const player = game.players[game.currentIndex]
    const move = computeMove(player.position, roll, config)

    // 1) 중앙에 큰 숫자 연출
    setCenter({ value: roll, key: Date.now() })
    await sleep(750)
    setCenter(null)

    // 2) 한 칸씩 걸어가기
    for (const tile of move.walkPath) {
      setDisplayPos((dp) => ({ ...dp, [player.id]: tile }))
      sound.step()
      await sleep(280)
    }

    // 3) 발판 발동
    if (move.platform) {
      await sleep(250)
      setDisplayPos((dp) => ({ ...dp, [player.id]: move.platform.to }))
      move.platform.dir === 'up' ? sound.ladderUp() : sound.chuteDown()
      await sleep(500)
    }

    // 4) 열쇠카드 칸이면 카드 선택 이벤트로 진입(턴은 카드 적용 후 처리)
    if (move.keyCard) {
      // 멈춘 칸을 게임 상태에 반영(턴은 아직 넘기지 않음)
      const landed = {
        ...game,
        players: game.players.map((p, i) =>
          i === game.currentIndex ? { ...p, position: move.finalPosition } : p
        ),
        lastRoll: roll,
      }
      setGame(landed)
      await sleep(250)
      openKeyCard(landed)
      return // setAnimating(false) 하지 않음 — 카드 고를 때까지 대기
    }

    // 5) 상태 확정
    const next = applyMove(game, roll)
    setGame(next)
    if (next.status === 'finished') {
      await sleep(150)
      sound.win()
    }
    setAnimating(false)
  }

  // 열쇠카드 모달 열기 (baseState = 카드 적용 직전 상태)
  function openKeyCard(baseState) {
    cardBaseRef.current = baseState
    sound.key()
    setCardEvent({ slots: Array.from({ length: 5 }, () => randomCardId()), chosen: null })
  }

  // 카드 1장 선택 → 효과 공개 → 적용 → (멈춘 칸이 이벤트 칸이면 연쇄) → 턴 처리
  async function handleCardPick(index) {
    const base = cardBaseRef.current
    if (!base || !cardEvent || cardEvent.chosen != null) return
    const cardId = cardEvent.slots[index]
    sound.key()
    setCardEvent((ce) => ({ ...ce, chosen: index, revealed: cardId }))
    await sleep(1200) // 공개된 카드를 보여줌

    const moverIdx = base.currentIndex
    const moverId = base.players[moverIdx].id
    const { next, changes, rollAgain } = resolveKeyCard(base, cardId)
    setCardEvent(null)
    cardBaseRef.current = null

    // 자리 이동 애니메이션(부드럽게 미끄러짐 — pawn CSS transition)
    if (changes.length) {
      await sleep(150)
      setDisplayPos((dp) => {
        const nd = { ...dp }
        changes.forEach((c) => (nd[c.id] = c.to))
        return nd
      })
      changes.forEach((c) => (c.to > c.from ? sound.ladderUp() : sound.chuteDown()))
      await sleep(650)
    }

    // forward5로 바로 골인한 경우
    if (next.status === 'finished') {
      setGame(next)
      await sleep(150)
      sound.win()
      setAnimating(false)
      return
    }

    // 연쇄: 카드로 '실제로 이동한' 현재 플레이어가 멈춘 칸이 이벤트 칸이면 발동
    const moverTile = next.players[moverIdx].position
    const moverMoved = moverTile !== base.players[moverIdx].position

    if (moverMoved && config.platforms[moverTile] != null) {
      // 사다리/미끄럼틀 연쇄 (한 번)
      const to = config.platforms[moverTile]
      const dir = to > moverTile ? 'up' : 'down'
      await sleep(250)
      setDisplayPos((dp) => ({ ...dp, [moverId]: to }))
      dir === 'up' ? sound.ladderUp() : sound.chuteDown()
      await sleep(550)
      const after = {
        ...next,
        players: next.players.map((p, i) => (i === moverIdx ? { ...p, position: to } : p)),
      }
      finishCardTurn(after, rollAgain)
      return
    }

    if (moverMoved && (config.keyTiles || []).includes(moverTile)) {
      // 다른 열쇠칸에 멈춤 → 같은 사람이 카드 한 번 더 (턴은 그대로 유지)
      const chainBase = { ...next, currentIndex: moverIdx, status: 'playing', winnerId: null }
      await sleep(300)
      setGame(chainBase)
      openKeyCard(chainBase)
      return // 새 카드 픽 대기 (animating 유지)
    }

    finishCardTurn(next, rollAgain)
  }

  // 카드(및 연쇄) 처리 후 마무리 — 상태 확정 + 한 번 더 안내
  function finishCardTurn(state, rollAgain) {
    setGame(state)
    if (rollAgain) {
      setBanner({ text: '한 번 더! 🎲', key: Date.now() })
      setTimeout(() => setBanner(null), 1300)
    }
    setAnimating(false)
  }

  // ── 게스트: 호스트가 보낸 view를 그대로 렌더 ──
  if (online && !isHost) {
    if (!remote || remote.phase !== 'play') {
      return <NetWaiting text="호스트가 보드를 고르고 있어요..." onExit={onExit} />
    }
    return (
      <LadderRemoteView
        view={remote}
        canControl={canControl}
        sendAction={sendAction}
        onExit={onExit}
        soundOn={soundOn}
        onToggleSound={toggleSound}
      />
    )
  }

  // 1) 설정 화면 (보드 크기 선택)
  if (phase === 'setup') {
    return <LadderSetup sizes={BOARD_SIZES} roster={roster} onStart={chooseSize} onExit={onExit} />
  }
  // 2) 차례 정하기 (한 기기 모드 전용)
  if (phase === 'order') {
    return (
      <TurnOrderRoll players={roster} onComplete={beginGame} onBack={() => setPhase('setup')} />
    )
  }

  const hostView = {
    config,
    mapKey,
    players: game.players,
    currentIndex: game.currentIndex,
    status: game.status,
    winnerId: game.winnerId,
    displayPos,
    center,
    banner,
    cardEvent,
    revealing,
    animating,
  }
  const activeId = game.players[game.currentIndex]?.id
  return (
    <LadderPlay
      view={hostView}
      myTurn={!online || canControl(activeId)}
      onRollResult={handleResult}
      onPickCard={handleCardPick}
      onRestart={restart}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: view 미러링 + 내 차례일 때만 입력 → action 전송. 효과음은 상태 변화로 재생.
function LadderRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  const activeId = view.players[view.currentIndex]?.id

  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])
  useEffect(() => {
    if (view.center) sound.step()
  }, [view.center?.key])
  useEffect(() => {
    if (view.animating) sound.step()
  }, [view.displayPos, view.animating])
  useEffect(() => {
    if (view.cardEvent) sound.key()
  }, [view.cardEvent != null])

  return (
    <LadderPlay
      view={view}
      myTurn={canControl(activeId)}
      onRollResult={(v) => sendAction({ type: 'roll', value: v })}
      onPickCard={(i) => sendAction({ type: 'pickCard', index: i })}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 플레이 화면(호스트/게스트 공용 표현 컴포넌트). view만 보고 그린다.
function LadderPlay({ view, myTurn, onRollResult, onPickCard, onRestart, onExit, soundOn, onToggleSound }) {
  const { config, players, currentIndex, status, winnerId, displayPos, center, banner, cardEvent, revealing, animating } = view
  const finished = status === 'finished'
  const activePlayer = players[currentIndex]
  const activeZodiac = activePlayer && getZodiac(activePlayer.zodiacId)
  const winner = winnerId && players.find((p) => p.id === winnerId)
  const winnerZodiac = winner && getZodiac(winner.zodiacId)

  const rollFn = useMemo(() => () => rollDice(config), [config])
  const canRoll = !finished && !animating && !revealing && !cardEvent && myTurn
  const canPick = cardEvent && cardEvent.chosen == null && myTurn

  return (
    <div className="ladder">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        {!finished ? (
          <div className="turn-indicator" style={{ '--z-color': activeZodiac?.color }}>
            <span className="turn-indicator__emoji">{activeZodiac?.emoji}</span>
            <span>{activePlayer.name} 차례</span>
          </div>
        ) : (
          <div className="turn-indicator">🏁 게임 끝!</div>
        )}
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onToggleSound} aria-label="소리">
            {soundOn ? '🔊' : '🔇'}
          </button>
          <FullscreenButton />
        </div>
      </div>

      <div className="ladder__main">
        <div className="ladder__board-wrap">
          <Board
            key={view.mapKey}
            config={config}
            positions={displayPos}
            players={players}
            activeId={!finished ? activePlayer?.id : null}
          />
          {center && (
            <div key={center.key} className="center-number">
              {center.value}
            </div>
          )}
          {banner && (
            <div key={banner.key} className="turn-banner">
              {banner.text}
            </div>
          )}
        </div>

        <aside className="ladder__side">
          <div className="players-list">
            {players.map((p, i) => {
              const z = getZodiac(p.zodiacId)
              return (
                <div
                  key={p.id}
                  className={`players-list__item ${
                    !finished && i === currentIndex ? 'is-active' : ''
                  }`}
                  style={{ '--z-color': z.color }}
                >
                  <span className="players-list__emoji">{z.emoji}</span>
                  <span className="players-list__name">{p.name}</span>
                  <span className="players-list__pos">{displayPos[p.id]}칸</span>
                </div>
              )
            })}
          </div>

          <div className="dice-area">
            <Dice disabled={!canRoll} rollFn={rollFn} onResult={onRollResult} />
            <p className="dice-area__hint">
              {revealing
                ? '🗺️ 맵 생성 중...'
                : cardEvent
                ? myTurn
                  ? '🔑 카드를 골라요'
                  : `🔑 ${activePlayer?.name}가 카드를 골라요`
                : animating
                ? '이동 중...'
                : finished
                ? ''
                : myTurn
                ? '주사위를 눌러요'
                : `${activePlayer?.name} 차례를 기다려요`}
            </p>
          </div>
        </aside>
      </div>

      {cardEvent && (
        <div className="card-modal">
          <div className="card-modal__title">
            🔑 {cardEvent.chosen == null ? '열쇠카드! 한 장 고르세요' : getCard(cardEvent.revealed)?.title}
          </div>
          <div className="card-row">
            {cardEvent.slots.map((slotId, i) => {
              const chosen = cardEvent.chosen === i
              const dim = cardEvent.chosen != null && !chosen
              const card = getCard(slotId)
              return (
                <button
                  key={i}
                  className={`key-card ${chosen ? 'key-card--face' : 'key-card--back'} ${
                    dim ? 'key-card--dim' : ''
                  }`}
                  disabled={!canPick}
                  onClick={() => canPick && onPickCard(i)}
                >
                  {chosen ? (
                    <>
                      <span className="key-card__emoji">{card?.emoji}</span>
                      <span className="key-card__title">{card?.title}</span>
                      <span className="key-card__desc">{card?.desc}</span>
                    </>
                  ) : (
                    <span className="key-card__back-icon">🔑</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {finished && (
        <div className="win-modal">
          <Fireworks />
          <div className="win-modal__card" style={{ '--z-color': winnerZodiac?.color }}>
            <div className="win-modal__emoji">{winnerZodiac?.emoji}</div>
            <h2>{winner?.name} 우승! 🎉</h2>
            <p>{winnerZodiac?.name} 골인!</p>
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
