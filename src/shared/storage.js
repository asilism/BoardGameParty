// 오프라인 모드 로컬 저장. 현재는 오프라인만 지원하므로 참가자(roster)를
// localStorage에 보관해 새로고침/재방문 시에도 유지한다.
// (쿠키는 서버 전송용이라 부적합 → 로컬 보존엔 localStorage 사용)
// 온라인 모드가 생기면 이 모듈만 서버 동기화로 교체하면 된다.
import { getZodiac } from './zodiac.js'

const KEY = 'bgp.roster.v1'
const MAX = 5

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

// ── 리프트 조작 방식(mobile/wasd/xbox) 보존 ──
// 'lol'(롤 방식)은 추후 도입 예정이라 저장 대상에서 제외한다.
const RIFT_CTRL_KEY = 'bgp.rift.control.v1'
const RIFT_CTRL_VALID = new Set(['mobile', 'wasd', 'xbox'])

// 저장된 조작 방식을 복원. 없으면 터치 지원 여부로 기본값을 고른다.
export function loadRiftControl() {
  try {
    const v = localStorage.getItem(RIFT_CTRL_KEY)
    if (v && RIFT_CTRL_VALID.has(v)) return v
  } catch {
    /* 무시 */
  }
  // 기본값: 터치 가능 기기는 모바일, 그 외엔 WASD 키보드
  const touch = typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0)
  return touch ? 'mobile' : 'wasd'
}

export function saveRiftControl(scheme) {
  if (!RIFT_CTRL_VALID.has(scheme)) return
  try {
    localStorage.setItem(RIFT_CTRL_KEY, scheme)
  } catch {
    /* 무시 */
  }
}
