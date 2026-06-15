// 파티 리프트 순수 게임 로직 (호스트 권위) — 3:3 AOS.
//  - 이동(조이스틱) + 버튼 3개: 기본공격 / 직업 스킬 / 궁극기.
//  - 직업 6종(전사/궁수/마법사/힐러/암살자/탱커) — 한 팀에 같은 직업 금지.
//  - 레벨 최대 18, 미니언·정글·용·바론으로 성장, 넥서스가 터지면 끝.
//  - 수풀 은신 + 전장의 안개: 시야 밖 적은 안 보인다 (봇도 같은 규칙).
//  - 호스트가 step()을 60Hz로 돌리고 makeView() 스냅샷을 전파한다.
import {
  NEXUS_POS, NEXUS_RADIUS, TOWER_RADIUS, FOUNTAIN_RADIUS, LANE_IDS, enemyOf, buildMap,
} from './map.js'
import { getZodiac } from '../../shared/zodiac.js'
import { ITEM_SLOTS, SELL_REFUND, ITEMS_BY_ID, sumStats } from './items.js'

export { ITEM_SLOTS } from './items.js'

export const STEP = 1 / 60
export const COUNTDOWN_TIME = 3
export const TIME_LIMIT = 600 // 10분 — 넥서스가 안 터지면 점수로 판정
export const MAX_LEVEL = 18
export const ULT_LEVEL = 3 // 궁극기가 열리는 레벨
export const TEAM_SIZE = 3 // 기본(3:3) 팀 인원 — 하위호환용 별칭
// 모드별 팀 인원. 5:5는 탑/미드/봇 + 봇을 지원하는 힐러 + 정글러 구성.
export const TEAM_SIZES = { '3v3': 3, '5v5': 5 }
export const GAME_MODES = ['3v3', '5v5']
// 봇 역할 배정 우선순위(인원이 모자라면 앞에서부터 채운다).
//  · support = 봇 레인에서 원거리 딜러를 지원(힐러 성향)
//  · jungle  = 정글 캠프/오브젝트를 돌다 교전에 합류
const BOT_ROLES = {
  '3v3': ['mid', 'top', 'bot'],
  '5v5': ['mid', 'jungle', 'bot', 'support', 'top'],
}
// 역할 → 행군할 레인 (jungle은 별도 로직, 기본값 mid)
const laneOfRole = (role) => (role === 'support' ? 'bot' : LANE_IDS.includes(role) ? role : 'mid')

// ── 직업 (한 팀에 같은 직업은 한 명만) ──
// 기본공격은 모두 자동 조준이지만 사거리/속도/딜이 다르고,
// 스킬과 궁극기는 직업마다 완전히 다르다.
export const CLASSES = {
  warrior: {
    name: '전사', icon: '⚔️', desc: '돌진해서 베는 근접 딜러',
    hp: 620, hpLvl: 70, atk: 62, atkLvl: 9, range: 3.8, atkCd: 0.7, speed: 14.2, def: 0.85,
    skill: { name: '베며 돌진', icon: '💨', cd: 7, desc: '앞으로 돌진하며 길을 가르고 착지 지점을 후려쳐 기절' },
    ult: { name: '회전베기', icon: '🌪️', cd: 40, desc: '주변을 크게 휩쓴다' },
  },
  archer: {
    name: '궁수', icon: '🏹', desc: '제일 긴 사거리·제일 약한 몸의 원거리 딜러',
    hp: 360, hpLvl: 38, atk: 50, atkLvl: 9, range: 12.5, atkCd: 0.65, speed: 12.8,
    skill: { name: '꿰뚫는 화살', icon: '🏹', cd: 6, desc: '앞으로 화살을 쏴 일직선의 적을 모두 관통' },
    ult: { name: '화살비', icon: '☄️', cd: 42, desc: '멀리 있는 적 머리 위로 화살 폭격' },
  },
  mage: {
    name: '마법사', icon: '🔮', desc: '폭발 마법의 광역 딜러',
    hp: 430, hpLvl: 46, atk: 42, atkLvl: 7, range: 10.5, atkCd: 0.9, speed: 12.5,
    skill: { name: '화염구', icon: '🔥', cd: 6, desc: '크게 터지는 불덩이를 날린다' },
    ult: { name: '번개폭풍', icon: '⛈️', cd: 45, desc: '주변 모든 적 감전 + 기절' },
  },
  healer: {
    name: '힐러', icon: '💚', desc: '아군을 살리는 서포터',
    hp: 470, hpLvl: 52, atk: 38, atkLvl: 6, range: 9.5, atkCd: 0.9, speed: 12.8,
    skill: { name: '치유', icon: '💞', cd: 8, desc: '제일 아픈 아군(나 포함)을 회복' },
    ult: { name: '성역', icon: '✨', cd: 50, desc: '주변 아군 모두 크게 회복 + 기절 해제' },
  },
  assassin: {
    name: '암살자', icon: '🥷', desc: '제일 빠른 발·높은 공격력이지만 몸이 약한 기습 딜러',
    hp: 430, hpLvl: 44, atk: 70, atkLvl: 10, range: 4.2, atkCd: 0.55, speed: 15, def: 0.9,
    skill: { name: '점멸습격', icon: '🌀', cd: 8, desc: '적 등 뒤로 순간이동해 벤다' },
    ult: { name: '그림자처형', icon: '☠️', cd: 38, desc: '빈사 상태 적에게 2배 일격, 처치 시 점멸 초기화' },
  },
  tank: {
    name: '탱커', icon: '🛡️', desc: '앞장서서 버티는 방패 — 느리지만 단단하다',
    hp: 800, hpLvl: 94, atk: 44, atkLvl: 6, range: 3.8, atkCd: 0.85, speed: 10.8, def: 0.8,
    skill: { name: '방패막기', icon: '🛡️', cd: 9, desc: '3초간 받는 피해 65% 감소 + 돌진 가속' },
    ult: { name: '대지균열', icon: '💥', cd: 44, desc: '앞으로 땅을 길게 갈라 길목의 적을 길게 기절' },
  },
}
export const CLASS_IDS = Object.keys(CLASSES)

// ── 공용 수치 ──
const HERO_RADIUS = 1.3
const BOLT_SPEED = 38
const FIREBALL_RANGE = 24
const FIREBALL_SPEED = 30
const FIREBALL_AOE = 5
const DASH_DIST = 13
const DASH_AIM = 16
const DASH_HALF = 2.6 // 돌진 경로 피해 폭(반)
const DASH_CONE = 5 // 착지 시 전방 베기 반경
const BLINK_RANGE = 18
const EXECUTE_RANGE = 9
const SHIELD_TIME = 3
const SHIELD_CUT = 0.35 // 방패막기 중 받는 피해 배율
const HEAL_RANGE = 14
const RAIN_RANGE = 26
const RAIN_AOE = 7
const STORM_RADIUS = 13
const WHIRL_RADIUS = 9
const VOLLEY_RANGE = 17 // 궁수 꿰뚫는 화살 사거리(앞으로 직선)
const VOLLEY_HALF = 1.8 // 화살 직선 폭(반)
const FISSURE_LEN = 18 // 탱커 대지균열 길이(앞으로 직선)
const FISSURE_HALF = 3.5 // 대지균열 폭(반)

export const SIGHT_RANGE = 24 // 아군 유닛 주변 이만큼이 우리 시야
export const BUSH_REVEAL = 4 // 수풀 속 적도 이만큼 붙으면 보인다
const REVEAL_TIME = 1.5 // 공격하면 이만큼 모습이 드러난다
const ATK_SLOW_T = 0.3 // 공격 직후 발이 무거운 시간 (무빙샷 견제)
const ATK_SLOW = 0.55 // 그동안의 이동 속도 배율

const REGEN_DELAY = 5 // 전투 이탈 후 자연 회복까지 (초)
const REGEN_RATE = 0.015 // 초당 최대 HP 비율
const FOUNTAIN_HEAL = 0.12
const FOUNTAIN_DMG = 90 // 적 우물에 들어가면 따끔!
const XP_RANGE = 22 // 처치 경험치를 나눠 받는 거리
const TOWER_AGGRO_TIME = 3 // 적 영웅을 때리면 타워가 이만큼 노린다
export const RECALL_TIME = 4 // 귀환 시전(채널링) 시간 — 방해 없이 버티면 우물로 복귀

// ── 미니언 ──
const WAVE_PERIOD = 14 // 스폰 간격 — 한 무리가 라인 중앙에 닿을 무렵 다음 무리가 나온다
const FIRST_WAVE = 2
const MINION_SPEED = 6.5
const MINION_SIGHT = 11
// 타워 피해(TOWER_DMG_MINION=60) 기준: 원거리는 2대(≤120), 근접은 3대(120<hp≤180)에 죽는다
const MELEE = { hp: 165, dmg: 33.6, range: 2.4, cd: 1.1 }
const RANGED = { hp: 110, dmg: 26.4, range: 8, cd: 1.4 }
// 미니언끼리는 피해를 크게 줄여(40%) 라인 교전이 천천히 진행되게 한다.
//  → 미니언 vs 미니언만 붙으면 잘 안 죽고 웨이브가 쌓이지만,
//    유저가 끼어들어 적 미니언을 빠르게 정리하면 살아남은 우리 웨이브가 타워를 민다.
//  → 영웅/타워에게는 제값(부담은 되되 한 마리는 무시할 만하고, 여럿이면 위협).
const MINION_VS_MINION = 0.4
const MINION_HP_GROWTH = 5 // 분당 체력 증가 (타워 피격 설계가 오래 유지되게 완만히)
const MINION_XP = 28

// ── 골드 / 상점 ──
// 미니언/정글몹/타워/적 영웅을 "처치(막타)"하면 골드를 얻어 우물 상점에서 아이템을 산다.
const START_GOLD = 300 // 시작 골드 (싼 아이템 하나는 바로 살 수 있게)
const GOLD_PASSIVE = 0.8 // 초당 자동 수입 (파밍이 안 풀려도 천천히 모이게)
const GOLD_MINION_MELEE = 13 // 근접 미니언 막타
const GOLD_MINION_RANGED = 11 // 원거리 미니언 막타
const GOLD_WOLF = 24
const GOLD_DRAGON = 45 // 용 — 팀 전원
const GOLD_BARON = 65 // 바론 — 팀 전원
const GOLD_TOWER = 48 // 타워 파괴 — 팀 전원
const GOLD_KILL = 75 // 적 영웅 처치 — 킬러
const MINION_DEFEND_RANGE = 14 // 이 거리 안 아군 영웅이 적 영웅에게 맞으면 가해자를 노린다
const MINION_DEFEND_LEASH = 16 // 가해자를 쫓다 시작점에서 이만큼 벗어나면 포기하고 레인 복귀
const MINION_DEFEND_HURT_T = 1.5 // 아군이 최근 이 시간 안에 맞았어야 "공격받는 중"으로 본다

// ── 타워/넥서스 ──
const TOWER_HP = [0, 900, 1100, 1500] // tier 1(외곽) / 2(내곽) / 3(넥서스 최후의 포탑)
export const TOWER_RANGE = 13
const TOWER_CD = 1.2
const TOWER_DMG_HERO = 180 // 영웅 기본 피해 — 같은 영웅을 연속으로 맞히면 점점 세진다
const TOWER_DMG_MINION = 60
// 타워 응징 가중: 같은 영웅을 연달아 맞힐 때마다 피해 배율이 오른다 (다이브 응징).
//  1발째 ×1 → 2발째 ×1.9 → 3발째 ×2.8 … (최대 ×4). 표적이 바뀌거나 한 발 쉬면 초기화.
const TOWER_RAMP = 0.9
const TOWER_RAMP_MAX = 4
const TOWER_XP = 90
const NEXUS_HP = 1700

// ── 정글 ──
// 용/바론은 "분노(enrage)"를 쌓는다 — 교전이 길어질수록 피해/이동속도가 점점 오른다.
//  - 초반(저레벨) 혼자서는 분노가 쌓이기 전에 못 잡고 되레 당한다 → 셋이 모여 빨리 끝내야 한다.
//  - 6레벨쯤 딜이 붙으면 분노가 치명적이 되기 전에 혼자서도 용을 끝낼 수 있다.
//  - 바론은 체력/분노가 훨씬 높아 10레벨이어도 혼자서는 분노에 먼저 쓰러진다.
//  - 캠프를 벗어나(리시) 복귀하면 분노가 초기화된다.
const WOLF = { hp: 260, dmg: 18, range: 2.6, cd: 1.2, speed: 7, xp: 70, respawn: 45, enrage: 0, rageSpd: 0 }
const DRAGON = { hp: 1400, dmg: 26, range: 4, cd: 1.3, speed: 6, xp: 110, spawn: 60, respawn: 100, enrage: 0.5, rageSpd: 0.6 }
const BARON = { hp: 3000, dmg: 46, range: 5, cd: 1.5, speed: 5, xp: 150, spawn: 210, respawn: 120, enrage: 0.9, rageSpd: 0.6 }
const ENRAGE_MAX = 40 // 분노 누적 상한(초)
const CAMP_LEASH = 24 // 캠프에서 이만큼 멀어지면 포기하고 복귀(회복)
export const DRAGON_BUFF_T = 60 // 용 버프: 공격력 +25%
export const BARON_BUFF_T = 75 // 바론 버프: 공격력 +40% + 빠른 회복

// 아이템 보너스 헬퍼 (h.bonus는 createGame/applyItems에서 채운다 — 없으면 0 취급)
const itemBonus = (h) => h.bonus || ZERO_BONUS
const ZERO_BONUS = sumStats([])

const heroMaxHp = (h) => CLASSES[h.cls].hp + CLASSES[h.cls].hpLvl * (h.lvl - 1) + itemBonus(h).hp
const heroAtk = (h) => CLASSES[h.cls].atk + CLASSES[h.cls].atkLvl * (h.lvl - 1) + itemBonus(h).atk
const heroRange = (h) => CLASSES[h.cls].range + itemBonus(h).range
const heroSpeed = (h) => CLASSES[h.cls].speed + itemBonus(h).speed
export const xpNeed = (lvl) => 60 + 40 * (lvl - 1)
const respawnTime = (lvl) => 4 + 1.5 * lvl // 레벨이 높을수록 부활 대기 ↑ (Lv1 5.5초 → Lv18 31초)

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const emojiOf = (zodiacId) => getZodiac(zodiacId)?.emoji || '🙂'

// 진영별 출발 위치 (우물 안에 나란히 — 인원수에 맞춰 중앙 정렬)
function spawnPos(map, team, slot, teamSize) {
  const n = map.NEXUS_POS[team]
  const side = team === 'blue' ? 1 : -1
  // 넥서스와 최후의 포탑 사이(뒤쪽)에서 부활 — 둘 다와 안 겹치게
  return { x: n.x + side * 5, z: (slot - (teamSize - 1) / 2) * 5 }
}

// 시야 계산은 state(.map 보유)와 makeView 스냅샷(.nexusPos) 양쪽에서 호출된다.
const nexusOf = (snap) => (snap.map ? snap.map.NEXUS_POS : snap.nexusPos) || NEXUS_POS

// players: [{ id, name, zodiacId, color, team, cls, isBot? }]
// 같은 팀에 같은 직업이 오면(또는 직업 미지정이면) 남은 직업으로 바꿔준다.
// opts: rng 함수 또는 { mode, rng } 객체 (하위호환을 위해 둘 다 받는다).
export function createGame(players, opts = {}) {
  const o = typeof opts === 'function' ? { rng: opts } : opts
  const rng = o.rng || Math.random
  const mode = TEAM_SIZES[o.mode] ? o.mode : '3v3'
  const teamSize = TEAM_SIZES[mode]
  const map = buildMap(mode)
  const slotCount = { blue: 0, red: 0 }
  const botRoles = { blue: [...BOT_ROLES[mode]], red: [...BOT_ROLES[mode]] }
  const usedCls = { blue: new Set(), red: new Set() }
  const heroes = players.map((p) => {
    const slot = slotCount[p.team]++
    const pos = spawnPos(map, p.team, slot, teamSize)
    let cls = p.cls
    if (!CLASSES[cls] || usedCls[p.team].has(cls)) {
      cls = CLASS_IDS.find((c) => !usedCls[p.team].has(c)) || 'warrior'
    }
    usedCls[p.team].add(cls)
    return {
      id: p.id,
      name: p.name,
      zodiacId: p.zodiacId,
      color: p.color,
      team: p.team,
      cls,
      isBot: !!p.isBot,
      role: p.isBot ? botRoles[p.team].shift() || 'mid' : null,
      x: pos.x,
      z: pos.z,
      homeX: map.NEXUS_POS[p.team].x, // 우물(회복 지대) 중심 — inFountain 판정용
      homeZ: map.NEXUS_POS[p.team].z,
      mx: 0, // 이동 입력 (-1~1)
      mz: 0,
      dir: p.team === 'blue' ? 0 : Math.PI, // 바라보는 방향 (적 본진 쪽)
      lvl: 1,
      xp: 0,
      gold: START_GOLD,
      items: [], // 산 아이템 id (최대 ITEM_SLOTS칸)
      bonus: sumStats([]), // 아이템 합산 보너스 (heroMaxHp가 참조하므로 먼저)
      hp: 0, // 아래에서 직업 최대치로 채운다
      maxHp: 0,
      atkCd: 0,
      atkSeq: 0, // 공격할 때마다 +1 (렌더러의 휘두르기 모션 트리거)
      skillCd: 0,
      ultCd: 0,
      stunT: 0,
      shieldT: 0, // 탱커 방패막기 남은 시간
      slowT: 0, // 공격 직후 무거운 발 남은 시간
      recallT: 0, // 귀환 채널링 남은 시간 (>0이면 시전 중)
      respawnT: 0, // >0이면 사망 중
      bushI: -1, // 들어가 있는 수풀 (적에겐 안 보인다)
      revealT: 0, // 공격 직후 모습이 드러나는 시간
      aggroT: 0, // 적 영웅을 때린 직후 — 타워가 우선 조준
      lastHurt: -99,
      lastHitBy: null, // 마지막으로 나를 때린 영웅 (킬 크레딧)
      dragonT: 0, // 용 버프 남은 시간
      baronT: 0, // 바론 버프 남은 시간
      kills: 0,
      deaths: 0,
      // 봇 상태
      botRetreat: false,
      botStrafe: rng() * Math.PI * 2,
      botSeekT: 0, // >0이면 타워 앞에서 "딴 일"(합류/정글/지원)을 잠시 유지
      botStuckT: 0, // 제자리에 박혀 못 움직인 누적 시간 (BOT_STUCK_T 넘으면 귀환)
      botRecall: false, // 끼임 구제용 귀환을 스스로 시전 중인지
      botSlide: 1, // 벽에 붙었을 때 미끄러질 방향(±1) — steerToward가 토글
      botProgT: 0, // 마지막으로 "순 이동"이 있었던 뒤 경과 (진행 워치독)
      botLanePushT: 0, // >0이면 벽 트랩 탈출용으로 레인 행군을 강제하는 남은 시간
    }
  })
  for (const h of heroes) {
    h.maxHp = heroMaxHp(h)
    h.hp = h.maxHp
  }
  const monsters = [
    ...map.WOLF_CAMPS.map((c, i) => ({
      id: `wolf${i}`, kind: 'wolf', camp: c, x: c.x, z: c.z,
      hp: WOLF.hp, maxHp: WOLF.hp, alive: true, respawnT: 0, aggro: null,
    })),
    {
      id: 'dragon', kind: 'dragon', camp: map.DRAGON_PIT, x: map.DRAGON_PIT.x, z: map.DRAGON_PIT.z,
      hp: DRAGON.hp, maxHp: DRAGON.hp, alive: false, respawnT: DRAGON.spawn, aggro: null,
    },
    {
      id: 'baron', kind: 'baron', camp: map.BARON_PIT, x: map.BARON_PIT.x, z: map.BARON_PIT.z,
      hp: BARON.hp, maxHp: BARON.hp, alive: false, respawnT: BARON.spawn, aggro: null,
    },
  ]
  return {
    status: 'countdown', // 'countdown' | 'playing' | 'finished'
    mode,
    teamSize,
    map,
    time: 0,
    countdown: COUNTDOWN_TIME,
    winner: null, // 'blue' | 'red' | null(무승부)
    heroes,
    minions: [],
    monsters,
    towers: map.TOWER_SPOTS.map((t) => ({
      ...t, hp: TOWER_HP[t.tier], maxHp: TOWER_HP[t.tier], alive: true, cd: 0,
    })),
    nexus: {
      blue: { hp: NEXUS_HP, maxHp: NEXUS_HP },
      red: { hp: NEXUS_HP, maxHp: NEXUS_HP },
    },
    projectiles: [], // {id, kind:'bolt'|'fireball'|'towerbolt', ...}
    fx: [], // 시각 효과 {id, kind, x, z, r, t, team}
    kills: { blue: 0, red: 0 },
    towersDown: { blue: 0, red: 0 }, // 그 팀이 "부순" 적 타워 수
    feed: [], // 킬/오브젝트 피드 {seq, t, msg}
    feedSeq: 0,
    waveT: FIRST_WAVE, // 다음 미니언 웨이브까지
    nextId: 1,
    rng,
  }
}

export function setInput(state, id, { mx = 0, mz = 0 } = {}) {
  const h = state.heroes.find((p) => p.id === id)
  if (!h) return state
  h.mx = Math.max(-1, Math.min(1, Number(mx) || 0))
  h.mz = Math.max(-1, Math.min(1, Number(mz) || 0))
  return state
}

// 연결이 끊긴 참가자의 영웅은 봇이 이어받는다
export function makeBot(state, id) {
  const h = state.heroes.find((p) => p.id === id)
  if (!h || h.isBot) return null
  h.isBot = true
  h.mx = 0
  h.mz = 0
  // 비어 있는 역할(레인/정글/지원)부터 맡는다
  const roles = BOT_ROLES[state.mode] || BOT_ROLES['3v3']
  const taken = state.heroes.filter((o) => o.isBot && o.team === h.team && o !== h).map((o) => o.role)
  h.role = roles.find((r) => !taken.includes(r)) || 'mid'
  h.botStrafe = state.rng() * Math.PI * 2
  h.botStuckT = 0
  h.botRecall = false
  return h
}

function pushFeed(state, t, msg) {
  state.feed.push({ seq: ++state.feedSeq, t, msg })
  if (state.feed.length > 8) state.feed.shift()
}

function pushFx(state, kind, x, z, r, team = null) {
  state.fx.push({ id: state.nextId++, kind, x, z, r, t: 0, team })
}

// 방향성(앞으로 뻗는) 이펙트 — dir 방향, 길이 r. 렌더러가 콘/직선 + 파티클로 그린다.
function pushFxDir(state, kind, x, z, r, dir, team = null) {
  state.fx.push({ id: state.nextId++, kind, x, z, r, t: 0, team, dir })
}

const canAct = (h) => h.respawnT <= 0 && h.stunT <= 0

// 버프 포함 피해 배율 / 공격력
const dmgMult = (h) => (h.baronT > 0 ? 1.4 : h.dragonT > 0 ? 1.25 : 1)
const atkOf = (h) => heroAtk(h) * dmgMult(h)
// 주문(스킬/궁극기) 피해: 기본값 + 아이템 주문 위력, 버프 배율 포함
const abilityDmg = (h, base) => (base + itemBonus(h).power) * dmgMult(h)

// ── 시야 (전장의 안개 + 수풀 은신) ──
// state와 makeView() 스냅샷 양쪽에서 같은 필드를 쓰므로 둘 다 받을 수 있다.
// team의 시야: 아군 영웅/미니언/타워/넥서스 주변 SIGHT_RANGE.
// 수풀 속 영웅은 시야 안이어도, 같은 수풀에 들어가거나 바짝 붙어야 보인다.
export function isHeroVisible(snap, h, team) {
  if (!team || h.team === team) return true
  if (h.respawnT > 0) return true // 시체/부활은 숨길 필요 없음 (렌더러가 숨김)
  if (h.bushI >= 0 && h.revealT <= 0) {
    const br2 = BUSH_REVEAL * BUSH_REVEAL
    return snap.heroes.some(
      (a) => a.team === team && a.respawnT <= 0 && (a.bushI === h.bushI || dist2(a, h) <= br2)
    )
  }
  if (h.revealT > 0) return true
  return inSight(snap, h, team)
}

// 미니언 등 일반 유닛: 수풀 규칙 없이 시야 거리만 본다
export function isUnitVisible(snap, ent, team) {
  if (!team || ent.team === team) return true
  return inSight(snap, ent, team)
}

function inSight(snap, ent, team) {
  const r2 = SIGHT_RANGE * SIGHT_RANGE
  for (const a of snap.heroes) {
    if (a.team === team && a.respawnT <= 0 && dist2(a, ent) <= r2) return true
  }
  for (const m of snap.minions) {
    if (m.team === team && dist2(m, ent) <= r2) return true
  }
  for (const t of snap.towers) {
    if (t.team === team && t.alive && dist2(t, ent) <= r2) return true
  }
  if (dist2(nexusOf(snap)[team], ent) <= r2) return true
  return false
}

// 이 타워를 지금 공격할 수 있나 (외곽 → 내곽 → 최후의 포탑 → 넥서스 순서).
//  · tier1(외곽): 항상 가능
//  · tier2(내곽): 같은 라인 외곽이 부서져야
//  · tier3(최후의 포탑): 내곽(tier2) 중 하나라도 부서져야
export function towerVulnerable(state, tower) {
  if (tower.tier === 1) return true
  if (tower.tier === 3) {
    return state.towers.some((t) => t.team === tower.team && t.tier === 2 && !t.alive)
  }
  const outer = state.towers.find((t) => t.team === tower.team && t.lane === tower.lane && t.tier === 1)
  return !outer?.alive
}
// 넥서스는 최후의 포탑(tier3)이 부서져야 공격할 수 있다.
export function nexusVulnerable(state, team) {
  const fin = state.towers.find((t) => t.team === team && t.tier === 3)
  if (fin) return !fin.alive
  return state.towers.some((t) => t.team === team && t.tier === 2 && !t.alive)
}

// ── 공격 대상 찾기 (보이는 적 영웅 우선, 다음 가까운 유닛) ──
function nearestFoeHero(state, h, range) {
  const r2 = range * range
  let best = null
  let bd = r2
  for (const e of state.heroes) {
    if (e.team === h.team || e.respawnT > 0) continue
    if (!isHeroVisible(state, e, h.team)) continue // 수풀 매복은 자동 조준에 안 잡힌다
    const d = dist2(h, e)
    if (d < bd) {
      bd = d
      best = e
    }
  }
  return best
}

function findAttackTarget(state, h, range) {
  const hero = nearestFoeHero(state, h, range)
  if (hero) return { tk: 'hero', id: hero.id }
  // 구조물(타워/넥서스)은 몸통 반경이 커서 중심까지 못 붙는다.
  //  → 충돌체 표면까지의 거리(중심거리−반경)로 사거리를 재야 근접도 때릴 수 있다.
  //    (안 그러면 넥서스 반경 4.5 + 영웅 반경 1.3 = 5.8까지밖에 못 붙는데
  //     근접 사거리는 3.8~4.2라 영영 닿지 못한다.)
  let best = null
  let bd = range // 가장 가까운 표적까지의 "표면" 거리
  for (const m of state.minions) {
    if (m.team === h.team) continue
    const d = dist(h, m)
    if (d < bd) {
      bd = d
      best = { tk: 'minion', id: m.id }
    }
  }
  for (const m of state.monsters) {
    if (!m.alive) continue
    const d = dist(h, m)
    if (d < bd) {
      bd = d
      best = { tk: 'monster', id: m.id }
    }
  }
  for (const t of state.towers) {
    if (!t.alive || t.team === h.team || !towerVulnerable(state, t)) continue
    const d = dist(h, t) - TOWER_RADIUS
    if (d < bd) {
      bd = d
      best = { tk: 'tower', id: t.id }
    }
  }
  const en = enemyOf(h.team)
  if (nexusVulnerable(state, en) && state.nexus[en].hp > 0) {
    const d = dist(h, state.map.NEXUS_POS[en]) - NEXUS_RADIUS
    if (d < bd) best = { tk: 'nexus', id: en }
  }
  return best
}

function targetEntity(state, ref) {
  if (!ref) return null
  if (ref.tk === 'hero') {
    const e = state.heroes.find((h) => h.id === ref.id)
    return e && e.respawnT <= 0 ? e : null
  }
  if (ref.tk === 'minion') return state.minions.find((m) => m.id === ref.id) || null
  if (ref.tk === 'monster') {
    const m = state.monsters.find((o) => o.id === ref.id)
    return m?.alive ? m : null
  }
  if (ref.tk === 'tower') {
    const t = state.towers.find((o) => o.id === ref.id)
    return t?.alive ? t : null
  }
  if (ref.tk === 'nexus') {
    return state.nexus[ref.id].hp > 0 ? { ...state.map.NEXUS_POS[ref.id], team: ref.id } : null
  }
  return null
}

function getHero(state, id) {
  return state.heroes.find((p) => p.id === id)
}

// 귀환 채널링을 끊는다 (이동·피격·기절·다른 행동에 방해받으면)
function cancelRecall(h) {
  h.recallT = 0
}

// ── 귀환: 쿨다운 없이 RECALL_TIME초 집중하면 우물로 복귀. 다시 누르면 취소. ──
export function castRecall(state, id) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h) return state
  if (h.recallT > 0) {
    h.recallT = 0 // 시전 중 다시 누르면 취소
    return state
  }
  if (!canAct(h)) return state
  h.recallT = RECALL_TIME
  pushFx(state, 'recall', h.x, h.z, 3, h.team)
  return state
}

// ── 골드 / 상점 ──
// 자기 우물(넥서스 회복 지대) 안인가?
export function inFountain(h) {
  // 우물 중심은 영웅에 새겨 둔 home 좌표 (맵 크기와 무관하게 동작)
  const cx = h.homeX ?? NEXUS_POS[h.team].x
  const cz = h.homeZ ?? NEXUS_POS[h.team].z
  return (h.x - cx) ** 2 + (h.z - cz) ** 2 <= FOUNTAIN_RADIUS * FOUNTAIN_RADIUS
}
// 상점을 열 수 있나 — 우물 안이거나, 죽어 있는(부활 대기) 동안에도 가능.
export function canShop(h) {
  return h.respawnT > 0 || inFountain(h)
}

// 골드 지급 + 획득 표시(fx). 미니언 막타 등 "내가 얻은 골드"만 본인에게 떠오른다.
function awardGold(state, h, amount, x, z) {
  h.gold += amount
  if (h.respawnT <= 0) {
    state.fx.push({
      id: state.nextId++, kind: 'gold', x: x ?? h.x, z: z ?? h.z,
      r: 0, t: 0, team: h.team, owner: h.id, n: Math.round(amount),
    })
  }
}

// 팀 전원에게 골드 (용/바론/타워 같은 오브젝트)
function teamGold(state, team, amount) {
  for (const h of state.heroes) if (h.team === team) awardGold(state, h, amount)
}

// 아이템 효과를 다시 계산해 영웅 능력치에 반영 (구매/판매 시).
// 최대 체력이 늘면 그만큼 즉시 회복(우물/부활 대기 중이라 자연스럽다).
function applyItems(h) {
  const before = h.maxHp
  h.bonus = sumStats(h.items)
  h.maxHp = heroMaxHp(h)
  const gain = h.maxHp - before
  if (gain > 0 && h.respawnT <= 0) h.hp += gain // 살아 있으면 늘어난 만큼 즉시 회복
  h.hp = Math.min(h.maxHp, h.hp)
}

// 아이템 구매: (우물 안 또는 사망 중) + 빈 칸 + 골드 충분해야 한다 (호스트 권위로 검증).
export function buyItem(state, id, itemId) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h || !canShop(h)) return state
  if (h.items.length >= ITEM_SLOTS) return state
  const item = ITEMS_BY_ID[itemId]
  if (!item || h.gold < item.cost) return state
  h.gold -= item.cost
  h.items.push(itemId)
  applyItems(h)
  return state
}

// 아이템 판매: 우물 안/사망 중에만, 가격의 일부를 돌려받는다.
export function sellItem(state, id, slot) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h || !canShop(h)) return state
  const itemId = h.items[slot]
  const item = ITEMS_BY_ID[itemId]
  if (!item) return state
  h.items.splice(slot, 1)
  h.gold += Math.floor(item.cost * SELL_REFUND)
  applyItems(h)
  return state
}

// ── 기본공격: 사거리 안 가장 가까운 적에게 자동 조준 ──
export function castAttack(state, id) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h || !canAct(h) || h.atkCd > 0) return state
  const ref = findAttackTarget(state, h, heroRange(h))
  if (!ref) return state
  const tgt = targetEntity(state, ref)
  cancelRecall(h) // 공격하면 집중이 풀린다
  h.atkCd = CLASSES[h.cls].atkCd * (1 - itemBonus(h).atkSpeed)
  h.atkSeq++
  h.dir = Math.atan2(tgt.z - h.z, tgt.x - h.x)
  h.revealT = Math.max(h.revealT, REVEAL_TIME)
  h.slowT = Math.max(h.slowT, ATK_SLOW_T) // 쏘는 동안엔 발이 무겁다
  state.projectiles.push({
    id: state.nextId++, kind: 'bolt', team: h.team, owner: h.id,
    x: h.x, z: h.z, target: ref, dmg: atkOf(h), speed: BOLT_SPEED,
  })
  return state
}

// ── 직업 스킬 ──
export function castSkill(state, id) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h || !canAct(h) || h.skillCd > 0) return state
  const ok = SKILLS[h.cls](state, h)
  if (ok === false) return state // 대상이 없으면 쿨다운을 안 쓴다
  cancelRecall(h) // 스킬을 쓰면 집중이 풀린다
  h.skillCd = CLASSES[h.cls].skill.cd * (1 - itemBonus(h).cdr)
  h.revealT = Math.max(h.revealT, REVEAL_TIME)
  return state
}

const SKILLS = {
  // 전사 베며 돌진: 가까운 적 쪽으로 돌격하며 경로의 적을 베고(약하게),
  //  착지 지점 전방을 크게 후려 강타 + 짧은 기절
  warrior(state, h) {
    const foe = nearestFoeHero(state, h, DASH_AIM)
    const dir = foe ? Math.atan2(foe.z - h.z, foe.x - h.x) : h.dir
    const d = foe ? Math.min(DASH_DIST, Math.max(0, dist(h, foe) - 1.5)) : DASH_DIST
    const sx = h.x
    const sz = h.z
    h.dir = dir
    h.x += Math.cos(dir) * d
    h.z += Math.sin(dir) * d
    state.map.resolveTerrain(h, HERO_RADIUS, state.towers)
    const dmg = abilityDmg(h, 60 + 12 * (h.lvl - 1))
    lineDamage(state, h, sx, sz, dir, d + DASH_CONE, DASH_HALF, dmg * 0.6, 0) // 지나간 길의 적
    coneDamage(state, h, h.x, h.z, dir, DASH_CONE, 1.0, dmg, 0.5) // 착지 전방 강타 + 기절
    pushFxDir(state, 'dash', sx, sz, d + DASH_CONE, dir, h.team)
  },
  // 궁수 꿰뚫는 화살: 자동 조준 방향으로 직선 화살 — 일직선의 적을 모두 관통
  archer(state, h) {
    let dir = h.dir
    const ref = findAttackTarget(state, h, VOLLEY_RANGE)
    if (ref) {
      const t = targetEntity(state, ref)
      dir = Math.atan2(t.z - h.z, t.x - h.x)
    } else {
      const foe = nearestFoeHero(state, h, VOLLEY_RANGE)
      if (!foe) return false // 겨눌 적이 없으면 쿨다운을 안 쓴다
      dir = Math.atan2(foe.z - h.z, foe.x - h.x)
    }
    h.dir = dir
    lineDamage(state, h, h.x, h.z, dir, VOLLEY_RANGE, VOLLEY_HALF, atkOf(h) * 1.2, 0)
    // 시각: 앞으로 빠르게 날아가 사라지는 화살 3발(살짝 어긋나게)
    for (const off of [-0.55, 0, 0.55]) {
      state.projectiles.push({
        id: state.nextId++, kind: 'pierce', team: h.team, owner: h.id,
        x: h.x - Math.sin(dir) * off, z: h.z + Math.cos(dir) * off,
        vx: Math.cos(dir) * 46, vz: Math.sin(dir) * 46, travel: 0, max: VOLLEY_RANGE,
      })
    }
    pushFxDir(state, 'volley', h.x, h.z, VOLLEY_RANGE, dir, h.team)
  },
  // 마법사 화염구: 직선으로 날아가 크게 폭발 (적 영웅 자동 조준)
  mage(state, h) {
    let dir = h.dir
    const foe = nearestFoeHero(state, h, FIREBALL_RANGE)
    if (foe) dir = Math.atan2(foe.z - h.z, foe.x - h.x)
    h.dir = dir
    state.projectiles.push({
      id: state.nextId++, kind: 'fireball', team: h.team, owner: h.id,
      x: h.x, z: h.z, vx: Math.cos(dir) * FIREBALL_SPEED, vz: Math.sin(dir) * FIREBALL_SPEED,
      dmg: abilityDmg(h, 85 + 18 * (h.lvl - 1)),
      travel: 0,
    })
  },
  // 힐러 치유: 가까운 아군 중 제일 아픈 친구(나 포함)를 회복
  healer(state, h) {
    let best = null
    let worst = -30 // 이만큼은 아파야 낭비가 아니다
    for (const a of state.heroes) {
      if (a.team !== h.team || a.respawnT > 0 || dist(h, a) > HEAL_RANGE) continue
      const missing = a.maxHp - a.hp
      if (missing > -worst && (!best || missing > best.maxHp - best.hp)) best = a
    }
    if (!best) return false
    best.hp = Math.min(best.maxHp, best.hp + 90 + 20 * (h.lvl - 1) + itemBonus(h).power)
    pushFx(state, 'heal', best.x, best.z, 3.5, h.team)
  },
  // 암살자 점멸습격: 보이는 적 영웅 등 뒤로 순간이동 + 일격
  assassin(state, h) {
    const foe = nearestFoeHero(state, h, BLINK_RANGE)
    if (!foe) return false
    const d = dist(h, foe) || 1
    h.x = foe.x + ((foe.x - h.x) / d) * 1.8 // 등 뒤로
    h.z = foe.z + ((foe.z - h.z) / d) * 1.8
    state.map.resolveTerrain(h, HERO_RADIUS, state.towers)
    h.dir = Math.atan2(foe.z - h.z, foe.x - h.x)
    damageHero(state, foe, abilityDmg(h, 80 + 16 * (h.lvl - 1)), h)
    pushFx(state, 'blink', h.x, h.z, 3, h.team)
  },
  // 탱커 방패막기: 잠시 받는 피해 크게 감소
  tank(state, h) {
    h.shieldT = SHIELD_TIME
    pushFx(state, 'shield', h.x, h.z, 3, h.team)
  },
}

// ── 궁극기 (레벨 3부터) ──
export function castUlt(state, id) {
  if (state.status !== 'playing') return state
  const h = getHero(state, id)
  if (!h || !canAct(h) || h.ultCd > 0 || h.lvl < ULT_LEVEL) return state
  const ok = ULTS[h.cls](state, h)
  if (ok === false) return state
  cancelRecall(h) // 궁극기를 쓰면 집중이 풀린다
  h.ultCd = CLASSES[h.cls].ult.cd * (1 - itemBonus(h).cdr)
  h.revealT = Math.max(h.revealT, REVEAL_TIME)
  return state
}

const ULTS = {
  // 회전베기: 내 주변을 크게 휩쓴다
  warrior(state, h) {
    aoeDamage(state, h, h.x, h.z, WHIRL_RADIUS, abilityDmg(h, 120 + 20 * (h.lvl - 1)), 0)
    pushFx(state, 'whirl', h.x, h.z, WHIRL_RADIUS, h.team)
  },
  // 화살비: 보이는 적 영웅 머리 위로 폭격
  archer(state, h) {
    const foe = nearestFoeHero(state, h, RAIN_RANGE)
    if (!foe) return false
    aoeDamage(state, h, foe.x, foe.z, RAIN_AOE, abilityDmg(h, 130 + 22 * (h.lvl - 1)), 0)
    pushFx(state, 'rain', foe.x, foe.z, RAIN_AOE, h.team)
  },
  // 번개폭풍: 내 주변 모든 적 감전 + 기절
  mage(state, h) {
    aoeDamage(state, h, h.x, h.z, STORM_RADIUS, abilityDmg(h, 150 + 26 * (h.lvl - 1)), 1.2)
    pushFx(state, 'storm', h.x, h.z, STORM_RADIUS, h.team)
  },
  // 성역: 주변 아군 모두 크게 회복 + 기절 해제
  healer(state, h) {
    for (const a of state.heroes) {
      if (a.team !== h.team || a.respawnT > 0 || dist(h, a) > HEAL_RANGE) continue
      a.hp = Math.min(a.maxHp, a.hp + 180 + 30 * (h.lvl - 1) + itemBonus(h).power)
      a.stunT = 0
    }
    pushFx(state, 'sanctuary', h.x, h.z, HEAL_RANGE, h.team)
  },
  // 그림자처형: 가까운 적 영웅 일격 — 빈사(35% 미만)면 2배, 처치하면 점멸 초기화
  assassin(state, h) {
    const foe = nearestFoeHero(state, h, EXECUTE_RANGE)
    if (!foe) return false
    let dmg = abilityDmg(h, 160 + 26 * (h.lvl - 1))
    if (foe.hp < foe.maxHp * 0.35) dmg *= 2
    pushFx(state, 'execute', foe.x, foe.z, 3, h.team)
    damageHero(state, foe, dmg, h)
    if (foe.respawnT > 0) h.skillCd = 0 // 처형 성공 → 점멸로 빠져나가라!
  },
  // 대지균열: 앞으로 땅을 길게 갈라, 길목의 적을 길게 기절
  tank(state, h) {
    const foe = nearestFoeHero(state, h, FISSURE_LEN)
    const dir = foe ? Math.atan2(foe.z - h.z, foe.x - h.x) : h.dir
    h.dir = dir
    lineDamage(state, h, h.x, h.z, dir, FISSURE_LEN, FISSURE_HALF, abilityDmg(h, 90 + 14 * (h.lvl - 1)), 1.6)
    pushFxDir(state, 'fissure', h.x, h.z, FISSURE_LEN, dir, h.team)
  },
}

// 술식 공통: 판정 함수 pred(e)에 걸리는 모든 적(영웅/미니언/정글몹)에게 피해(+기절)
function damageInShape(state, attacker, pred, dmg, stun) {
  for (const e of state.heroes) {
    if (e.team === attacker.team || e.respawnT > 0 || !pred(e)) continue
    if (stun > 0) e.stunT = Math.max(e.stunT, stun)
    damageHero(state, e, dmg, attacker)
  }
  for (const m of [...state.minions]) {
    if (m.team !== attacker.team && pred(m)) damageMinion(state, m, dmg, attacker)
  }
  for (const m of state.monsters) {
    if (m.alive && pred(m)) damageMonster(state, m, dmg, attacker)
  }
}

// (x,z) 주변 동심원 범위 피해
function aoeDamage(state, attacker, x, z, radius, dmg, stun) {
  const r2 = radius * radius
  damageInShape(state, attacker, (e) => (e.x - x) ** 2 + (e.z - z) ** 2 <= r2, dmg, stun)
}

// 전방 직선(직사각형) 범위 피해 — (x,z)에서 dir 방향으로 length, 좌우 half폭
function lineDamage(state, attacker, x, z, dir, length, half, dmg, stun) {
  const ux = Math.cos(dir)
  const uz = Math.sin(dir)
  damageInShape(state, attacker, (e) => {
    const rx = e.x - x
    const rz = e.z - z
    const along = rx * ux + rz * uz // 진행 방향 거리
    if (along < -0.5 || along > length) return false
    return Math.abs(-uz * rx + ux * rz) <= half // 경로에서 옆으로 벗어난 거리
  }, dmg, stun)
}

// 전방 부채꼴(콘) 범위 피해 — (x,z)에서 dir 방향, 반경 range, 반각 halfAngle(rad)
function coneDamage(state, attacker, x, z, dir, range, halfAngle, dmg, stun) {
  const r2 = range * range
  damageInShape(state, attacker, (e) => {
    const rx = e.x - x
    const rz = e.z - z
    const d2 = rx * rx + rz * rz
    if (d2 > r2) return false
    if (d2 < 1) return true // 바로 앞(겹친) 적은 무조건
    let dd = Math.atan2(rz, rx) - dir
    while (dd > Math.PI) dd -= 2 * Math.PI
    while (dd < -Math.PI) dd += 2 * Math.PI
    return Math.abs(dd) <= halfAngle
  }, dmg, stun)
}

// ── 피해 처리 ──
function damageHero(state, victim, amount, attacker) {
  if (victim.respawnT > 0 || state.status !== 'playing') return
  amount *= CLASSES[victim.cls].def ?? 1 // 근접 직업은 기본 방어력이 높다
  amount *= 1 - itemBonus(victim).def // 방어 아이템: 받는 피해 감소
  if (victim.shieldT > 0) amount *= SHIELD_CUT // 방패막기!
  victim.hp -= amount
  victim.lastHurt = state.time
  if (victim.recallT > 0) victim.recallT = 0 // 피해를 받으면 귀환이 끊긴다
  if (attacker?.id) {
    victim.lastHitBy = attacker.id
    attacker.aggroT = TOWER_AGGRO_TIME // 타워 앞에서 깐족이면 타워가 노린다
    victim.revealT = Math.max(victim.revealT, 0.8) // 맞으면 잠깐 드러난다
  }
  if (victim.hp > 0) return
  // 사망!
  victim.hp = 0
  victim.deaths++
  victim.respawnT = respawnTime(victim.lvl)
  victim.stunT = 0
  victim.shieldT = 0
  victim.dragonT = 0
  victim.baronT = 0
  pushFx(state, 'death', victim.x, victim.z, 3, victim.team)
  const killer = state.heroes.find((h) => h.id === victim.lastHitBy && h.team !== victim.team)
  if (killer) {
    killer.kills++
    state.kills[killer.team]++
    awardXp(state, killer.team, victim, 90 + 15 * victim.lvl, killer)
    awardGold(state, killer, GOLD_KILL, victim.x, victim.z)
    pushFeed(state, 'kill', `${emojiOf(killer.zodiacId)} ${killer.name} ⚔️ ${emojiOf(victim.zodiacId)} ${victim.name} 처치!`)
  } else {
    state.kills[enemyOf(victim.team)]++
    pushFeed(state, 'kill', `${emojiOf(victim.zodiacId)} ${victim.name} 쓰러짐!`)
  }
}

function damageMinion(state, m, amount, attacker) {
  m.hp -= amount
  if (m.hp > 0) return
  state.minions = state.minions.filter((o) => o !== m)
  if (attacker?.team) awardXp(state, attacker.team, m, MINION_XP, attacker)
  // 막타 골드는 영웅에게만 (미니언/타워가 잡으면 없음 — 막타 챙기는 재미)
  if (attacker?.items) awardGold(state, attacker, m.ranged ? GOLD_MINION_RANGED : GOLD_MINION_MELEE, m.x, m.z)
}

function damageMonster(state, m, amount, attacker) {
  if (!m.alive) return
  m.hp -= amount
  m.lastHurt = state.time
  if (attacker?.id) m.aggro = attacker.id
  if (m.hp > 0) return
  m.alive = false
  m.aggro = null
  const spec = m.kind === 'wolf' ? WOLF : m.kind === 'dragon' ? DRAGON : BARON
  m.respawnT = spec.respawn
  if (!attacker?.team) return
  if (m.kind === 'wolf') {
    awardXp(state, attacker.team, m, WOLF.xp, attacker)
    if (attacker?.items) awardGold(state, attacker, GOLD_WOLF, m.x, m.z)
  } else {
    // 용/바론: 팀 전체 경험치 + 버프 + 골드
    teamGold(state, attacker.team, m.kind === 'dragon' ? GOLD_DRAGON : GOLD_BARON)
    for (const h of state.heroes) {
      if (h.team !== attacker.team) continue
      giveXp(state, h, spec.xp)
      if (h.respawnT > 0) continue
      if (m.kind === 'dragon') h.dragonT = DRAGON_BUFF_T
      else h.baronT = BARON_BUFF_T
    }
    pushFeed(
      state,
      m.kind,
      m.kind === 'dragon'
        ? `🐉 ${attacker.team === 'blue' ? '파랑팀' : '빨강팀'}이 용을 잡았다! 공격력 UP!`
        : `👹 ${attacker.team === 'blue' ? '파랑팀' : '빨강팀'}이 바론을 잡았다! 강해졌다!!`
    )
  }
}

function damageTower(state, t, amount, attacker) {
  if (!t.alive || !towerVulnerable(state, t)) return
  t.hp -= amount
  if (t.hp > 0) return
  t.hp = 0
  t.alive = false
  const team = attacker?.team || enemyOf(t.team)
  state.towersDown[team]++
  for (const h of state.heroes) if (h.team === team) giveXp(state, h, TOWER_XP)
  teamGold(state, team, GOLD_TOWER)
  const side = t.team === 'blue' ? '파랑' : '빨강'
  if (t.tier === 3) {
    pushFeed(state, 'tower', `💥 ${side} 최후의 포탑 파괴! 넥서스가 열렸다!`)
  } else {
    const laneName = { top: '윗길', mid: '가운데길', bot: '아랫길' }[t.lane]
    pushFeed(state, 'tower', `💥 ${side} ${laneName} ${t.tier === 1 ? '외곽' : '내곽'} 타워 파괴!`)
  }
}

function damageNexus(state, team, amount, attacker) {
  if (!nexusVulnerable(state, team)) return
  const nx = state.nexus[team]
  if (nx.hp <= 0) return
  nx.hp -= amount
  if (nx.hp > 0) return
  nx.hp = 0
  finish(state, attacker?.team || enemyOf(team))
}

function finish(state, winner) {
  state.status = 'finished'
  state.winner = winner
  pushFeed(
    state, 'nexus',
    winner ? `🏆 ${winner === 'blue' ? '파랑팀' : '빨강팀'} 승리!!` : '🤝 무승부!'
  )
}

// 종류 불문 피해 적용 (투사체 도착 등)
function applyDamage(state, ref, amount, attacker) {
  const e = targetEntity(state, ref)
  if (!e) return
  if (ref.tk === 'hero') damageHero(state, e, amount, attacker)
  else if (ref.tk === 'minion') damageMinion(state, e, amount, attacker)
  else if (ref.tk === 'monster') damageMonster(state, e, amount, attacker)
  else if (ref.tk === 'tower') damageTower(state, e, amount, attacker)
  else if (ref.tk === 'nexus') damageNexus(state, ref.id, amount, attacker)
}

// 처치 지점 근처의 같은 팀 영웅 모두에게 경험치 (킬러는 어디 있든 받는다)
function awardXp(state, team, at, amount, killer) {
  const r2 = XP_RANGE * XP_RANGE
  for (const h of state.heroes) {
    if (h.team !== team) continue
    if (h === killer || dist2(h, at) <= r2) giveXp(state, h, amount)
  }
}

function giveXp(state, h, amount) {
  if (h.lvl >= MAX_LEVEL) return
  h.xp += amount
  let up = false
  while (h.lvl < MAX_LEVEL && h.xp >= xpNeed(h.lvl)) {
    h.xp -= xpNeed(h.lvl)
    h.lvl++
    up = true
    const grow = CLASSES[h.cls].hpLvl
    h.maxHp = heroMaxHp(h)
    h.hp = Math.min(h.maxHp, h.hp + grow + h.maxHp * 0.15) // 레벨업 보너스 회복
  }
  if (up && h.respawnT <= 0) pushFx(state, 'level', h.x, h.z, 4, h.team)
  if (h.lvl >= MAX_LEVEL) h.xp = 0
}

// ── 물리 1틱 ──
export function step(state, dt) {
  state.time += dt
  if (state.status === 'countdown') {
    state.countdown = Math.max(0, COUNTDOWN_TIME - state.time)
    if (state.time >= COUNTDOWN_TIME) {
      state.status = 'playing'
      state.countdown = 0
    }
    return state
  }
  if (state.status === 'finished') return state

  stepWaves(state, dt)
  stepBots(state, dt)
  for (const h of state.heroes) stepHero(state, h, dt)
  stepMinions(state, dt)
  stepMonsters(state, dt)
  stepTowers(state, dt)
  stepProjectiles(state, dt)
  state.fx = state.fx.filter((n) => (n.t += dt) < 0.8)
  // 시간 초과: 부순 타워 → 킬 → 넥서스 체력으로 판정
  if (state.status === 'playing' && state.time >= COUNTDOWN_TIME + TIME_LIMIT) {
    const d = state.towersDown
    const k = state.kills
    const nx = state.nexus
    let w = null
    if (d.blue !== d.red) w = d.blue > d.red ? 'blue' : 'red'
    else if (k.blue !== k.red) w = k.blue > k.red ? 'blue' : 'red'
    else if (nx.blue.hp !== nx.red.hp) w = nx.blue.hp > nx.red.hp ? 'blue' : 'red'
    finish(state, w)
  }
  return state
}

// 미니언 웨이브: 세 레인마다 근접 3 + 원거리 3
function stepWaves(state, dt) {
  state.waveT -= dt
  if (state.waveT > 0) return
  state.waveT += WAVE_PERIOD
  const grow = MINION_HP_GROWTH * (state.time / 60)
  for (const team of ['blue', 'red']) {
    for (const lane of LANE_IDS) {
      for (let i = 0; i < 6; i++) {
        const ranged = i >= 3 // 0,1,2=근접 / 3,4,5=원거리
        const spec = ranged ? RANGED : MELEE
        const wps = state.map.LANES[lane]
        // 넥서스 충돌체에 끼지 않게, 본진에서 레인 쪽으로 살짝 나간 곳에서 출발
        const a = team === 'blue' ? wps[0] : wps[wps.length - 1]
        const b = team === 'blue' ? wps[1] : wps[wps.length - 2]
        const d = Math.hypot(b.x - a.x, b.z - a.z) || 1
        // 최후의 포탑(본진 앞) 너머 레인 쪽에서 출발 — 근접이 앞(중앙 쪽), 원거리가 뒤.
        const off = ranged ? 11 : 14
        state.minions.push({
          id: state.nextId++,
          team,
          lane,
          ranged,
          x: a.x + ((b.x - a.x) / d) * off + (state.rng() - 0.5) * 2.5,
          z: a.z + ((b.z - a.z) / d) * off + (state.rng() - 0.5) * 2.5,
          hp: spec.hp + grow,
          maxHp: spec.hp + grow,
          atkCd: i * 0.3, // 줄지어 공격하게 살짝 어긋나게
          dir: team === 'blue' ? 0 : Math.PI, // 바라보는 방향 (공격 모션용)
          atkSeq: 0, // 공격할 때마다 +1 (찌르기/사격 모션 트리거)
          wpI: team === 'blue' ? 1 : wps.length - 2,
        })
      }
    }
  }
}

function stepHero(state, h, dt) {
  h.atkCd = Math.max(0, h.atkCd - dt)
  h.skillCd = Math.max(0, h.skillCd - dt)
  h.ultCd = Math.max(0, h.ultCd - dt)
  h.dragonT = Math.max(0, h.dragonT - dt)
  h.baronT = Math.max(0, h.baronT - dt)
  h.shieldT = Math.max(0, h.shieldT - dt)
  h.slowT = Math.max(0, h.slowT - dt)
  h.revealT = Math.max(0, h.revealT - dt)
  h.aggroT = Math.max(0, h.aggroT - dt)
  // 부활 대기 → 우물에서 부활
  if (h.respawnT > 0) {
    h.respawnT = Math.max(0, h.respawnT - dt)
    if (h.respawnT === 0) {
      const slot = state.heroes.filter((o) => o.team === h.team).indexOf(h)
      const pos = spawnPos(state.map, h.team, slot, state.teamSize)
      h.x = pos.x
      h.z = pos.z
      h.hp = h.maxHp
      h.lastHitBy = null
      h.bushI = -1
      h.dir = h.team === 'blue' ? 0 : Math.PI
    }
    return
  }
  h.stunT = Math.max(0, h.stunT - dt)
  // 귀환 채널링: 가만히, 방해(이동/기절/피격) 없이 RECALL_TIME초 버티면 우물로 복귀
  if (h.recallT > 0) {
    const moving = Math.hypot(h.mx, h.mz) > 0.12
    if (h.stunT > 0 || moving) {
      h.recallT = 0 // 방해받음 → 취소
    } else {
      h.recallT = Math.max(0, h.recallT - dt)
      if (h.recallT === 0) {
        const slot = state.heroes.filter((o) => o.team === h.team).indexOf(h)
        const pos = spawnPos(state.map, h.team, slot, state.teamSize)
        h.x = pos.x
        h.z = pos.z
        h.dir = h.team === 'blue' ? 0 : Math.PI
        h.bushI = state.map.bushIndexAt(h.x, h.z)
        pushFx(state, 'recall', h.x, h.z, 4, h.team)
      }
    }
  }
  // 이동
  if (h.stunT <= 0) {
    const len = Math.hypot(h.mx, h.mz)
    if (len > 0.12) {
      // 공격 직후엔 발이 무겁고, 탱커는 방패막기 중 돌진 가속
      const slow = h.slowT > 0 ? ATK_SLOW : 1
      const charge = h.cls === 'tank' && h.shieldT > 0 ? 1.45 : 1
      const sp = heroSpeed(h) * slow * charge * Math.min(1, len)
      h.dir = Math.atan2(h.mz, h.mx)
      h.x += (h.mx / len) * sp * dt
      h.z += (h.mz / len) * sp * dt
    }
  }
  state.map.resolveTerrain(h, HERO_RADIUS, state.towers)
  h.bushI = state.map.bushIndexAt(h.x, h.z) // 수풀 은신 판정
  // 우물: 우리 편이면 회복, 적이면 따끔!
  for (const team of ['blue', 'red']) {
    if (dist2(h, state.map.NEXUS_POS[team]) > FOUNTAIN_RADIUS * FOUNTAIN_RADIUS) continue
    if (team === h.team) h.hp = Math.min(h.maxHp, h.hp + h.maxHp * FOUNTAIN_HEAL * dt)
    else damageHero(state, h, FOUNTAIN_DMG * dt, null)
  }
  // 자연 회복 (전투 이탈 시) + 바론 버프 회복
  if (state.time - h.lastHurt > REGEN_DELAY) {
    h.hp = Math.min(h.maxHp, h.hp + h.maxHp * REGEN_RATE * dt)
  }
  if (h.baronT > 0) h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.02 * dt)
  // 아이템 체력 재생 (전투 중에도 항상)
  if (itemBonus(h).regen > 0) h.hp = Math.min(h.maxHp, h.hp + h.maxHp * itemBonus(h).regen * dt)
  // 골드 자동 수입
  h.gold += GOLD_PASSIVE * dt
}

// 주변에서 공격받는 아군 영웅의 "가해자(적 영웅)"를 찾는다.
//  - 최근 맞은 아군이 가까이 있고, 그 가해자도 수비 사거리 안이면 그 적을 노린다.
//  - 단, 처음 끼어든 지점(anchor)에서 너무 멀어지게 쫓기 시작하면 포기하고 레인으로 복귀한다.
function findDefendTarget(state, m) {
  if (m.returnT > 0) return null // 복귀 중엔 한눈팔지 않는다
  const r2 = MINION_DEFEND_RANGE * MINION_DEFEND_RANGE
  let best = null
  let bd = r2
  for (const ally of state.heroes) {
    if (ally.team !== m.team || ally.respawnT > 0) continue
    if (state.time - ally.lastHurt > MINION_DEFEND_HURT_T) continue
    if (dist2(m, ally) > r2) continue
    const foe = state.heroes.find(
      (e) => e.id === ally.lastHitBy && e.team !== m.team && e.respawnT <= 0
    )
    if (!foe) continue
    const d = dist2(m, foe)
    if (d < bd) {
      bd = d
      best = foe
    }
  }
  return best
}

function stepMinions(state, dt) {
  for (const m of [...state.minions]) {
    m.atkCd = Math.max(0, m.atkCd - dt)
    m.returnT = Math.max(0, (m.returnT || 0) - dt)
    const spec = m.ranged ? RANGED : MELEE
    const sx0 = m.x
    const sz0 = m.z
    let marched = false

    // 0) 공격받는 아군 영웅 방어: 가해자(적 영웅)를 최우선으로 노린다
    let tgt = null
    let bd = MINION_SIGHT * MINION_SIGHT
    const defender = findDefendTarget(state, m)
    if (defender) {
      // 처음 끼어들 때 시작점을 기억해 두고, 거기서 너무 멀어지면 포기한다
      if (!m.defending) {
        m.defending = true
        m.anchorX = m.x
        m.anchorZ = m.z
      }
      if (Math.hypot(m.x - m.anchorX, m.z - m.anchorZ) > MINION_DEFEND_LEASH) {
        m.defending = false
        m.returnT = 1.5 // 잠깐 레인으로 돌아간다 (다시 끌려가지 않게)
      } else {
        tgt = { ref: { tk: 'hero', id: defender.id }, e: defender }
      }
    } else {
      m.defending = false
    }

    // 1) 평소 타게팅: 시야 안 미니언 → 영웅 → 타워/넥서스
    if (!tgt) {
      for (const o of state.minions) {
        if (o.team === m.team) continue
        const d = dist2(m, o)
        if (d < bd) {
          bd = d
          tgt = { ref: { tk: 'minion', id: o.id }, e: o }
        }
      }
    }
    if (!tgt) {
      for (const o of state.heroes) {
        if (o.team === m.team || o.respawnT > 0) continue
        if (o.bushI >= 0 && o.revealT <= 0) continue // 수풀 속은 미니언도 못 본다
        const d = dist2(m, o)
        if (d < bd) {
          bd = d
          tgt = { ref: { tk: 'hero', id: o.id }, e: o }
        }
      }
    }
    if (!tgt) {
      for (const t of state.towers) {
        if (!t.alive || t.team === m.team || !towerVulnerable(state, t)) continue
        const d = dist2(m, t)
        if (d < bd) {
          bd = d
          tgt = { ref: { tk: 'tower', id: t.id }, e: t }
        }
      }
      const en = enemyOf(m.team)
      if (nexusVulnerable(state, en) && state.nexus[en].hp > 0) {
        const np = state.map.NEXUS_POS[en]
        const d = dist2(m, np)
        if (d < bd) tgt = { ref: { tk: 'nexus', id: en }, e: np }
      }
    }
    if (tgt) {
      const d = dist(m, tgt.e)
      // 구조물은 몸통 반경만큼 더해 줘야 근접 미니언도 넥서스/타워에 닿는다
      const pad = tgt.ref.tk === 'tower' ? TOWER_RADIUS : tgt.ref.tk === 'nexus' ? NEXUS_RADIUS : 0
      if (d <= spec.range + 0.5 + pad) {
        m.dir = Math.atan2(tgt.e.z - m.z, tgt.e.x - m.x) // 적을 바라본다
        if (m.atkCd <= 0) {
          m.atkCd = spec.cd
          m.atkSeq++
          // 상대가 미니언이면 피해를 깎아 라인 교전이 천천히 풀리게 한다
          const out = tgt.ref.tk === 'minion' ? spec.dmg * MINION_VS_MINION : spec.dmg
          if (m.ranged) {
            // 원거리 미니언은 작은 화살을 쏜다 ('mbolt' — 영웅 탄과 구분되는 작은 투사체)
            state.projectiles.push({
              id: state.nextId++, kind: 'mbolt', team: m.team,
              x: m.x, z: m.z, target: tgt.ref, dmg: out, speed: 26,
            })
          } else {
            applyDamage(state, tgt.ref, out, { team: m.team })
          }
        }
      } else {
        moveMinion(state, m, tgt.e, dt)
        marched = true
      }
    } else {
      // 레인 행군: 경유지를 차례로 통과한다.
      //  - 경유지에 "닿거나" 진행 방향으로 그 지점을 "지나치면" 다음 경유지로 넘어간다.
      //  - 미드 1차 타워는 경유지(-34,0)/(34,0) 위에 서 있어 그 칸에 3 이내로
      //    못 들어간다 → 닿기만 기다리면 wpI가 안 넘어가 타워를 빙빙 돌며 라인이 멈춘다.
      //    "지나침" 판정을 더해 타워를 돌아 나가면 곧장 다음 칸을 향하게 한다.
      const wps = state.map.LANES[m.lane]
      const dirI = m.team === 'blue' ? 1 : -1
      let guard = 0
      while (guard++ < wps.length) {
        const wp = wps[m.wpI]
        const nextWp = wps[m.wpI + dirI]
        if (!wp) break
        let passed = dist(m, wp) < 3
        if (!passed && nextWp) {
          // 경유지에서 다음 경유지로 향하는 방향 기준, 미니언이 그 너머에 있으면 지나친 것
          const fx = nextWp.x - wp.x
          const fz = nextWp.z - wp.z
          if ((m.x - wp.x) * fx + (m.z - wp.z) * fz > 0) passed = true
        }
        if (passed) m.wpI += dirI
        else break
      }
      const wp = wps[m.wpI]
      if (wp) {
        // 현재 칸에 가까워지면 다음 칸을 겨눈다. 그래야 그 칸 위에 선 타워를
        // "목적지"가 아닌 "장애물"로 보고 avoidDir가 깔끔히 돌아 나간다.
        const nextWp = wps[m.wpI + dirI]
        const aim = nextWp && dist(m, wp) < 7 ? nextWp : wp
        moveMinion(state, m, aim, dt)
        marched = true
      }
    }
    state.map.resolveTerrain(m, 0.8, state.towers)
    // 끼임 감지: 가려고 했는데 거의 못 움직였으면 분노 게이지를 올리고,
    // 일정 이상 쌓이면 moveMinion이 옆으로 비껴 빠져나간다 (벽-타워 틈 탈출)
    if (marched) {
      const moved = Math.hypot(m.x - sx0, m.z - sz0)
      if (moved < MINION_SPEED * dt * 0.3) {
        if (!m.stuckT) m.stuckSide = state.rng() < 0.5 ? 1 : -1
        m.stuckT = (m.stuckT || 0) + dt
        if (m.stuckT > 1.6) m.stuckT = 0 // 한참 헤맸으면 반대쪽으로 다시 시도
      } else {
        m.stuckT = Math.max(0, (m.stuckT || 0) - dt * 1.5)
      }
    } else {
      m.stuckT = 0
    }
  }
  // 같은 자리에 겹치지 않게 서로 살짝 밀어내기
  const ms = state.minions
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i]
      const b = ms[j]
      let dx = b.x - a.x
      let dz = b.z - a.z
      const d = Math.hypot(dx, dz)
      if (d >= 1.6 || d === 0) continue
      const push = (1.6 - d) / 2
      dx /= d
      dz /= d
      a.x -= dx * push
      a.z -= dz * push
      b.x += dx * push
      b.z += dz * push
    }
  }
}

// 목표를 향해 이동하되, 길을 막는 성벽/바위/타워는 접선으로 비켜 간다.
// (자기 편 타워가 레인 위에 있어도 미니언이 끼지 않고 돌아간다)
function moveToward(state, e, to, speed, dt, selfR = 1) {
  const dir = state.map.avoidDir(e, to.x, to.z, state.towers, selfR)
  e.x += dir.x * speed * dt
  e.z += dir.z * speed * dt
  if (dir.x || dir.z) e.dir = Math.atan2(dir.z, dir.x)
}

// 미니언 전용 이동: 평소엔 회피 조향을 쓰되, 끼임이 감지되면(stuckT)
// 목표 방향에서 한쪽으로 크게 비껴 벽-타워 틈에서 빠져나간다.
function moveMinion(state, m, to, dt) {
  if ((m.stuckT || 0) > 0.4) {
    const ang = Math.atan2(to.z - m.z, to.x - m.x) + (m.stuckSide || 1) * 1.9
    m.x += Math.cos(ang) * MINION_SPEED * dt
    m.z += Math.sin(ang) * MINION_SPEED * dt
    m.dir = ang
  } else {
    moveToward(state, m, to, MINION_SPEED, dt, 0.8)
  }
}

// 정글몹: 평소엔 얌전 — 맞으면 반격, 캠프에서 멀어지면 포기하고 복귀(회복)
function stepMonsters(state, dt) {
  for (const m of state.monsters) {
    if (!m.alive) {
      m.respawnT = Math.max(0, m.respawnT - dt)
      if (m.respawnT === 0) {
        m.alive = true
        m.hp = m.maxHp
        m.x = m.camp.x
        m.z = m.camp.z
        m.combatT = 0 // 분노 초기화
        if (m.kind === 'dragon') pushFeed(state, 'spawn', '🐉 용이 나타났다! (아래 강가)')
        else if (m.kind === 'baron') pushFeed(state, 'spawn', '👹 바론이 나타났다! (위 강가)')
      }
      continue
    }
    const spec = m.kind === 'wolf' ? WOLF : m.kind === 'dragon' ? DRAGON : BARON
    m.atkCd = Math.max(0, (m.atkCd || 0) - dt)
    const tgt = m.aggro ? state.heroes.find((h) => h.id === m.aggro && h.respawnT <= 0) : null
    const far = dist(m, m.camp) > CAMP_LEASH
    if (!tgt || far || dist(m, tgt) > CAMP_LEASH) {
      m.aggro = null
      m.combatT = 0 // 캠프로 복귀 → 분노 초기화
      if (dist(m, m.camp) > 1) {
        moveToward(state, m, m.camp, spec.speed * 1.5, dt, 1.2)
        m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.5 * dt) // 복귀 중 쑥쑥 회복
      }
      continue
    }
    // 교전이 길어질수록 분노가 쌓여 피해/이동속도가 오른다 (용·바론만)
    m.combatT = Math.min(ENRAGE_MAX, (m.combatT || 0) + dt)
    const rage = 1 + spec.enrage * m.combatT
    if (dist(m, tgt) <= spec.range + 1) {
      if (m.atkCd <= 0) {
        m.atkCd = spec.cd
        damageHero(state, tgt, spec.dmg * rage, null)
      }
    } else {
      // 분노가 쌓이면 발도 빨라져 도망치는(카이팅) 사냥꾼을 따라잡는다
      moveToward(state, m, tgt, spec.speed + spec.rageSpd * m.combatT, dt, 1.2)
    }
  }
}

// 타워: 깐족거린 영웅(아군 영웅을 때린 적) → 미니언 → 영웅 순으로 조준
function stepTowers(state, dt) {
  const r2 = TOWER_RANGE * TOWER_RANGE
  for (const t of state.towers) {
    if (!t.alive) continue
    t.cd = Math.max(0, t.cd - dt)
    if (t.cd > 0) continue
    let ref = null
    let bd = r2
    // 우선순위: 평소엔 미니언 > 유저(영웅). 단, 사거리 안에서 우리 편 영웅을
    // 때린 적 영웅(다이버)이 있으면 그 영웅으로 표적을 바꿔 반격한다.
    //  → 평소엔 미니언 뒤에서 타워를 철거할 수 있지만, 전투가 벌어지면
    //    타워에 맞아 물러나야 한다.
    // 1) 우리 편 영웅을 때린 적 영웅 (반격 — 최우선)
    for (const h of state.heroes) {
      if (h.team === t.team || h.respawnT > 0 || h.aggroT <= 0) continue
      if (!isHeroVisible(state, h, t.team)) continue
      const d = dist2(t, h)
      if (d < bd) {
        bd = d
        ref = { tk: 'hero', id: h.id }
      }
    }
    // 2) 미니언
    if (!ref) {
      bd = r2
      for (const m of state.minions) {
        if (m.team === t.team) continue
        const d = dist2(t, m)
        if (d < bd) {
          bd = d
          ref = { tk: 'minion', id: m.id }
        }
      }
    }
    // 3) 미니언도 없으면 그제야 보이는 적 영웅
    if (!ref) {
      bd = r2
      for (const h of state.heroes) {
        if (h.team === t.team || h.respawnT > 0) continue
        if (!isHeroVisible(state, h, t.team)) continue
        const d = dist2(t, h)
        if (d < bd) {
          bd = d
          ref = { tk: 'hero', id: h.id }
        }
      }
    }
    if (!ref) {
      // 표적이 없으면(영웅이 빠지면) 응징 연사 게이지 초기화
      t.streak = 0
      t.streakTarget = null
      continue
    }
    t.cd = TOWER_CD
    let dmg
    if (ref.tk === 'hero') {
      // 같은 영웅을 연달아 맞히면 점점 세진다 (다이브 응징)
      if (t.streakTarget === ref.id) t.streak = (t.streak || 0) + 1
      else {
        t.streak = 0
        t.streakTarget = ref.id
      }
      dmg = TOWER_DMG_HERO * Math.min(TOWER_RAMP_MAX, 1 + TOWER_RAMP * t.streak)
    } else {
      t.streak = 0
      t.streakTarget = null
      dmg = TOWER_DMG_MINION
    }
    state.projectiles.push({
      id: state.nextId++, kind: 'towerbolt', team: t.team,
      x: t.x, z: t.z, target: ref, dmg, speed: 34,
    })
  }
}

function stepProjectiles(state, dt) {
  const remove = new Set()
  for (const p of state.projectiles) {
    if (p.kind === 'fireball') {
      // 직선 비행 — 적 영웅/미니언/정글몹에 닿으면 폭발 (주변 휩쓸기)
      p.x += p.vx * dt
      p.z += p.vz * dt
      p.travel += FIREBALL_SPEED * dt
      let hit = p.travel >= FIREBALL_RANGE
      const owner = state.heroes.find((h) => h.id === p.owner)
      const touches = (e) => dist2(p, e) < 2.6 * 2.6
      if (!hit) {
        hit =
          state.heroes.some((e) => e.team !== p.team && e.respawnT <= 0 && touches(e)) ||
          state.minions.some((e) => e.team !== p.team && touches(e)) ||
          state.monsters.some((e) => e.alive && touches(e))
      }
      if (hit) {
        remove.add(p.id)
        pushFx(state, 'boom', p.x, p.z, FIREBALL_AOE, p.team)
        if (owner) aoeDamage(state, owner, p.x, p.z, FIREBALL_AOE, p.dmg, 0)
      }
      continue
    }
    if (p.kind === 'pierce') {
      // 궁수 꿰뚫는 화살의 시각용 탄 — 피해는 시전 때 lineDamage로 이미 적용됨.
      // 앞으로 날아가다 사거리 끝에서 사라진다.
      p.x += p.vx * dt
      p.z += p.vz * dt
      p.travel += Math.hypot(p.vx, p.vz) * dt
      if (p.travel >= p.max) remove.add(p.id)
      continue
    }
    // 유도탄 (기본공격/타워) — 대상이 사라지면 같이 사라진다
    const e = targetEntity(state, p.target)
    if (!e) {
      remove.add(p.id)
      continue
    }
    const d = dist(p, e)
    if (d < 1.4) {
      remove.add(p.id)
      const owner = state.heroes.find((h) => h.id === p.owner) || { team: p.team }
      applyDamage(state, p.target, p.dmg, owner)
      // 흡혈: 기본공격 탄(bolt)이 적 유닛에 적중하면 시전자가 회복 (구조물 제외)
      const ls = p.kind === 'bolt' && owner.items ? itemBonus(owner).lifesteal : 0
      if (ls > 0 && owner.respawnT <= 0 && (p.target.tk === 'hero' || p.target.tk === 'minion' || p.target.tk === 'monster')) {
        owner.hp = Math.min(owner.maxHp, owner.hp + p.dmg * ls)
      }
      continue
    }
    p.x += ((e.x - p.x) / d) * p.speed * dt
    p.z += ((e.z - p.z) / d) * p.speed * dt
  }
  if (remove.size) state.projectiles = state.projectiles.filter((p) => !remove.has(p.id))
}

// ── 봇 AI ──
// 체력이 낮으면 우물로 후퇴, "보이는" 적 영웅과는 직업 사거리에 맞춰 교전,
// 평소엔 맡은 레인을 행군하며 지나는 길의 정글몹/용/바론도 사냥한다.
const BOT_SIGHT = 18
export const BOT_STUCK_T = 3 // 가려고도 싸우지도 못하고 이만큼 제자리면 "갈 곳 잃음"으로 보고 귀환
const JUNGLE_SEEK = 38 // 정글러가 캠프를 찾아 트래킹할 최대 거리(이보다 멀면 레인 합류로)

// 봇 직업별 아이템 우선순위 — 우물에 들어왔을 때 위에서부터 살 수 있는 걸 산다.
// (사람 플레이어가 아이템으로 일방적 우위를 갖지 않게 봇도 장비를 갖춘다)
const BOT_BUILD = {
  warrior: ['longsword', 'vampire_scythe', 'plate', 'executioner'],
  assassin: ['dagger', 'vampire_scythe', 'executioner', 'boots'],
  archer: ['rage_gloves', 'longsword', 'executioner', 'boots'],
  mage: ['orb', 'flame_core', 'void_staff', 'boots'],
  healer: ['orb', 'wisdom_hat', 'frost_staff', 'plate'],
  tank: ['leather', 'plate', 'giant_heart', 'thornmail'],
}

// 봇 자동 구매: 우물 안 + 빈 칸 있으면 빌드 우선순위에서 안 가진 첫 구매 가능 아이템을 산다.
function botShop(state, h) {
  if (h.items.length >= ITEM_SLOTS || !inFountain(h)) return
  for (const itemId of BOT_BUILD[h.cls] || []) {
    if (h.items.includes(itemId)) continue
    const item = ITEMS_BY_ID[itemId]
    if (item && h.gold >= item.cost) {
      buyItem(state, h.id, itemId)
      return
    }
  }
}

function stepBots(state, dt) {
  for (const h of state.heroes) {
    if (!h.isBot || h.respawnT > 0) continue
    if (h.stunT > 0) {
      h.mx = 0
      h.mz = 0
      continue
    }
    // ── 갈 곳 잃은 봇 구제: 끼임 감지 → 귀환으로 마을(우물) 복귀 ──
    // 스스로 시작한 귀환을 채널링하는 중이면 가만히 기다린다.
    if (h.botRecall) {
      if (h.recallT > 0) {
        h.mx = 0
        h.mz = 0
        continue
      }
      // 채널링 종료: 우물로 복귀(성공)했거나 피격으로 끊겼다(실패) — 어느 쪽이든 초기화
      h.botRecall = false
      h.botStuckT = 0
    }
    // 지난 틱 결과로 끼임을 누적한다: "가려고 했는데"(이동 입력) "싸우지도 못하고"
    // (이번에 공격 안 함) 거의 못 움직였으면(벽/타워/넥서스에 박힘) 게이지를 올린다.
    const wantedMove = Math.hypot(h.mx, h.mz) > 0.12
    const attacked = h.atkSeq !== (h.botPrevSeq ?? h.atkSeq)
    const moved = Math.hypot(h.x - (h.botPrevX ?? h.x), h.z - (h.botPrevZ ?? h.z))
    if (wantedMove && !attacked && moved < heroSpeed(h) * dt * 0.25) {
      h.botStuckT = (h.botStuckT || 0) + dt
    } else {
      h.botStuckT = Math.max(0, (h.botStuckT || 0) - dt * 2)
    }
    h.botPrevX = h.x
    h.botPrevZ = h.z
    h.botPrevSeq = h.atkSeq
    // 너무 오래 헤맸으면(우물 밖에서) 귀환을 켜고 가만히 채널링 → 우물로 순간복귀
    if ((h.botStuckT || 0) > BOT_STUCK_T && !inFountain(h)) {
      castRecall(state, h.id)
      if (h.recallT > 0) {
        h.botRecall = true
        h.mx = 0
        h.mz = 0
        continue
      }
    }
    // ── 진행 워치독(순 이동 기준): 앵커에서 8 이상 벗어나야 "실제 전진"으로 본다.
    //    틱 단위 botStuckT는 sidestep 진동(프레임당 ±0.2)에 속지만, 이건 수 초간
    //    "한 자리를 못 벗어남"을 본다. 싸우지도(attacked) 못하고 제자리면 단계적으로 구제:
    //      · >3초   → 레인 경유지 행군 강제(벽을 우회하는 유효 경로로 트랩 탈출)
    //      · >4.5초 → 그래도 못 빠지면 최후의 수단으로 귀환(우물 복귀)
    //    공격 중(타워 공성·캠프 사냥 등 생산적 정지)이면 정체로 치지 않는다. ──
    const netProg = Math.hypot(h.x - (h.botProgX ?? h.x), h.z - (h.botProgZ ?? h.z))
    if (netProg > 8 || inFountain(h) || attacked) {
      h.botProgX = h.x
      h.botProgZ = h.z
      h.botProgT = 0
    } else {
      h.botProgT = (h.botProgT || 0) + dt
    }
    h.botLanePushT = Math.max(0, (h.botLanePushT || 0) - dt)
    if (h.botProgT > 4.5 && !inFountain(h)) {
      castRecall(state, h.id) // 레인 행군으로도 못 빠져나옴 → 우물로 복귀
      if (h.recallT > 0) {
        h.botRecall = true
        h.botProgT = 0
        h.mx = 0
        h.mz = 0
        continue
      }
    } else if (h.botProgT > 3) {
      h.botLanePushT = Math.max(h.botLanePushT, 0.3) // 경유지 행군 강제(벽 우회 시도)
    }
    if (inFountain(h)) botShop(state, h) // 우물에 있을 때 장비 보충
    const cls = CLASSES[h.cls]
    // 후퇴 판단 (탱커는 더 끈질기게 버틴다)
    const panic = h.cls === 'tank' ? 0.22 : 0.3
    if (h.hp < h.maxHp * panic) h.botRetreat = true
    if (h.botRetreat && h.hp > h.maxHp * 0.85) h.botRetreat = false
    if (h.botRetreat) {
      if (h.cls === 'tank' && h.skillCd <= 0) castSkill(state, h.id) // 방패 켜고 도망!
      steerToward(state, h, state.map.NEXUS_POS[h.team])
      castAttack(state, h.id) // 도망치면서도 사거리 안이면 반격
      continue
    }
    // 힐러: 아픈 아군이 보이면 우선 치유
    if (h.cls === 'healer') {
      if (h.skillCd <= 0) castSkill(state, h.id) // 대상 없으면 안 쓴다
      if (h.ultCd <= 0 && h.lvl >= ULT_LEVEL) {
        const hurt = state.heroes.filter(
          (a) => a.team === h.team && a.respawnT <= 0 && dist(h, a) <= HEAL_RANGE && a.hp < a.maxHp * 0.55
        ).length
        if (hurt >= 2 || h.hp < h.maxHp * 0.4) castUlt(state, h.id)
      }
    }
    // 가장 가까운 "보이는" 적 영웅
    let foe = null
    let bd = BOT_SIGHT * BOT_SIGHT
    let nearCount = 0
    for (const e of state.heroes) {
      if (e.team === h.team || e.respawnT > 0) continue
      if (!isHeroVisible(state, e, h.team)) continue
      const d = dist2(h, e)
      if (d < 9 * 9) nearCount++
      if (d < bd) {
        bd = d
        foe = e
      }
    }
    if (foe) {
      const d = Math.sqrt(bd)
      // 직업 사거리에 맞춰 거리 유지(카이팅): 근접은 파고들고 원거리는 빠진다
      const kite = Math.max(2.6, cls.range - 1)
      h.botStrafe += dt * 0.7
      const away = Math.atan2(h.z - foe.z, h.x - foe.x)
      const to = Math.atan2(foe.z - h.z, foe.x - h.x)
      const chasing = d > kite + 1.2
      const ang = d < kite - 1.2 ? away : chasing ? to : away + Math.PI / 2
      // 추격 중엔 옆걸음 없이 전속 직진 — 근접이 원거리를 따라잡을 수 있게
      const wob = chasing ? 0 : 0.25
      h.mx = Math.cos(ang) * (1 - wob) + Math.cos(h.botStrafe) * wob
      h.mz = Math.sin(ang) * (1 - wob) + Math.sin(h.botStrafe) * wob
      castAttack(state, h.id)
      botCombatSkills(state, h, foe, d, nearCount)
      continue
    }
    // 교전 상대가 없으면 임무 수행
    castAttack(state, h.id) // 미니언/정글/타워 등 사거리 안 아무거나
    // 워치독이 걸렸으면(벽 트랩) 캠프 탐색을 건너뛰고 경유지 행군으로 빠져나간다.
    if (h.botLanePushT > 0) {
      botLaneMove(state, h, dt)
      continue
    }
    // 정글러: 캠프/오브젝트를 돌다 근처 교전에 합류(갱킹). 할 일이 없으면 레인 합류.
    if (h.role === 'jungle') {
      if (botJungleRole(state, h, dt)) continue
    }
    if (h.botSeekT > 0 ? false : botJungleMove(state, h)) continue
    botLaneMove(state, h, dt)
  }
}

// 정글러 봇: ① 갱킹 — 가까운 레인에서 적과 싸우는 아군이 있으면 달려가 합류
//            ② 정글링 — 용/바론(여건 되면)·늑대 캠프 사냥
//            ③ 할 일이 없으면 false (호출부가 레인 합류로 넘긴다)
function botJungleRole(state, h, dt) {
  // ① 갱킹: 보이는 적 근처(28)에 싸우는 아군이 있으면 그쪽으로
  let gankTo = null
  let gbd = 48 * 48
  for (const e of state.heroes) {
    if (e.team === h.team || e.respawnT > 0) continue
    if (!isHeroVisible(state, e, h.team)) continue
    const ally = state.heroes.some(
      (a) => a.team === h.team && a !== h && a.respawnT <= 0 && dist2(a, e) < 26 * 26
    )
    if (!ally) continue
    const d = dist2(h, e)
    if (d < gbd) {
      gbd = d
      gankTo = e
    }
  }
  if (gankTo && h.hp > h.maxHp * 0.45) {
    steerToward(state, h, gankTo)
    return true
  }
  // ② 정글링 (지나는 길의 늑대 + 여건 되면 용/바론)
  if (botJungleMove(state, h)) return true
  // ③ 근처(botJungleMove 반경 16) 캠프가 비었으면 조금 더 넓게 "살아 있는" 늑대 캠프를 찾는다.
  //    (5v5 넓은 맵에선 캠프가 흩어져 16 밖일 수 있다.)
  //    · 절대로 죽은(부활 대기) 캠프를 향하지 않는다 — 때릴 게 없어 그 위에서 진동하며
  //      부활 타이머 내내 정글에 갇히던 문제를 막는다.
  //    · 너무 멀면(JUNGLE_SEEK 밖) 직선으로 트래킹하다 협곡 벽에 끼이므로, 그땐
  //      레인 합류(아래 ④)로 넘겨 경유지를 따라 깔끔하게 이동하게 한다.
  if (h.hp > h.maxHp * 0.5) {
    let camp = null
    let bd = JUNGLE_SEEK * JUNGLE_SEEK
    for (const m of state.monsters) {
      if (!m.alive || m.kind !== 'wolf') continue
      const d = dist2(h, m)
      if (d < bd) {
        bd = d
        camp = m
      }
    }
    if (camp) {
      steerToward(state, h, camp)
      return true
    }
  }
  // ④ 갈 만한 캠프가 없거나 체력이 모자라면 레인 합류로 넘긴다(호출부 botLaneMove가 가운데길을 민다).
  return false
}

// 직업별 교전 스킬 사용
function botCombatSkills(state, h, foe, d, nearCount) {
  const ready = h.skillCd <= 0
  if (ready) {
    if (h.cls === 'warrior' && d < DASH_AIM - 2) castSkill(state, h.id)
    else if (h.cls === 'archer' && d < CLASSES.archer.range) castSkill(state, h.id)
    else if (h.cls === 'mage' && d < FIREBALL_RANGE - 6) castSkill(state, h.id)
    else if (h.cls === 'assassin' && d < BLINK_RANGE - 2 && h.hp > h.maxHp * 0.45) castSkill(state, h.id)
    else if (h.cls === 'tank' && d < 14) castSkill(state, h.id) // 방패 들고 돌격!
    // 힐러 치유는 stepBots 위쪽에서 항상 챙긴다
  }
  if (h.ultCd > 0 || h.lvl < ULT_LEVEL) return
  if (h.cls === 'warrior' && (nearCount >= 2 || (d < WHIRL_RADIUS - 2 && foe.hp < foe.maxHp * 0.5))) {
    castUlt(state, h.id)
  } else if (h.cls === 'archer' && d < RAIN_RANGE - 4 && (foe.hp < foe.maxHp * 0.6 || nearCount >= 2)) {
    castUlt(state, h.id)
  } else if (h.cls === 'mage' && (nearCount >= 2 || (d < STORM_RADIUS - 2 && foe.hp < foe.maxHp * 0.5))) {
    castUlt(state, h.id)
  } else if (h.cls === 'assassin' && d < EXECUTE_RANGE - 1 && foe.hp < foe.maxHp * 0.45) {
    castUlt(state, h.id)
  } else if (h.cls === 'tank' && nearCount >= 2) {
    castUlt(state, h.id)
  }
}

// 봇 조향: 직선이 막히면 접선으로 비켜 가는 방향을 입력으로 넣는다.
//  · avoidDir은 "지역" 회피라 짧은 장애물은 잘 돌지만, 긴 벽(미드 협곡 등)
//    바깥면에 정면으로 붙으면 못 빠져나와 제자리에 끼인다.
//  · 그래서 진행이 막히기 시작하면(botStuckT 누적) 목표 방향에 수직으로
//    "벽을 타고 미끄러져" 모서리를 돌아 나간다. 한쪽으로 못 빠지면 주기적으로
//    반대쪽으로 바꿔 둘 다 시도한다. (무거운 귀환 구제가 발동하기 전에 스스로 탈출)
function steerToward(state, h, to) {
  if ((h.botStuckT || 0) > 0.6) {
    h.botSlideT = (h.botSlideT || 0) + STEP
    if (h.botSlideT > 1) { // 한쪽으로 1초 미끄러져도 안 풀리면 반대쪽으로
      h.botSlideT = 0
      h.botSlide = -(h.botSlide || 1)
    }
    const a = Math.atan2(to.z - h.z, to.x - h.x) + (h.botSlide || 1) * Math.PI * 0.55
    h.mx = Math.cos(a)
    h.mz = Math.sin(a)
    return
  }
  h.botSlideT = 0
  const dir = state.map.avoidDir(h, to.x, to.z, state.towers, 1.3)
  h.mx = dir.x
  h.mz = dir.z
}

// 정글 사냥: 지나는 길의 늑대, 아군이 모여 있으면 용/바론 도전
function botJungleMove(state, h) {
  // 용/바론 도전 — 분노 때문에 혼자서는 위험하다.
  //  · 바론: 10레벨이어도 솔로 불가 → 셋이 모였을 때만
  //  · 용: 6레벨부터 혼자 가능, 그 전엔 셋이 모였을 때만
  for (const big of state.monsters) {
    if (!big.alive || big.kind === 'wolf') continue
    const allies = state.heroes.filter(
      (o) => o.team === h.team && o.respawnT <= 0 && dist(o, big) < 28
    ).length
    const canSolo = big.kind === 'dragon' && h.lvl >= 6 && h.hp > h.maxHp * 0.7
    if ((allies >= 3 || canSolo) && h.hp > h.maxHp * 0.6) {
      if (dist(h, big) > CLASSES[h.cls].range - 1) steerToward(state, h, big)
      else {
        h.mx = 0
        h.mz = 0
      }
      return true
    }
  }
  // 가까운 늑대 캠프 (멀리 돌아가진 않는다)
  let camp = null
  let bd = 16 * 16
  for (const m of state.monsters) {
    if (!m.alive || m.kind !== 'wolf') continue
    const d = dist2(h, m)
    if (d < bd) {
      bd = d
      camp = m
    }
  }
  if (!camp || h.hp < h.maxHp * 0.6) return false
  if (dist(h, camp) > CLASSES[h.cls].range - 1) steerToward(state, h, camp)
  else {
    h.mx = 0
    h.mz = 0
  }
  return true
}

// 적 타워에서 안전거리(사거리 밖)를 두고 대기 — 제자리 진동 없이 한 자리에 머문다.
function botHoldOutside(state, h, objective) {
  const hold = TOWER_RANGE + 3
  const d = dist(h, objective)
  if (d < hold - 1) {
    const away = Math.atan2(h.z - objective.z, h.x - objective.x)
    h.mx = Math.cos(away) * 0.6
    h.mz = Math.sin(away) * 0.6
  } else if (d > hold + 3) {
    steerToward(state, h, objective)
  } else {
    h.mx = 0
    h.mz = 0
  }
}

// 타워에 들이박을 수 없을 때(미니언 방패 없음) 다른 할 일을 찾는다.
//  1) 이 레인에 아군 미니언이 멀리서 오고 있으면 마중 나가 함께 전진
//  2) 가까운 정글몹 탐험 (적당한 거리 안)
//  3) 다른 레인에서 밀고 있는 아군 미니언에 합류
//  4) 가까운 아군 영웅 지원
// 호출부(botLaneMove)가 이 선택을 잠시 유지(botSeekT)해 타워 앞 진동을 막는다.
function botSeekWork(state, h, lane, objective) {
  // 1) 이 레인 선두 아군 미니언
  let lead = null
  let lbd = Infinity
  for (const m of state.minions) {
    if (m.team !== h.team || m.lane !== lane) continue
    const d = dist(m, objective)
    if (d < lbd) {
      lbd = d
      lead = m
    }
  }
  if (lead && lbd > TOWER_RANGE + 6) {
    // 웨이브가 아직 타워에서 멀다 → 마중 나가 함께 온다
    steerToward(state, h, lead)
    return true
  }
  if (lead) return false // 웨이브가 곧 타워에 닿는다 → 잠깐 대기(holdOutside)했다 push
  // 2) 적당히 가까운 정글몹(늑대) 탐험
  let camp = null
  let cbd = 30 * 30
  for (const m of state.monsters) {
    if (!m.alive || m.kind !== 'wolf') continue
    const d = dist2(h, m)
    if (d < cbd) {
      cbd = d
      camp = m
    }
  }
  if (camp && h.hp > h.maxHp * 0.45) {
    steerToward(state, h, camp)
    return true
  }
  // 3) 다른 레인에서 밀고 있는 아군 미니언에 합류
  let mn = null
  let mbd = Infinity
  for (const m of state.minions) {
    if (m.team !== h.team) continue
    const d = dist2(h, m)
    if (d < mbd) {
      mbd = d
      mn = m
    }
  }
  if (mn) {
    steerToward(state, h, mn)
    return true
  }
  // 4) 가까운 아군 영웅 지원
  let mate = null
  let tbd = Infinity
  for (const o of state.heroes) {
    if (o === h || o.team !== h.team || o.respawnT > 0) continue
    const d = dist2(h, o)
    if (d < tbd) {
      tbd = d
      mate = o
    }
  }
  if (mate) {
    steerToward(state, h, mate)
    return true
  }
  return false
}

// 그 레인에서 "목표(적 타워/넥서스)에 가장 가까운" 아군 미니언 = 우리 전선의 선두.
function frontLaneMinion(state, team, lane, objective) {
  let front = null
  let bd = Infinity
  for (const m of state.minions) {
    if (m.team !== team || m.lane !== lane) continue
    const d = dist(m, objective)
    if (d < bd) {
      bd = d
      front = m
    }
  }
  return front
}

// 레인 봇: 경유지를 따라 적 본진 쪽으로. 목표 타워 근처에선
// 아군 미니언이 받아주고 있을 때만 들어간다 (타워 다이브 금지).
function botLaneMove(state, h, dt) {
  h.botSeekT = Math.max(0, (h.botSeekT || 0) - dt)
  const lane = laneOfRole(h.role)
  const en = enemyOf(h.team)
  const objective =
    state.towers.find((t) => t.team === en && t.lane === lane && t.tier === 1 && t.alive) ||
    state.towers.find((t) => t.team === en && t.lane === lane && t.tier === 2 && t.alive) ||
    state.towers.find((t) => t.team === en && t.tier === 3 && t.alive) || // 최후의 포탑
    state.map.NEXUS_POS[en]
  // "딴 일" 모드: 타워 앞에서 못 밀 때 한번 정한 일을 잠시 유지한다.
  // (매 틱 라인 푸시로 되돌아가 타워 사거리 경계를 들락날락하던 진동을 막는다)
  if (h.botSeekT > 0) {
    if (botSeekWork(state, h, lane, objective)) return
    h.botSeekT = 0 // 할 일이 없어졌으면 아래 일반 로직으로
  }
  // 적 타워 근처(넉넉한 반경)에서의 행동을 한 자리에서 결정한다 — 사거리 경계 진동 방지
  const dObj = dist(h, objective)
  if (objective.id && dObj < TOWER_RANGE + 8) {
    const shield = state.minions.some((m) => m.team === h.team && dist(m, objective) < TOWER_RANGE)
    // 미니언 방패가 있으면 타워는 미니언을 때리니 안전하게 들어가 타워를 친다.
    if (shield) {
      if (dObj <= CLASSES[h.cls].range - 0.5) {
        h.mx = 0
        h.mz = 0
      } else {
        steerToward(state, h, objective)
      }
      return
    }
    // 방패가 없으면 들이박지 않는다 → 다른 할 일을 정해 잠시 유지하고, 없으면 대기
    h.botSeekT = 2.5
    if (botSeekWork(state, h, lane, objective)) return
    botHoldOutside(state, h, objective)
    return
  }
  // 전선 합류: 아군 미니언을 앞질러(타워 쪽으로) 달려나가지 않는다.
  //  봇 발이 미니언보다 빨라 웨이브를 두고 타워 앞에서 멍하니 기다리던 문제를 막는다.
  //  → 목표까지 남긴 거리가 "내 최전방 아군 미니언"보다 더 가까우면(앞서 나감)
  //    싸우고 있는 미니언 전선으로 돌아가 함께 민다. (castAttack은 stepBots에서
  //    이미 매 틱 호출되어, 전선에 붙으면 사거리 안 적 미니언을 자동 타격한다)
  const front = frontLaneMinion(state, h.team, lane, objective)
  if (front && dObj < dist(front, objective) - 3) {
    if (dist(h, front) > Math.max(2.5, CLASSES[h.cls].range - 2)) steerToward(state, h, front)
    else {
      h.mx = 0
      h.mz = 0
    }
    return
  }
  // 경유지 행군: 가장 가까운 경유지의 "다음 칸"을 향한다.
  // (가까운 칸 자체를 향하면 본진 옆에서 출발 경유지(넥서스)와
  //  충돌체 경계 사이를 제자리 왕복하는 함정에 빠진다)
  const wps = state.map.LANES[lane]
  const dirI = h.team === 'blue' ? 1 : -1
  const wp = wps[state.map.nearestWp(lane, h.x, h.z) + dirI]
  if (!wp) {
    steerToward(state, h, objective)
    return
  }
  // 경유지보다 목표가 더 가까우면 목표로 직행
  steerToward(state, h, dist(h, objective) < dist(h, wp) + 6 ? objective : wp)
}

const r1 = (v) => Math.round(v * 10) / 10
const r2d = (v) => Math.round(v * 100) / 100

// 게스트에게 보낼 직렬화 스냅샷 (렌더러도 이 형태만 본다)
export function makeView(state) {
  return {
    phase: 'play',
    status: state.status,
    mode: state.mode, // 렌더러/미니맵이 맞는 크기의 맵을 만들 수 있게
    nexusPos: state.map.NEXUS_POS, // 시야(inSight) 계산용
    time: r2d(state.time),
    countdown: Math.ceil(state.countdown),
    go: state.status === 'playing' && state.time < COUNTDOWN_TIME + 1.2,
    timeLeft: Math.max(0, Math.ceil(COUNTDOWN_TIME + TIME_LIMIT - state.time)),
    winner: state.winner,
    kills: { ...state.kills },
    heroes: state.heroes.map((h) => ({
      id: h.id,
      name: h.name,
      zodiacId: h.zodiacId,
      color: h.color,
      team: h.team,
      cls: h.cls,
      isBot: h.isBot,
      role: h.role,
      homeX: h.homeX, // 우물 중심 (canShop/inFountain 판정용)
      homeZ: h.homeZ,
      x: r1(h.x),
      z: r1(h.z),
      dir: r2d(h.dir),
      hp: Math.ceil(h.hp),
      maxHp: h.maxHp,
      lvl: h.lvl,
      xp: Math.floor(h.xp),
      xpNeed: h.lvl >= MAX_LEVEL ? 0 : xpNeed(h.lvl),
      gold: Math.floor(h.gold),
      items: h.items.slice(),
      atkCd: r2d(h.atkCd),
      atkSeq: h.atkSeq,
      skillCd: r2d(h.skillCd),
      ultCd: r2d(h.ultCd),
      ultLocked: h.lvl < ULT_LEVEL,
      stunT: r2d(h.stunT),
      shieldT: r2d(h.shieldT),
      recallT: r2d(h.recallT),
      respawnT: r2d(h.respawnT),
      bushI: h.bushI,
      revealT: r2d(h.revealT),
      dragonT: r1(h.dragonT),
      baronT: r1(h.baronT),
      kills: h.kills,
      deaths: h.deaths,
    })),
    minions: state.minions.map((m) => ({
      id: m.id,
      team: m.team,
      ranged: m.ranged,
      x: r1(m.x),
      z: r1(m.z),
      dir: r2d(m.dir),
      atkSeq: m.atkSeq,
      hp: Math.ceil(m.hp),
      maxHp: Math.ceil(m.maxHp),
    })),
    monsters: state.monsters.map((m) => ({
      id: m.id,
      kind: m.kind,
      alive: m.alive,
      x: r1(m.x),
      z: r1(m.z),
      hp: Math.ceil(m.hp),
      maxHp: m.maxHp,
      respawnT: m.alive ? 0 : Math.ceil(m.respawnT),
      enrage: r1(m.combatT || 0), // 분노 누적 시간(초) — 렌더러가 붉게 달아오르게
    })),
    towers: state.towers.map((t) => ({
      id: t.id,
      team: t.team,
      lane: t.lane,
      tier: t.tier,
      x: t.x,
      z: t.z,
      hp: Math.ceil(t.hp),
      maxHp: t.maxHp,
      alive: t.alive,
      vuln: t.alive && towerVulnerable(state, t),
    })),
    nexus: {
      blue: { hp: Math.ceil(state.nexus.blue.hp), maxHp: NEXUS_HP, vuln: nexusVulnerable(state, 'blue') },
      red: { hp: Math.ceil(state.nexus.red.hp), maxHp: NEXUS_HP, vuln: nexusVulnerable(state, 'red') },
    },
    projectiles: state.projectiles.map((p) => ({
      id: p.id,
      kind: p.kind,
      team: p.team,
      x: r1(p.x),
      z: r1(p.z),
    })),
    fx: state.fx.map((n) => ({
      id: n.id, kind: n.kind, x: r1(n.x), z: r1(n.z), r: n.r, t: r2d(n.t), team: n.team,
      ...(n.dir != null ? { dir: r2d(n.dir) } : null),
      ...(n.kind === 'gold' ? { n: n.n, owner: n.owner } : null),
    })),
    feed: state.feed.slice(-5),
  }
}
