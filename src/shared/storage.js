// 로컬 저장 모음.
//  - 한 기기(핫시트) 모드의 참가자(roster)
//  - 온라인 방 세션(방 코드): 브라우저가 튕기거나 새로고침해도 같은 방으로 자동 복귀
// (쿠키는 서버 전송용이라 부적합 → 로컬 보존엔 localStorage 사용)
import { getZodiac } from './zodiac.js'

const KEY = 'bgp.roster.v1'
const MAX = 5

const SESSION_KEY = 'bgp.session.v1'
const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2시간 지나면 자동 복귀 안 함

// 저장된 참가자를 안전하게 복원. 손상/구버전/중복/없는 12지신은 걸러낸다.
export function loadRoster() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    const seen = new Set()
    const out = []
    for (const p of data) {
      if (!p || typeof p.zodiacId !== 'string') continue
      const z = getZodiac(p.zodiacId)
      if (!z || seen.has(p.zodiacId)) continue
      seen.add(p.zodiacId)
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 6) : z.name
      out.push({ id: p.zodiacId, zodiacId: p.zodiacId, name })
      if (out.length >= MAX) break
    }
    return out
  } catch {
    return []
  }
}

// 참가자 저장. 실패해도(스토리지 비활성/용량초과) 앱이 죽지 않게 무시.
export function saveRoster(roster) {
  try {
    localStorage.setItem(KEY, JSON.stringify(roster))
  } catch {
    /* 무시 */
  }
}

// ── 온라인 방 세션 ──
// 방에 들어가면 코드를 저장해 두고, 앱이 다시 켜질 때 같은 방으로 자동 복귀를 시도한다.
// (서버는 같은 deviceId를 잠시 기억하므로 유예 안에 돌아오면 참가자도 그대로)
export function saveSession(code) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code, at: Date.now() }))
  } catch {
    /* 무시 */
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const { code, at } = JSON.parse(raw)
    if (typeof code !== 'string' || !code) return null
    if (typeof at !== 'number' || Date.now() - at > SESSION_TTL_MS) return null
    return code
  } catch {
    return null
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* 무시 */
  }
}
