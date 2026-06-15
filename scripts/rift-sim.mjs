// 파티 리프트 봇 시뮬레이션 — 전원 봇 게임을 헤드리스로 돌려
// "정글에 갇힘 / 제자리 정체 / 진행 안 됨" 같은 어색한 동작을 통계로 잡아낸다.
//
//   node scripts/rift-sim.mjs            # 3v3 + 5v5 각 1판
//   node scripts/rift-sim.mjs 5v5 8      # 5v5를 시드 바꿔 8판
//
// 사람이 안 끼는 전원 봇 대전이라, 봇 AI만의 행동을 결정적으로 관찰할 수 있다.
import { createGame, step, STEP, COUNTDOWN_TIME, TIME_LIMIT, CLASS_IDS, BOT_STUCK_T } from '../src/games/rift/engine.js'
import { LANE_IDS } from '../src/games/rift/map.js'

const ZODIACS = ['rat', 'ox', 'tiger', 'rabbit', 'dragon', 'snake', 'horse', 'sheep', 'monkey', 'rooster', 'dog', 'pig']

// 결정적 RNG (mulberry32) — 시드를 바꿔 여러 판을 비교한다.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 전원 봇 플레이어 구성 (팀당 teamSize명, 직업은 6종을 돌려 배정)
function allBots(teamSize) {
  const players = []
  let zi = 0
  for (const team of ['blue', 'red']) {
    for (let i = 0; i < teamSize; i++) {
      players.push({
        id: `${team}${i}`, name: `${team[0].toUpperCase()}${i}`,
        zodiacId: ZODIACS[zi++ % ZODIACS.length], color: '#abc',
        team, cls: CLASS_IDS[i % CLASS_IDS.length], isBot: true,
      })
    }
  }
  return players
}

// 한 영웅의 "구역"을 분류 — 어디서 시간을 보내는지 보려고.
function zoneOf(g, h) {
  const en = h.team === 'blue' ? 'red' : 'blue'
  // 우물 근처
  const home = g.map.NEXUS_POS[h.team]
  if (Math.hypot(h.x - home.x, h.z - home.z) < g.map.FOUNTAIN_RADIUS + 4) return 'fountain'
  // 정글 캠프 근처
  for (const c of g.map.WOLF_CAMPS) {
    if (Math.hypot(h.x - c.x, h.z - c.z) < 14) return 'jungle'
  }
  if (Math.hypot(h.x - g.map.DRAGON_PIT.x, h.z - g.map.DRAGON_PIT.z) < 14) return 'jungle'
  if (Math.hypot(h.x - g.map.BARON_PIT.x, h.z - g.map.BARON_PIT.z) < 14) return 'jungle'
  // 가장 가까운 레인
  let best = 'jungle', bd = 16
  for (const lane of LANE_IDS) {
    for (const wp of g.map.LANES[lane]) {
      const d = Math.hypot(h.x - wp.x, h.z - wp.z)
      if (d < bd) { bd = d; best = 'lane' }
    }
  }
  return best
}

function simulate(mode, seed) {
  const teamSize = mode === '5v5' ? 5 : 3
  const g = createGame(allBots(teamSize), { mode, rng: rng(seed) })

  // 영웅별 추적 상태
  const track = new Map()
  for (const h of g.heroes) {
    track.set(h.id, {
      h, recalls: 0, prevRecall: false, stuckPeak: 0, stuckSamples: 0,
      zone: { fountain: 0, jungle: 0, lane: 0 },
      // 진행 정체 감지: 위치가 오래 거의 안 변하면 카운트
      lastX: h.x, lastZ: h.z, motionless: 0, maxMotionless: 0,
      // 본진(우물)에서 한 발짝도 진출 못 한 시간
      farthestFromHome: 0,
    })
  }

  // 카운트다운 소진
  while (g.status === 'countdown') step(g, STEP)

  const totalSteps = Math.round((TIME_LIMIT + 2) / STEP)
  let steps = 0
  for (; steps < totalSteps && g.status === 'playing'; steps++) {
    step(g, STEP)
    // 4틱(약 15Hz)마다 샘플링
    if (steps % 4 !== 0) continue
    const dt = STEP * 4
    for (const h of g.heroes) {
      const t = track.get(h.id)
      if (h.respawnT > 0) { t.lastX = h.x; t.lastZ = h.z; continue }
      // 귀환(구제) 카운트
      if (h.botRecall && !t.prevRecall) t.recalls++
      t.prevRecall = h.botRecall
      // 끼임 게이지
      t.stuckPeak = Math.max(t.stuckPeak, h.botStuckT || 0)
      if ((h.botStuckT || 0) > 0.1) t.stuckSamples++
      // 구역 시간
      t.zone[zoneOf(g, h)] += dt
      // 정체(거의 안 움직임) — 우물에 의도적으로 머무는 건 제외
      const moved = Math.hypot(h.x - t.lastX, h.z - t.lastZ)
      const home = g.map.NEXUS_POS[h.team]
      const inFount = Math.hypot(h.x - home.x, h.z - home.z) < g.map.FOUNTAIN_RADIUS + 2
      if (moved < 0.3 && !inFount) {
        t.motionless += dt
        t.maxMotionless = Math.max(t.maxMotionless, t.motionless)
      } else {
        t.motionless = 0
      }
      t.farthestFromHome = Math.max(t.farthestFromHome, Math.hypot(h.x - home.x, h.z - home.z))
      t.lastX = h.x; t.lastZ = h.z
    }
  }

  const gameTime = g.time - COUNTDOWN_TIME
  return { g, track, gameTime, finished: g.status === 'finished', mode, seed }
}

function report({ g, track, gameTime, finished, mode, seed }) {
  console.log(`\n══════ ${mode}  seed=${seed} ══════`)
  console.log(`결과: ${finished ? `🏆 ${g.winner} 승리` : '⏱️ 시간초과(미결착)'} · 경과 ${gameTime.toFixed(0)}s · 킬 blue ${g.kills.blue} / red ${g.kills.red} · 부순타워 blue ${g.towersDown.blue} / red ${g.towersDown.red}`)
  const aliveNexus = `넥서스 HP blue ${Math.ceil(g.nexus.blue.hp)} / red ${Math.ceil(g.nexus.red.hp)}`
  console.log(aliveNexus)
  console.log('─'.repeat(92))
  console.log('영웅       직업      역할     Lv  K/D   끼임peak  귀환  최대정체s  최원진출  구역(우물/정글/레인 %)')
  const flagsAll = []
  for (const [, t] of track) {
    const h = t.h
    const ztot = t.zone.fountain + t.zone.jungle + t.zone.lane || 1
    const pct = (v) => Math.round((v / ztot) * 100)
    const flags = []
    if (t.stuckPeak > BOT_STUCK_T) flags.push('STUCK')
    if (t.maxMotionless > 5) flags.push(`정체${t.maxMotionless.toFixed(0)}s`)
    if (pct(t.zone.jungle) > 50) flags.push('정글틀어박힘')
    if (t.farthestFromHome < 30) flags.push('본진못벗어남')
    const tag = `${h.team}${h.id.slice(-1)}`
    console.log(
      `${tag.padEnd(9)} ${h.cls.padEnd(9)} ${(h.role || '-').padEnd(8)} ${String(h.lvl).padStart(2)}  ${h.kills}/${h.deaths}`.padEnd(44) +
      `${t.stuckPeak.toFixed(1).padStart(7)}  ${String(t.recalls).padStart(4)}  ${t.maxMotionless.toFixed(0).padStart(8)}s  ${t.farthestFromHome.toFixed(0).padStart(7)}   ${pct(t.zone.fountain)}/${pct(t.zone.jungle)}/${pct(t.zone.lane)}` +
      (flags.length ? `   ⚠️ ${flags.join(',')}` : '')
    )
    if (flags.length) flagsAll.push(`${tag}(${h.cls}/${h.role}): ${flags.join(',')}`)
  }
  return flagsAll
}

// ── 실행 ──
const arg = process.argv[2]
const count = Number(process.argv[3]) || 1
const modes = arg === '3v3' || arg === '5v5' ? [arg] : ['3v3', '5v5']

const allFlags = []
for (const mode of modes) {
  for (let s = 0; s < count; s++) {
    const seed = 1000 + s * 7
    const res = simulate(mode, seed)
    const flags = report(res)
    allFlags.push(...flags.map((f) => `[${mode} s${seed}] ${f}`))
  }
}

console.log('\n══════ 요약: 어색한 동작 플래그 ══════')
if (allFlags.length === 0) console.log('✅ 끼임/정체/정글틀어박힘 없음')
else allFlags.forEach((f) => console.log('  ⚠️ ' + f))
