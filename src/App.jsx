import { useEffect, useState } from 'react'
import HomeScreen from './lobby/HomeScreen.jsx'
import GameLobby from './lobby/GameLobby.jsx'
import OnlineLobby from './lobby/OnlineLobby.jsx'
import LadderGame from './games/ladder/LadderGame.jsx'
import MemoryGame from './games/memory/MemoryGame.jsx'
import DobbleGame from './games/dobble/DobbleGame.jsx'
import ThrillGame from './games/thrillpang/ThrillGame.jsx'
import RaceGame from './games/race/RaceGame.jsx'
import WhackGame from './games/whack/WhackGame.jsx'
import TrafficGame from './games/traffic/TrafficGame.jsx'
import ErrorBoundary from './shared/ErrorBoundary.jsx'
import { RoomProvider, useRoom } from './net/RoomContext.jsx'
import { NetOverlay } from './net/NetParts.jsx'
import { loadRoster, saveRoster, loadSession, clearSession } from './shared/storage.js'

// 게임 id → 컴포넌트. 모든 게임은 { roster, onExit, net }을 받는다.
//  net=null 이면 오프라인(핫시트), net이 있으면 온라인 동기화 모드.
const GAME_COMPONENTS = {
  ladder: LadderGame,
  memory: MemoryGame,
  dobble: DobbleGame,
  thrillpang: ThrillGame,
  race: RaceGame,
  whack: WhackGame,
  traffic: TrafficGame,
}

function renderGame(id, props) {
  const Game = GAME_COMPONENTS[id]
  return Game ? <Game {...props} /> : null
}

// 화면 흐름:
//  홈(모드 선택) → ① 한 기기 모드: 로비 → 게임 (기존 핫시트, localStorage 저장)
//               → ② 온라인 모드: 방 생성/참여 → 온라인 로비 → 게임 (서버 동기화)
export default function App() {
  // URL에 ?room=CODE 가 있으면 바로 참여 시도 (초대 링크).
  // 없어도 최근에 들어가 있던 방(세션)이 남아 있으면 자동 복귀를 시도한다
  // — 브라우저가 튕기거나 새로고침해도 게임을 이어갈 수 있게.
  const [mode, setMode] = useState(() => {
    const code = new URLSearchParams(location.search).get('room') || loadSession()
    return code ? { kind: 'online', intent: { kind: 'join', code: code.toUpperCase() } } : { kind: 'home' }
  })

  // 홈으로 나올 때 초대 코드 쿼리/저장된 세션을 지운다 (새로고침 시 재참여 방지)
  function goHome() {
    if (location.search) history.replaceState(null, '', location.pathname)
    clearSession()
    setMode({ kind: 'home' })
  }

  return (
    <div className="app">
      <div className="rotate-hint">
        <div className="rotate-hint__inner">
          <div className="rotate-hint__icon">📱↻</div>
          <p>가로로 돌려서 즐겨주세요</p>
        </div>
      </div>

      {mode.kind === 'home' && (
        <HomeScreen
          onLocal={() => setMode({ kind: 'local' })}
          onCreate={() => setMode({ kind: 'online', intent: { kind: 'create' } })}
          onJoin={(code) => setMode({ kind: 'online', intent: { kind: 'join', code } })}
        />
      )}

      {mode.kind === 'local' && <LocalFlow onBack={goHome} />}

      {mode.kind === 'online' && (
        <RoomProvider intent={mode.intent} onLeft={goHome}>
          <OnlineFlow onHome={goHome} />
        </RoomProvider>
      )}
    </div>
  )
}

// ① 한 기기(핫시트) 모드 — 기존 동작 그대로. 참가자는 localStorage에 유지.
function LocalFlow({ onBack }) {
  const [screen, setScreen] = useState('lobby')
  const [roster, setRoster] = useState(loadRoster)

  useEffect(() => {
    saveRoster(roster)
  }, [roster])

  if (screen === 'lobby') {
    return <GameLobby roster={roster} setRoster={setRoster} onPlay={setScreen} onBack={onBack} />
  }
  return (
    <ErrorBoundary key={screen} onExit={() => setScreen('lobby')}>
      {renderGame(screen, { roster, onExit: () => setScreen('lobby'), net: null })}
    </ErrorBoundary>
  )
}

// ② 온라인 모드 — 화면(screen)은 방 상태로 서버가 관리하고 호스트가 전환한다.
function OnlineFlow({ onHome }) {
  const { status, room, notice, deviceId, isHost, addPlayer, removePlayer, setScreen, leaveRoom, net } = useRoom()

  // 첫 접속/방 입장 중. 일시적인 접속 실패는 여기 머물며 조용히 재시도하고,
  // 끝내 실패했을 때만 아래의 빨간 안내로 넘어간다.
  if (status === 'connecting' || (status === 'reconnecting' && !room)) {
    return (
      <div className="net-screen">
        <div className="net-screen__icon">🌐</div>
        <p>서버에 접속하는 중...</p>
        <button className="btn btn--ghost" onClick={onHome}>← 취소</button>
      </div>
    )
  }

  if (status === 'error' || status === 'closed' || !room) {
    return (
      <div className="net-screen">
        <div className="net-screen__icon">😢</div>
        <p>{notice?.text || '방에 연결할 수 없어요.'}</p>
        <button className="btn btn--primary" onClick={onHome}>처음으로</button>
      </div>
    )
  }

  // 화면을 가리는 안내: 내 연결이 끊겨 재접속 중이거나, 호스트가 잠시 끊긴 경우.
  // 둘 다 방/게임 상태는 유지되므로 기다리면 그대로 이어진다.
  const overlay =
    status === 'reconnecting'
      ? { icon: '📡', text: '연결이 끊겨 다시 접속하는 중이에요...\n잠시만 기다려 주세요' }
      : !isHost && room.hostOnline === false
        ? { icon: '⏳', text: '호스트의 연결이 잠시 끊겼어요.\n돌아올 때까지 조금만 기다려 주세요!' }
        : null

  let screenEl
  if (room.screen === 'lobby') {
    screenEl = (
      <OnlineLobby
        room={room}
        isHost={isHost}
        deviceId={deviceId}
        addPlayer={addPlayer}
        removePlayer={removePlayer}
        setScreen={setScreen}
        onLeave={leaveRoom}
        notice={notice}
      />
    )
  } else {
    // 게임 중: 호스트의 나가기 → 방 전체가 로비로, 게스트의 나가기 → 방을 떠남
    const onExit = isHost ? () => setScreen('lobby') : leaveRoom
    screenEl = (
      <ErrorBoundary key={room.screen} onExit={onExit}>
        {notice && (
          <div className={`net-toast net-toast--ingame ${notice.tone === 'info' ? 'net-toast--info' : ''}`}>
            {notice.text}
          </div>
        )}
        {renderGame(room.screen, { roster: room.players, onExit, net })}
      </ErrorBoundary>
    )
  }

  return (
    <>
      {screenEl}
      {overlay && <NetOverlay icon={overlay.icon} text={overlay.text} onLeave={leaveRoom} />}
    </>
  )
}
