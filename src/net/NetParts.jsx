// 온라인 모드 공용 UI 조각들.

// 게스트가 호스트의 상태를 기다리는 동안 보여주는 화면
export function NetWaiting({ text = '호스트가 게임을 준비하고 있어요...', onExit }) {
  return (
    <div className="net-screen">
      <div className="net-screen__icon">⏳</div>
      <p>{text}</p>
      {onExit && (
        <button className="btn btn--ghost" onClick={onExit}>
          ← 방 나가기
        </button>
      )}
    </div>
  )
}

// 화면 전체를 덮는 안내(재접속 중 / 호스트 기다리는 중).
// 현재 화면(로비/게임)은 뒤에 그대로 두고 잠시 가려만 둔다.
export function NetOverlay({ icon = '⏳', text, onLeave, leaveLabel = '← 방 나가기' }) {
  return (
    <div className="net-overlay">
      <div className="net-overlay__icon">{icon}</div>
      <p>{text}</p>
      {onLeave && (
        <button className="btn btn--ghost" onClick={onLeave}>
          {leaveLabel}
        </button>
      )}
    </div>
  )
}

// 승리 모달에서 게스트에게 보여주는 안내(다시하기는 호스트만)
export function GuestRestartNote() {
  return <p className="net-guest-note">🌐 호스트가 다시하기를 누르면 함께 시작돼요</p>
}

// 온라인 시작 시 순서를 무작위로 섞는다 (차례 정하기 화면은 한 기기 모드 전용)
export function shufflePlayers(players) {
  const a = [...players]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
