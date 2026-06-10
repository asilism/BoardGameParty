import { useState } from 'react'
import { ZODIAC, getZodiac } from '../shared/zodiac.js'
import { sound } from '../shared/sound.js'
import FullscreenButton from '../shared/FullscreenButton.jsx'
import { GAMES, blockedReason } from './games.js'

const MAX_PLAYERS = 5

// 온라인 방 로비. 모든 기기에서 같은 명단이 보이고,
// 각 기기는 자기 참가자를 추가/제거한다. 게임 시작은 호스트만.
export default function OnlineLobby({ room, isHost, deviceId, addPlayer, removePlayer, setScreen, onLeave, notice }) {
  const [adding, setAdding] = useState(false)
  const [nameInput, setNameInput] = useState('')

  const players = room.players
  const taken = new Set(players.map((p) => p.zodiacId))
  const full = players.length >= MAX_PLAYERS
  const myCount = players.filter((p) => p.deviceId === deviceId).length

  const joinUrl = `${location.origin}${location.pathname}?room=${room.code}`

  function handleAdd(zodiacId) {
    if (taken.has(zodiacId) || full) return
    sound.step()
    const z = getZodiac(zodiacId)
    addPlayer({ zodiacId, name: nameInput.trim() || z.name })
    setNameInput('')
  }

  async function copyInvite() {
    sound.unlock()
    try {
      await navigator.clipboard.writeText(joinUrl)
    } catch {
      /* 클립보드 미지원 → 코드를 보고 입력 */
    }
  }

  return (
    <div className="lobby online-lobby">
      <header className="lobby__header">
        <div className="lobby__titles">
          <h1>🌐 온라인 방</h1>
          <p>{isHost ? '친구들에게 코드를 알려주세요!' : '호스트가 게임을 고르면 시작돼요'}</p>
        </div>
        <div className="topbar__right">
          <button className="btn btn--ghost" onClick={onLeave}>
            ← 나가기
          </button>
          <FullscreenButton />
        </div>
      </header>

      <section className="room-code">
        <div className="room-code__box" onClick={copyInvite} title="초대 주소 복사">
          <span className="room-code__label">방 코드</span>
          <span className="room-code__value">{room.code}</span>
        </div>
        <div className="room-code__info">
          <p>📲 친구 기기에서 같은 주소로 접속 → <b>코드로 참여</b></p>
          <p className="room-code__url">{joinUrl}</p>
          <p className="room-code__devices">연결된 기기 {room.deviceCount}대 · 참가자 {players.length}/{MAX_PLAYERS}</p>
        </div>
      </section>

      {notice && (
        <div className={`net-toast ${notice.tone === 'info' ? 'net-toast--info' : ''}`}>{notice.text}</div>
      )}

      {/* 참가자 관리 — 모든 기기의 참가자가 합쳐져 보인다 */}
      <section className="roster">
        <div className="roster__bar">
          <span className="roster__title">참가자 {players.length}/{MAX_PLAYERS}</span>
          <button
            className="btn btn--ghost roster__add-btn"
            disabled={full}
            onClick={() => {
              sound.unlock()
              setAdding((v) => !v)
            }}
          >
            {adding ? '닫기' : myCount ? '+ 이 기기에서 더 추가' : '+ 내 참가자 추가'}
          </button>
        </div>

        {players.length === 0 && !adding && (
          <p className="roster__empty">각자 자기 기기에서 참가자를 추가해 주세요</p>
        )}

        {players.length > 0 && (
          <div className="roster__list">
            {players.map((p) => {
              const z = getZodiac(p.zodiacId)
              const mine = p.deviceId === deviceId
              const canRemove = mine || isHost
              const offline = p.online === false // 기기 연결이 잠시 끊김(복귀 대기 중)
              return (
                <div
                  key={p.id}
                  className={`player-chip ${mine ? 'player-chip--mine' : ''} ${offline ? 'player-chip--offline' : ''}`}
                  style={{ '--z-color': z.color }}
                >
                  <span className="player-chip__emoji">{z.emoji}</span>
                  <span className="player-chip__name">{p.name}</span>
                  {mine && <span className="player-chip__tag">내 기기</span>}
                  {offline && <span className="player-chip__tag player-chip__tag--off">연결 끊김</span>}
                  {canRemove && (
                    <button
                      className="player-chip__x"
                      aria-label={`${p.name} 빼기`}
                      onClick={() => {
                        sound.unlock()
                        removePlayer(p.id)
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {adding && (
          <div className="roster__add">
            <input
              className="name-input"
              type="text"
              value={nameInput}
              maxLength={6}
              placeholder="이름 (선택)"
              onChange={(e) => setNameInput(e.target.value)}
            />
            <p className="setup__hint">이름을 적고 말을 고르면 추가돼요 (이름 생략 가능)</p>
            <div className="zodiac-grid">
              {ZODIAC.map((z) => {
                const used = taken.has(z.id)
                return (
                  <button
                    key={z.id}
                    className={`zodiac-cell ${used ? 'zodiac-cell--used' : ''}`}
                    style={{ '--z-color': z.color }}
                    disabled={used || full}
                    onClick={() => handleAdd(z.id)}
                  >
                    <span className="zodiac-cell__emoji">{z.emoji}</span>
                    <span className="zodiac-cell__name">{z.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* 게임 목록 — 시작은 호스트만 */}
      {!isHost && <p className="online-lobby__wait">⏳ 호스트가 게임을 고르는 중이에요...</p>}
      <div className={`lobby__grid ${!isHost ? 'lobby__grid--readonly' : ''}`}>
        {GAMES.map((g) => {
          const blocked = blockedReason(g, players.length)
          return (
            <button
              key={g.id}
              className={`game-card ${blocked ? 'game-card--disabled' : ''}`}
              disabled={!!blocked || !isHost}
              onClick={() => {
                if (blocked || !isHost) return
                sound.unlock()
                setScreen(g.id)
              }}
            >
              <span className="game-card__emoji">{g.emoji}</span>
              <span className="game-card__title">{g.title}</span>
              <span className="game-card__desc">{g.desc}</span>
              {g.ready && g.minPlayers != null && (
                <span className="game-card__players">
                  👥 {g.minPlayers}~{g.maxPlayers}명
                </span>
              )}
              {blocked && <span className="game-card__lock">{blocked}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
