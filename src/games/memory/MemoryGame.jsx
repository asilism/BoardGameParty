import { useEffect, useRef, useState } from 'react'
import MemorySetup from './MemorySetup.jsx'
import Fireworks from '../../shared/Fireworks.jsx'
import FullscreenButton from '../../shared/FullscreenButton.jsx'
import TurnOrderRoll from '../../shared/TurnOrderRoll.jsx'
import { createGame, applyPair, winners } from './engine.js'
import { getZodiac } from '../../shared/zodiac.js'
import { sound } from '../../shared/sound.js'
import { useGameNet, useHostResume } from '../../net/useGameNet.js'
import { NetWaiting, GuestRestartNote, shufflePlayers } from '../../net/NetParts.jsx'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 온라인 동기화(호스트 권위): 호스트가 판정/타이밍을 결정해 view를 publish,
// 게스트는 자기 차례에만 카드 탭을 action으로 보낸다.
export default function MemoryGame({ roster, onExit, net }) {
  const { online, isHost, remote, resume, publish, sendAction, canControl, ownerDevice } = useGameNet(net, handleAction)

  const [phase, setPhase] = useState('setup') // 'setup' | 'order' | 'play'
  const [order, setOrder] = useState(roster) // 차례 정하기로 확정된 순서
  const [game, setGame] = useState(null)
  const [difficulty, setDifficulty] = useState(null) // 다시하기용
  const [flipped, setFlipped] = useState([]) // 현재 뒤집은 카드 id (최대 2)
  const [busy, setBusy] = useState(false) // 짝 판정 중 입력 잠금
  const [banner, setBanner] = useState(null) // { text, key }
  const [soundOn, setSoundOn] = useState(true)
  const prevTurnRef = useRef(-1)

  // 게스트 입력(호스트에서만 호출). 현재 차례 플레이어의 기기인지 검증.
  function handleAction(a, fromDevice) {
    if (phase !== 'play' || !game || game.status !== 'playing') return
    const cur = game.players[game.currentIndex]
    if (!cur || ownerDevice(cur.id) !== fromDevice) return
    if (a.type === 'flip') flip(Number(a.id))
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
      difficulty: game.difficulty,
      players: game.players,
      currentIndex: game.currentIndex,
      cards: game.cards,
      matched: game.matched,
      status: game.status,
      flipped,
      busy,
      banner,
    })
  }, [online, isHost, publish, phase, game, flipped, busy, banner])

  // 턴이 바뀌면 "○○ 차례!" 배너 (혼자 플레이면 생략)
  useEffect(() => {
    if (online && !isHost) return
    if (!game || game.status !== 'playing' || game.players.length < 2) return
    if (prevTurnRef.current === game.currentIndex) return
    prevTurnRef.current = game.currentIndex
    const p = game.players[game.currentIndex]
    setBanner({ text: `${p.name} 차례!`, key: Date.now() })
    const t = setTimeout(() => setBanner(null), 1200)
    return () => clearTimeout(t)
  }, [game, online, isHost])

  // 호스트가 게임 도중 새로고침 → 서버가 보관한 마지막 view로 이어가기.
  // 판정 중이던(뒤집힌) 카드는 다시 덮고 같은 차례부터 진행한다.
  useHostResume(resume, () => phase === 'setup', (v) => {
    sound.setEnabled(soundOn)
    setDifficulty(v.difficulty)
    setOrder(v.players)
    prevTurnRef.current = v.currentIndex
    setFlipped([])
    setBusy(false)
    setBanner(null)
    setGame({
      difficulty: v.difficulty,
      players: v.players,
      currentIndex: v.currentIndex,
      cards: v.cards,
      matched: v.matched,
      status: v.status,
    })
    setPhase('play')
  })

  // 난이도 선택 → 차례 정하기 (혼자면 건너뛰고 바로 시작, 온라인은 무작위 순서)
  function chooseDifficulty(diff) {
    setDifficulty(diff)
    if (online) beginGame(shufflePlayers(roster), diff)
    else if (roster.length < 2) beginGame(roster, diff)
    else setPhase('order')
  }

  // 게임 시작: players = 확정된 순서
  function beginGame(players, diff = difficulty) {
    sound.setEnabled(soundOn)
    setOrder(players)
    prevTurnRef.current = -1
    setFlipped([])
    setBusy(false)
    setBanner(null)
    // 12지신 색을 붙여 플레이어로 사용 (순서 = 차례)
    const built = players.map((p) => ({
      id: p.id,
      name: p.name,
      zodiacId: p.zodiacId,
      color: getZodiac(p.zodiacId)?.color,
    }))
    setGame(createGame(built, diff))
    setPhase('play')
  }

  function restart() {
    if (difficulty) beginGame(order)
  }

  function toggleSound() {
    const next = !soundOn
    setSoundOn(next)
    sound.setEnabled(next)
    if (next) sound.unlock()
  }

  async function flip(id) {
    if (!game || busy || game.status === 'finished') return
    if (flipped.includes(id) || game.matched.includes(id) || flipped.length >= 2) return
    if (!game.cards.some((c) => c.id === id)) return

    sound.step()
    const nf = [...flipped, id]
    setFlipped(nf)
    if (nf.length < 2) return

    // 두 장 뒤집힘 → 판정
    setBusy(true)
    const [a, b] = nf
    await sleep(650) // 카드를 눈으로 확인할 시간
    const { next, match, won } = applyPair(game, a, b)

    if (match) {
      sound.ladderUp()
      setGame(next)
      setFlipped([])
      if (game.players.length > 1 && !won) {
        setBanner({ text: '짝 맞췄다! 한 번 더 🎉', key: Date.now() })
        setTimeout(() => setBanner(null), 1100)
      }
      if (won) {
        await sleep(150)
        sound.win()
      }
    } else {
      sound.key()
      await sleep(450) // 틀린 카드 잠깐 보여준 뒤 뒤집기
      setFlipped([])
      setGame(next)
    }
    setBusy(false)
  }

  // ── 게스트: 호스트 view 미러링 ──
  if (online && !isHost) {
    if (!remote || remote.phase !== 'play') {
      return <NetWaiting text="호스트가 난이도를 고르고 있어요..." onExit={onExit} />
    }
    return (
      <MemoryRemoteView
        view={remote}
        canControl={canControl}
        sendAction={sendAction}
        onExit={onExit}
        soundOn={soundOn}
        onToggleSound={toggleSound}
      />
    )
  }

  // 1) 설정 화면 (난이도 선택)
  if (phase === 'setup') {
    return <MemorySetup roster={roster} onStart={chooseDifficulty} onExit={onExit} />
  }
  // 2) 차례 정하기 (한 기기 모드, 2명 이상)
  if (phase === 'order') {
    return (
      <TurnOrderRoll players={roster} onComplete={(p) => beginGame(p)} onBack={() => setPhase('setup')} />
    )
  }

  const hostView = {
    difficulty: game.difficulty,
    players: game.players,
    currentIndex: game.currentIndex,
    cards: game.cards,
    matched: game.matched,
    status: game.status,
    flipped,
    busy,
    banner,
  }
  const activeId = game.players[game.currentIndex]?.id
  return (
    <MemoryPlay
      view={hostView}
      myTurn={!online || canControl(activeId)}
      onFlip={flip}
      onRestart={restart}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={toggleSound}
    />
  )
}

// 게스트 화면: 효과음은 view 변화로 재생
function MemoryRemoteView({ view, canControl, sendAction, onExit, soundOn, onToggleSound }) {
  const activeId = view.players[view.currentIndex]?.id

  useEffect(() => {
    if (view.status === 'finished') sound.win()
  }, [view.status])
  useEffect(() => {
    if (view.flipped.length) sound.step()
  }, [view.flipped.length])
  useEffect(() => {
    if (view.matched.length) sound.ladderUp()
  }, [view.matched.length])

  return (
    <MemoryPlay
      view={view}
      myTurn={canControl(activeId)}
      onFlip={(id) => sendAction({ type: 'flip', id })}
      onRestart={null}
      onExit={onExit}
      soundOn={soundOn}
      onToggleSound={onToggleSound}
    />
  )
}

// 플레이 화면(호스트/게스트 공용). view만 보고 그린다.
function MemoryPlay({ view, myTurn, onFlip, onRestart, onExit, soundOn, onToggleSound }) {
  const { difficulty: diff, players, currentIndex, cards, matched, status, flipped, busy, banner } = view
  const finished = status === 'finished'
  const activePlayer = players[currentIndex]
  const activeZodiac = getZodiac(activePlayer.zodiacId)
  const matchedSet = new Set(matched)
  const flippedSet = new Set(flipped)
  const win = finished ? winners(view) : []
  const solo = players.length === 1
  const canFlip = !finished && !busy && myTurn

  return (
    <div className="memory">
      <div className="ladder__topbar">
        <button className="btn btn--ghost" onClick={onExit}>
          ← 나가기
        </button>
        {!finished ? (
          <div className="turn-indicator" style={{ '--z-color': activePlayer.color }}>
            <span className="turn-indicator__emoji">{activeZodiac?.emoji}</span>
            <span>{solo ? '짝을 찾아요!' : `${activePlayer.name} 차례`}</span>
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
          <div className="mboard" style={{ '--cols': diff.cols, '--rows': diff.rows }}>
            {cards.map((card) => {
              const isUp = flippedSet.has(card.id) || matchedSet.has(card.id)
              const isMatched = matchedSet.has(card.id)
              const z = getZodiac(card.animalId)
              return (
                <button
                  key={card.id}
                  type="button"
                  className={`mcard ${isUp ? 'is-up' : ''} ${isMatched ? 'is-matched' : ''}`}
                  onClick={() => canFlip && onFlip(card.id)}
                  aria-label={isUp ? z?.name : '뒤집힌 카드'}
                >
                  <span className="mcard__inner">
                    {isUp ? (
                      <span
                        key="front"
                        className="mcard__face mcard__front"
                        style={{ '--z-color': z?.color }}
                      >
                        {z?.emoji}
                      </span>
                    ) : (
                      <span key="back" className="mcard__face mcard__back">
                        <span className="mcard__back-icon">🐾</span>
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
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
                  style={{ '--z-color': p.color }}
                >
                  <span className="players-list__emoji">{z?.emoji}</span>
                  <span className="players-list__name">{p.name}</span>
                  <span className="players-list__pos">{p.score}쌍</span>
                </div>
              )
            })}
          </div>
          <div className="dice-area">
            <p className="dice-area__hint">
              {finished
                ? ''
                : busy
                ? '확인 중...'
                : myTurn
                ? '카드를 두 장 뒤집어요'
                : `${activePlayer.name} 차례를 기다려요`}
            </p>
          </div>
        </aside>
      </div>

      {finished && (
        <div className="win-modal">
          <Fireworks />
          <div className="win-modal__card" style={{ '--z-color': win[0]?.color }}>
            <div className="win-modal__emoji">🏆</div>
            {solo ? (
              <>
                <h2>완성! 🎉</h2>
                <p>{diff.pairs}쌍 모두 찾았어요</p>
              </>
            ) : win.length > 1 ? (
              <>
                <h2>공동 우승! 🎉</h2>
                <p>
                  {win.map((p) => p.name).join(', ')} · {win[0].score}쌍
                </p>
              </>
            ) : (
              <>
                <h2>{win[0]?.name} 우승! 🎉</h2>
                <p>{win[0]?.score}쌍으로 1등!</p>
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
