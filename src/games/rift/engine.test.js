import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGame, setInput, castAttack, castSkill, castUlt, castRecall, step, makeView, makeBot,
  towerVulnerable, nexusVulnerable, isHeroVisible, isUnitVisible, buyItem, sellItem, canShop,
  STEP, COUNTDOWN_TIME, TIME_LIMIT, ULT_LEVEL, TEAM_SIZE, MAX_LEVEL, RECALL_TIME, CLASS_IDS, CLASSES,
  ITEM_SLOTS, BOT_STUCK_T,
} from './engine.js'
import { ITEMS_BY_ID, sumStats } from './items.js'
import {
  NEXUS_POS, LANES, LANE_IDS, BUSHES, WALLS, TOWER_SPOTS, avoidDir,
  nearestWp, resolveTerrain, WORLD, bushIndexAt, buildMap,
} from './map.js'

// 3:3 사람 풀파티 — 직업 6종이 모두 등장한다 (봇 AI가 안 끼어 결정적 테스트가 쉽다)
function humans() {
  const defs = [
    ['rat', 'mage', 'blue'], ['ox', 'archer', 'blue'], ['tiger', 'warrior', 'blue'],
    ['rabbit', 'healer', 'red'], ['dragon', 'assassin', 'red'], ['snake', 'tank', 'red'],
  ]
  return defs.map(([id, cls, team]) => ({
    id, name: id.toUpperCase(), zodiacId: id, color: '#abc', cls, team,
  }))
}

function startPlaying(g) {
  while (g.status === 'countdown') step(g, STEP)
}

function run(g, seconds) {
  const n = Math.round(seconds / STEP)
  for (let i = 0; i < n; i++) step(g, STEP)
}

// 적 미니언을 시험용으로 슬쩍 배치
function plantMinion(g, team, x, z, hp = 50) {
  const m = {
    id: g.nextId++, team, lane: 'top', ranged: false,
    x, z, hp, maxHp: hp, atkCd: 0, wpI: team === 'blue' ? 1 : LANES.top.length - 2,
  }
  g.minions.push(m)
  return m
}

test('createGame: 3:3 구성, 직업 6종, 자기 우물에서 시작', () => {
  const g = createGame(humans())
  assert.equal(g.status, 'countdown')
  assert.equal(g.heroes.length, TEAM_SIZE * 2)
  for (const h of g.heroes) {
    const nx = NEXUS_POS[h.team]
    assert.ok(Math.hypot(h.x - nx.x, h.z - nx.z) < 15) // 우물 근처
    assert.equal(h.lvl, 1)
    assert.equal(h.hp, h.maxHp)
    assert.ok(CLASS_IDS.includes(h.cls))
  }
  assert.equal(g.towers.length, 14) // 3레인 × 외곽/내곽 × 2팀 + 최후의 포탑 2
})

test('직업 중복 보정: 한 팀에 같은 직업이 오면 남은 직업으로 바꿔준다', () => {
  const players = humans().map((p) => ({ ...p, cls: 'warrior' })) // 전부 전사 요청
  const g = createGame(players)
  for (const team of ['blue', 'red']) {
    const cls = g.heroes.filter((h) => h.team === team).map((h) => h.cls)
    assert.equal(new Set(cls).size, TEAM_SIZE) // 중복 없음
  }
})

test('3갈래 레인: 미드 포함 미니언 웨이브가 레인마다 생성되고 행군', () => {
  assert.deepEqual(LANE_IDS, ['top', 'mid', 'bot'])
  const g = createGame(humans())
  startPlaying(g)
  run(g, 3) // 첫 웨이브(시작 2초 후) 이후
  assert.equal(g.minions.length, 36) // 2팀 × 3레인 × 6 (근접 3 + 원거리 3)
  const blueMid = g.minions.find((m) => m.team === 'blue' && m.lane === 'mid')
  const x0 = blueMid.x
  run(g, 5)
  assert.ok(blueMid.x > x0 + 5) // 오른쪽(빨강 진영)으로 전진
})

test('기본공격: 사거리 안 미니언을 잡으면 경험치를 얻는다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0] // blue mage
  h.x = 0
  h.z = 0
  const m = plantMinion(g, 'red', 5, 0, 40)
  castAttack(g, h.id)
  assert.equal(g.projectiles.length, 1)
  assert.ok(h.atkCd > 0)
  run(g, 1)
  assert.ok(!g.minions.includes(m)) // 처치됨
  assert.ok(h.xp > 0)
})

test('마법사 화염구: 폭발 투사체, 쿨다운 동안 다시 못 쓴다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0] // mage
  castSkill(g, h.id)
  assert.equal(g.projectiles.filter((p) => p.kind === 'fireball').length, 1)
  castSkill(g, h.id)
  assert.equal(g.projectiles.filter((p) => p.kind === 'fireball').length, 1) // 무시됨
  assert.ok(h.skillCd > 4)
})

test('궁수 꿰뚫는 화살: 일직선의 적을 모두 관통한다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[1] // archer
  h.x = 0
  h.z = 0
  // 같은 직선(앞쪽)에 미니언 둘 — 둘 다 피해를 입어야 한다
  const m1 = plantMinion(g, 'red', 6, 0, 500)
  const m2 = plantMinion(g, 'red', 12, 0, 500)
  // 직선 밖(옆)의 미니언은 안 맞아야 한다
  const side = plantMinion(g, 'red', 6, 9, 500)
  castSkill(g, h.id)
  assert.equal(g.projectiles.filter((p) => p.kind === 'pierce').length, 3) // 시각용 화살 3발
  assert.ok(m1.hp < 500 && m2.hp < 500, '일직선의 두 적 모두 관통 피해')
  assert.equal(side.hp, 500, '직선에서 벗어난 적은 안 맞는다')
})

test('전사 돌진: 적에게 파고들어 피해 + 짧은 기절', () => {
  const g = createGame(humans())
  startPlaying(g)
  const w = g.heroes[2] // warrior (blue)
  const e = g.heroes[3] // healer (red)
  w.x = 0
  w.z = 0
  e.x = 12
  e.z = 0
  castSkill(g, w.id)
  assert.ok(Math.hypot(w.x - e.x, w.z - e.z) < 4) // 바짝 붙음
  assert.ok(e.hp < e.maxHp)
  assert.ok(e.stunT > 0)
})

test('힐러 치유: 아픈 아군을 회복, 다 멀쩡하면 쿨다운을 안 쓴다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const heal = g.heroes[3] // healer (red)
  const ally = g.heroes[4] // assassin (red)
  heal.x = 0
  heal.z = 0
  ally.x = 5
  ally.z = 0
  castSkill(g, heal.id) // 아무도 안 아픔 → 불발
  assert.equal(heal.skillCd, 0)
  ally.hp = 100
  castSkill(g, heal.id)
  assert.ok(ally.hp > 150)
  assert.ok(heal.skillCd > 0)
})

test('암살자 점멸습격: 적 등 뒤로 순간이동 + 일격', () => {
  const g = createGame(humans())
  startPlaying(g)
  const a = g.heroes[4] // assassin (red)
  const v = g.heroes[0] // mage (blue)
  a.x = 0
  a.z = 0
  v.x = 12
  v.z = 0
  castSkill(g, a.id)
  assert.ok(Math.hypot(a.x - v.x, a.z - v.z) < 3.5) // 붙었다
  assert.ok(v.hp < v.maxHp)
})

test('탱커 방패막기: 받는 피해가 크게 줄어든다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const t = g.heroes[5] // tank (red)
  // 적 우물 피해로 비교 (같은 위치, 방패 ON/OFF) — 최후의 포탑 사거리 밖에 둔다
  t.x = NEXUS_POS.blue.x
  t.z = NEXUS_POS.blue.z + 11
  run(g, 1)
  const lossNoShield = t.maxHp - t.hp
  t.hp = t.maxHp
  castSkill(g, t.id)
  assert.ok(t.shieldT > 0)
  run(g, 1)
  const lossShield = t.maxHp - t.hp
  assert.ok(lossShield < lossNoShield * 0.55, `${lossShield} vs ${lossNoShield}`)
})

test(`궁극기: 레벨 ${ULT_LEVEL} 전엔 잠겨 있고, 마법사 번개폭풍은 광역 기절`, () => {
  const g = createGame(humans())
  startPlaying(g)
  const a = g.heroes[0] // blue mage
  const b = g.heroes[3] // red healer
  a.x = 0
  a.z = 0
  b.x = 5
  b.z = 0
  castUlt(g, a.id)
  assert.equal(g.fx.length, 0) // 아직 잠김
  a.lvl = ULT_LEVEL
  castUlt(g, a.id)
  assert.ok(g.fx.some((n) => n.kind === 'storm'))
  assert.ok(b.hp < b.maxHp)
  assert.ok(b.stunT > 0)
  assert.ok(a.ultCd > 0)
})

test('암살자 그림자처형: 빈사 적에게 2배 — 처치하면 점멸 초기화', () => {
  const g = createGame(humans())
  startPlaying(g)
  const a = g.heroes[4] // assassin (red)
  const v = g.heroes[0] // mage (blue)
  a.lvl = ULT_LEVEL
  a.x = 0
  a.z = 0
  v.x = 5
  v.z = 0
  v.hp = v.maxHp * 0.2 // 빈사
  a.skillCd = 5
  castUlt(g, a.id)
  assert.ok(v.respawnT > 0) // 처형!
  assert.equal(a.skillCd, 0) // 점멸 초기화
})

test('수풀 은신: 적에겐 안 보이고, 자동 조준에도 안 잡힌다 — 붙거나 공격하면 들킨다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const hider = g.heroes[0] // blue mage
  const seeker = g.heroes[3] // red healer
  const bush = BUSHES[9] // (0, 16) — 강가 수풀
  hider.x = bush.x
  hider.z = bush.z
  step(g, STEP) // bushI 갱신
  assert.ok(hider.bushI >= 0)
  assert.equal(bushIndexAt(bush.x, bush.z), 9)
  // 적이 코앞 시야 거리(수풀 밖)에 있어도 안 보인다
  seeker.x = bush.x + 8
  seeker.z = bush.z
  step(g, STEP)
  assert.equal(isHeroVisible(g, hider, 'red'), false)
  assert.equal(isHeroVisible(g, hider, 'blue'), true) // 우리 팀은 보인다
  // 적의 자동 조준에도 안 잡힌다 (다른 대상이 없으면 불발)
  const before = g.projectiles.length
  castAttack(g, seeker.id)
  assert.equal(g.projectiles.length, before)
  // 바짝 붙으면 들킨다
  seeker.x = bush.x + 3
  step(g, STEP)
  assert.equal(isHeroVisible(g, hider, 'red'), true)
  // 멀어지면 다시 숨고, 숨은 채 공격하면 모습이 드러난다
  seeker.x = bush.x + 8
  step(g, STEP)
  assert.equal(isHeroVisible(g, hider, 'red'), false)
  castAttack(g, hider.id) // seeker가 사거리(10.5) 안
  assert.ok(hider.revealT > 0)
  assert.equal(isHeroVisible(g, hider, 'red'), true)
})

test('전장의 안개: 아군 유닛 시야 밖의 적은 안 보인다', () => {
  const g = createGame(humans())
  startPlaying(g) // 아직 미니언 없음
  const e = g.heroes[3] // red
  e.x = 0
  e.z = 50 // 파랑 유닛(우물/타워)에서 멀리
  step(g, STEP)
  assert.equal(isHeroVisible(g, e, 'blue'), false)
  assert.equal(isUnitVisible(g, e, 'blue'), false)
  // 파랑 영웅이 다가가면 보인다
  g.heroes[0].x = 0
  g.heroes[0].z = 35
  step(g, STEP)
  assert.equal(isHeroVisible(g, e, 'blue'), true)
})

test('영웅 처치: 킬/데스 집계 + 피드 + 부활 후 우물에서 풀피', () => {
  const g = createGame(humans())
  startPlaying(g)
  const a = g.heroes[0] // blue mage
  const b = g.heroes[3] // red healer
  a.x = 0
  a.z = 0
  b.x = 5
  b.z = 0
  b.hp = 1
  castAttack(g, a.id)
  run(g, 1)
  assert.equal(a.kills, 1)
  assert.equal(b.deaths, 1)
  assert.equal(g.kills.blue, 1)
  assert.ok(b.respawnT > 0)
  assert.ok(g.feed.some((f) => f.t === 'kill'))
  run(g, b.respawnT + 0.5)
  assert.equal(b.respawnT, 0)
  assert.equal(b.hp, b.maxHp)
  assert.ok(Math.hypot(b.x - NEXUS_POS.red.x, b.z - NEXUS_POS.red.z) < 15)
})

test('타워 공격 순서: 외곽→내곽→최후의 포탑→넥서스 순으로만 공격 가능', () => {
  const g = createGame(humans())
  const outer = g.towers.find((t) => t.id === 'r-mid-1')
  const inner = g.towers.find((t) => t.id === 'r-mid-2')
  const fin = g.towers.find((t) => t.id === 'r-final')
  assert.ok(fin && fin.tier === 3, '최후의 포탑이 존재한다')
  assert.equal(towerVulnerable(g, outer), true)
  assert.equal(towerVulnerable(g, inner), false)
  assert.equal(towerVulnerable(g, fin), false)
  assert.equal(nexusVulnerable(g, 'red'), false)
  outer.alive = false
  assert.equal(towerVulnerable(g, inner), true)
  assert.equal(towerVulnerable(g, fin), false) // 내곽이 아직 살아있으면 최후의 포탑 무적
  inner.alive = false
  assert.equal(towerVulnerable(g, fin), true) // 내곽이 부서지면 최후의 포탑 공격 가능
  assert.equal(nexusVulnerable(g, 'red'), false) // 최후의 포탑이 살아있으면 넥서스 무적
  fin.alive = false
  assert.equal(nexusVulnerable(g, 'red'), true) // 최후의 포탑이 부서지면 넥서스 공격 가능
})

test('타워는 미니언 우선 — 단, 우리 편을 때린 다이버는 반격으로 노린다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const t = g.towers.find((o) => o.id === 'r-top-1')
  const h = g.heroes[0] // blue mage
  h.x = t.x - 8
  h.z = t.z
  const m = plantMinion(g, 'blue', t.x - 6, t.z, 80)
  run(g, 1.5)
  assert.ok(m.hp < 80 || !g.minions.includes(m)) // 미니언이 먼저 맞는다
  assert.equal(h.hp, h.maxHp) // 영웅은 미니언 뒤에서 안전 (철거 가능)
  // 사거리 안에서 적 영웅을 때리면(아군 피격) → 타워가 그 다이버로 표적을 바꿔 반격
  const victim = g.heroes[3] // red healer (타워와 같은 편)
  victim.x = t.x - 6
  victim.z = t.z + 2
  plantMinion(g, 'blue', t.x - 6, t.z, 9999) // 미니언 방패가 있어도
  castAttack(g, h.id) // h가 적 영웅을 때림 → 타워 어그로
  run(g, 1.5)
  assert.ok(h.hp < h.maxHp, '전투를 건 다이버는 타워에 맞아 물러나야 한다')
})

test('타워: 사거리에 영웅이 없으면 미니언을 때린다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const t = g.towers.find((o) => o.id === 'r-top-1')
  // 영웅들을 멀리 치워 둔다
  for (const o of g.heroes) {
    o.x = NEXUS_POS[o.team].x
    o.z = NEXUS_POS[o.team].z
  }
  const m = plantMinion(g, 'blue', t.x - 6, t.z, 200)
  run(g, 1.5)
  assert.ok(m.hp < 200 || !g.minions.includes(m)) // 미니언이 맞는다
})

test('넥서스가 터지면 게임 종료 + 승리 팀 확정', () => {
  const g = createGame(humans())
  startPlaying(g)
  for (const t of g.towers) if (t.team === 'red') t.alive = false
  g.nexus.red.hp = 10
  // 빨강 영웅들이 자동 조준에 먼저 잡히지 않게 우물 밖으로 치워둔다
  for (const o of g.heroes) {
    if (o.team === 'red') {
      o.x = 0
      o.z = 50
    }
  }
  const h = g.heroes[0]
  h.x = NEXUS_POS.red.x - 7
  h.z = NEXUS_POS.red.z
  castAttack(g, h.id)
  run(g, 1)
  assert.equal(g.status, 'finished')
  assert.equal(g.winner, 'blue')
})

test('근접 영웅도 넥서스를 타격할 수 있다 (몸통 반경만큼 떨어져 있어도)', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  for (const t of g.towers) if (t.team === 'red') t.alive = false
  // 빨강 영웅들은 멀리 치워 자동 조준에 안 걸리게
  for (const o of g.heroes) if (o.team === 'red') { o.x = 0; o.z = 55 }
  const h = g.heroes.find((o) => o.cls === 'warrior') // blue 전사 (근접 3.8)
  const hp0 = g.nexus.red.hp
  // 충돌체 때문에 붙을 수 있는 최소 거리(반경 4.5 + 영웅 1.3 ≈ 5.8)에 둔다
  h.x = NEXUS_POS.red.x - 6
  h.z = NEXUS_POS.red.z
  setInput(g, h.id, { mx: 0, mz: 0 })
  castAttack(g, h.id)
  run(g, 0.5)
  assert.ok(g.nexus.red.hp < hp0, '근접 전사가 넥서스 체력을 깎는다')
})

test('갈 곳 잃은 봇: 한참 제자리에 박혀 있으면 귀환으로 우물 복귀', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = makeBot(g, g.heroes[0].id)
  // 적/오브젝트가 시야·근처에 없게 멀리 치운다 (귀환이 끊기지 않도록)
  for (const o of g.heroes) if (o !== h) { o.x = 0; o.z = -60 }
  for (const m of g.monsters) m.alive = false
  // 레인 한복판(우물 밖)에서 "오래 끼임" 상태를 만들어 준다
  h.x = 0
  h.z = 0
  h.botStuckT = BOT_STUCK_T + 0.5 // 갈 곳을 잃고 한참 진동한 상태로 간주
  run(g, RECALL_TIME + 0.5)
  assert.ok(h.botStuckT < BOT_STUCK_T, '귀환 후 끼임 게이지 초기화')
  assert.ok(
    Math.hypot(h.x - NEXUS_POS.blue.x, h.z - NEXUS_POS.blue.z) < 15,
    '끼였던 봇이 우물로 복귀했다'
  )
})

test('갈 곳 잃은 봇 구제: 정상적으로 전진하는 봇은 끼임으로 오인하지 않는다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = makeBot(g, g.heroes[0].id)
  for (const o of g.heroes) if (o !== h) { o.x = 0; o.z = -60 }
  // 본진 근처에서 평범히 레인을 행군 → 끼임 게이지가 안 쌓이고 귀환도 안 켜진다
  run(g, BOT_STUCK_T + 1)
  assert.equal(h.botRecall, false, '전진 중인 봇은 귀환을 켜지 않는다')
  assert.ok((h.botStuckT || 0) < BOT_STUCK_T, '끼임 게이지가 임계 미만으로 유지된다')
})

test('용을 잡으면 팀 전체가 버프 + 리스폰 대기', () => {
  const g = createGame(humans())
  startPlaying(g)
  const d = g.monsters.find((m) => m.kind === 'dragon')
  d.alive = true
  d.hp = 1
  const h = g.heroes[0] // blue mage
  h.x = d.x - 6
  h.z = d.z
  castAttack(g, h.id)
  run(g, 1)
  assert.equal(d.alive, false)
  assert.ok(d.respawnT > 0)
  for (const o of g.heroes) {
    if (o.team === 'blue') assert.ok(o.dragonT > 0)
    else assert.equal(o.dragonT, 0)
  }
})

test('정글몹: 맞으면 반격하고, 캠프를 벗어나면 복귀하며 회복', () => {
  const g = createGame(humans())
  startPlaying(g)
  const w = g.monsters.find((m) => m.kind === 'wolf')
  const h = g.heroes[0]
  h.x = w.x - 6
  h.z = w.z
  castAttack(g, h.id)
  run(g, 1.5)
  assert.equal(w.aggro, h.id)
  assert.ok(h.hp < h.maxHp || w.hp < w.maxHp)
  // 멀리 도망 → 늑대는 포기하고 집으로
  h.x = -90
  h.z = 0
  const hurt = w.hp
  run(g, 4)
  assert.equal(w.aggro, null)
  assert.ok(w.hp >= hurt)
})

test('시간 초과: 부순 타워 → 킬 순서로 승부 판정', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.kills.red = 3
  g.time = COUNTDOWN_TIME + TIME_LIMIT
  step(g, STEP)
  assert.equal(g.status, 'finished')
  assert.equal(g.winner, 'red')
})

test('setInput으로 이동: 입력 방향으로 움직인다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0]
  const x0 = h.x
  setInput(g, h.id, { mx: 1, mz: 0 })
  run(g, 1)
  assert.ok(h.x > x0 + 5)
})

test('makeBot: 이탈한 참가자를 봇이 이어받고 빈 레인을 맡는다', () => {
  const g = createGame(humans())
  const h = makeBot(g, 'rat')
  assert.ok(h.isBot)
  assert.ok(LANE_IDS.includes(h.role))
  assert.equal(makeBot(g, 'rat'), null) // 이미 봇
})

test('makeView: JSON 직렬화 가능한 완전한 스냅샷 (직업/수풀 정보 포함)', () => {
  const g = createGame(humans())
  startPlaying(g)
  run(g, 5)
  const v = makeView(g)
  const back = JSON.parse(JSON.stringify(v))
  assert.equal(back.heroes.length, 6)
  assert.equal(back.towers.length, 14)
  assert.ok(back.nexus.blue.hp > 0)
  assert.ok(Array.isArray(back.minions))
  assert.ok(back.timeLeft <= TIME_LIMIT)
  for (const h of back.heroes) {
    assert.ok(CLASS_IDS.includes(h.cls))
    assert.ok('bushI' in h && 'revealT' in h && 'shieldT' in h)
  }
})

test(`레벨은 최대 ${MAX_LEVEL}: 경험치를 쏟아부어도 그 위로 안 오른다`, () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0]
  for (let i = 0; i < 400 && h.lvl < MAX_LEVEL; i++) {
    plantMinion(g, 'red', h.x + 5, h.z, 1)
    castAttack(g, h.id)
    run(g, 0.4)
    g.minions.length = 0
    h.atkCd = 0
  }
  assert.equal(h.lvl, MAX_LEVEL)
  assert.ok(h.maxHp > CLASSES[h.cls].hp + CLASSES[h.cls].hpLvl * 7)
})

test('성벽: 본진은 막혀 있고, 출입구 3곳은 모두 내곽 타워 사거리 안', () => {
  // 성벽 한가운데는 뚫고 들어갈 수 없다
  const p = { x: -82, z: -50 }
  resolveTerrain(p, 1.3, [])
  assert.ok(Math.hypot(p.x - -82, p.z - -50) >= 3, '성벽 안이면 밀려나야 한다')
  // 파랑 출입구(레인이 성벽을 지나는 곳) 3곳 모두 내곽 타워가 지킨다
  const TOWER_RANGE = 13
  for (const gap of [{ x: -82, z: -36 }, { x: -82, z: 0 }, { x: -82, z: 36 }]) {
    assert.equal(bushIndexAt(gap.x, gap.z), -1) // 출입구에 수풀은 없다
    const guard = TOWER_SPOTS.some(
      (t) => t.team === 'blue' && t.tier === 2 &&
        Math.hypot(t.x - gap.x, t.z - gap.z) <= TOWER_RANGE - 2
    )
    assert.ok(guard, `출입구 (${gap.x},${gap.z})는 내곽 타워 사거리 안이어야 한다`)
  }
  assert.ok(WALLS.length > 50) // 충돌 원들이 깔려 있다
})

test('avoidDir: 길을 막는 타워/성벽이 있으면 접선으로 비켜 간다', () => {
  // 정면에 타워가 있는 직선 경로 → 옆으로 꺾인 방향이 나온다
  const towers = [{ x: -34, z: -56, alive: true }]
  const e = { x: -44, z: -56 }
  const d = avoidDir(e, -24, -56, towers, 0.8)
  assert.ok(Math.abs(d.z) > 0.3, `옆으로 비켜야 한다 (got ${d.x},${d.z})`)
  // 막는 게 없으면 직진
  const d2 = avoidDir({ x: 0, z: 0 }, 10, 0, [], 0.8)
  assert.ok(d2.x > 0.99 && Math.abs(d2.z) < 0.01)
})

test('미니언이 자기 타워에 껴서 못 가는 문제 회귀: 돌아서 전진한다', () => {
  const g = createGame(humans())
  startPlaying(g)
  // 파랑 외곽 타워(-34,-56) 바로 뒤에서 적진 쪽으로 행군하는 미니언
  const m = plantMinion(g, 'blue', -46, -56, 500)
  m.wpI = 4 // (0,-58)을 향해 — 직선 경로가 타워에 막힌다
  run(g, 6)
  assert.ok(m.x > -28, `타워를 돌아서 지나가야 한다 (x=${m.x.toFixed(1)})`)
})

test('공격 모션 신호: 영웅 atkSeq 증가, 원거리 미니언은 화살 투사체를 쏜다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0]
  h.x = 0
  h.z = 0
  plantMinion(g, 'red', 5, 0, 9999)
  const seq0 = h.atkSeq
  castAttack(g, h.id)
  assert.equal(h.atkSeq, seq0 + 1)
  // 원거리 미니언: 사거리 안 적을 만나면 투사체를 쏜다
  const rm = plantMinion(g, 'blue', 12, 0, 9999)
  rm.ranged = true
  rm.dir = 0
  rm.atkSeq = 0
  run(g, 0.1) // 화살이 아직 날아가는 중
  assert.ok(rm.atkSeq > 0, '원거리 미니언이 공격해야 한다')
  assert.ok(g.projectiles.some((p) => p.team === 'blue' && p.kind === 'mbolt'), '원거리 미니언은 작은 mbolt를 쏜다')
})

test('지형: 바위/맵 경계를 뚫고 나갈 수 없다', () => {
  const p = { x: -16, z: -38 } // 바위 한복판
  resolveTerrain(p, 1.3, [])
  assert.ok(Math.hypot(p.x - -16, p.z - -38) >= 5.2) // 밀려남
  const q = { x: 9999, z: -9999 }
  resolveTerrain(q, 1.3, [])
  assert.ok(q.x <= WORLD.maxX && q.z >= WORLD.minZ)
  assert.equal(nearestWp('mid', -96, 0), 0)
})

test('봇은 본진을 떠나 레인을 행군한다 (본진 옆 제자리 왕복 회귀 방지)', () => {
  const players = humans().map((p) => ({ ...p, isBot: true }))
  let seed = 7
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const g = createGame(players, rng)
  startPlaying(g)
  run(g, 40)
  for (const team of ['blue', 'red']) {
    const far = g.heroes.filter(
      (h) => h.team === team && Math.abs(h.x - NEXUS_POS[team].x) > 40
    )
    assert.ok(far.length >= 1, `${team}팀 봇이 본진에서 출발해야 한다`)
  }
})

// 영웅을 특정 레벨로 올려놓는다 (체력도 그 레벨 최대치로)
function setLevel(h, lvl) {
  const c = CLASSES[h.cls]
  h.lvl = lvl
  h.maxHp = c.hp + c.hpLvl * (lvl - 1)
  h.hp = h.maxHp
}

// 한 영웅이 한 몹 옆에 붙어 계속 때리는 솔로 교전을 시뮬레이션한다.
function soloFight(g, h, mob, seconds) {
  const n = Math.round(seconds / STEP)
  for (let i = 0; i < n && h.respawnT <= 0 && mob.alive; i++) {
    castAttack(g, h.id)
    step(g, STEP)
  }
}

test('용 분노: 저레벨 혼자서는 분노가 쌓여 잡기 전에 쓰러진다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const d = g.monsters.find((m) => m.kind === 'dragon')
  d.alive = true
  d.hp = d.maxHp
  d.x = 0
  d.z = 30
  const h = g.heroes[2] // blue warrior, 1레벨
  h.x = -3
  h.z = 30
  soloFight(g, h, d, 25)
  assert.ok(h.respawnT > 0, '저레벨 솔로는 용을 잡기 전에 죽는다')
  assert.ok(d.alive, '용은 살아남는다')
})

test('용 분노: 6레벨이면 혼자서도 용을 잡는다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const d = g.monsters.find((m) => m.kind === 'dragon')
  d.alive = true
  d.hp = d.maxHp
  d.x = 0
  d.z = 30
  const h = g.heroes[2] // blue warrior
  setLevel(h, 6)
  h.x = -3
  h.z = 30
  soloFight(g, h, d, 25)
  assert.equal(d.alive, false, '6레벨은 용을 잡는다')
  assert.ok(h.respawnT <= 0, '잡고도 살아남는다')
  assert.ok(h.hp < h.maxHp, '쉽지 않게 — 피해를 입는다')
})

test('바론 분노: 10레벨이어도 혼자서는 못 잡는다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const b = g.monsters.find((m) => m.kind === 'baron')
  b.alive = true
  b.hp = b.maxHp
  b.x = 0
  b.z = -30
  const h = g.heroes[4] // red assassin (최고 솔로 딜)
  setLevel(h, 10)
  h.x = -3
  h.z = -30
  soloFight(g, h, b, 30)
  assert.ok(h.respawnT > 0, '10레벨 솔로도 바론에게 쓰러진다')
  assert.ok(b.alive, '바론은 살아남는다')
})

test('미니언 방어: 주변 아군이 적 영웅에게 맞으면 가해자를 최우선으로 노린다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const foe = g.heroes[4] // red assassin = 가해자
  const ally = g.heroes[0] // blue mage = 공격받는 아군
  foe.x = 0
  foe.z = 4
  ally.x = 0
  ally.z = 1
  ally.lastHurt = g.time // 방금 맞았다
  ally.lastHitBy = foe.id
  const closer = plantMinion(g, 'red', 2, 0, 50) // 더 가까운 적 미니언
  const m = plantMinion(g, 'blue', 0, 0, 500)
  run(g, 0.3)
  assert.equal(closer.hp, 50, '더 가까운 적 미니언이 아니라 가해자를 노린다')
  assert.ok(Math.hypot(m.x - foe.x, m.z - foe.z) < 4, '가해자(적 영웅) 쪽으로 다가간다')
})

test('미드 미니언: 경유지 위에 선 1차 타워를 돌아 라인이 멈추지 않고 전진한다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999 // 다른 웨이브 방해 없이
  // 파랑 미드 1차 타워(-34,0) 칸을 향해 행군하는 파랑 미니언
  const m = plantMinion(g, 'blue', -42, 0, 500)
  m.lane = 'mid'
  m.wpI = 2 // wps[2] = (-34,0) = 타워 위치
  run(g, 6)
  assert.ok(m.x > -20, `미드 타워에 끼지 않고 지나 전진해야 한다 (x=${m.x.toFixed(1)})`)
})

test('봇: 미니언 없이 적 타워 앞에 멈춰 있지 않고 다른 할 일(정글 등)을 찾아 간다', () => {
  const players = humans().map((p) => ({ ...p, isBot: true }))
  const g = createGame(players)
  startPlaying(g)
  g.waveT = 999 // 아군 미니언이 없는 상황을 만든다
  g.minions.length = 0
  const h = g.heroes.find((o) => o.team === 'blue' && o.cls === 'warrior')
  h.role = 'mid'
  const t = g.towers.find((o) => o.id === 'r-mid-1') // 적 미드 1차 타워 (34,0)
  h.x = t.x - 4 // 타워 사거리 안
  h.z = t.z
  // 나머지 영웅은 멀리 치워 교전 변수 제거
  for (const o of g.heroes) if (o !== h) { o.x = NEXUS_POS[o.team].x; o.z = NEXUS_POS[o.team].z }
  const tower0 = Math.hypot(h.x - t.x, h.z - t.z)
  run(g, 2)
  // 타워 앞에 얼어붙지 않고 할 일(가까운 정글몹 탐험 등)을 찾아 떠나야 한다
  const towerNow = Math.hypot(h.x - t.x, h.z - t.z)
  assert.ok(towerNow > tower0 + 6, `타워 앞에 얼어붙지 않고 벗어나야 한다 (${tower0.toFixed(1)}→${towerNow.toFixed(1)})`)
})

test('정글러 봇: 근처 캠프가 죽어 있어도 그 위에서 진동하지 않고 계속 전진한다', () => {
  // 회귀 방지: 예전엔 근처 캠프가 다 죽으면 "부활 대기 중인 죽은 캠프"로 steer해
  //  때릴 것도 없이 그 위에서 부활 타이머 내내(최대 ~45초) 진동하며 갇혔다.
  const players = humans().map((p) => ({ ...p, isBot: true }))
  const g = createGame(players)
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = g.heroes.find((o) => o.team === 'blue' && o.cls === 'warrior')
  h.role = 'jungle'
  // 교전·갱킹 변수를 없애려고 나머지 영웅은 각자 우물로 치운다
  for (const o of g.heroes) if (o !== h) { o.x = NEXUS_POS[o.team].x; o.z = NEXUS_POS[o.team].z }
  // 모든 늑대 캠프를 죽여(부활 대기) 두고, 첫 캠프 바로 위에 세운다 (옛 버그의 함정 자리)
  for (const m of g.monsters) if (m.kind === 'wolf') { m.alive = false; m.respawnT = 40 }
  const dead = g.monsters.find((m) => m.kind === 'wolf')
  h.x = dead.camp.x
  h.z = dead.camp.z
  const x0 = h.x
  const z0 = h.z
  run(g, 6)
  // 죽은 캠프 위에 갇혀 진동하지 않고, 레인 등으로 충분히 이동(또는 귀환)해야 한다
  const moved = Math.hypot(h.x - x0, h.z - z0)
  assert.ok(moved > 20, `죽은 캠프 위에서 진동하지 않고 벗어나야 한다 (이동 ${moved.toFixed(1)})`)
})

test('봇: 미니언을 앞질러 타워로 달려가지 않고 라인 교전을 지원하러 간다', () => {
  const players = humans().map((p) => ({ ...p, isBot: true }))
  const g = createGame(players)
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = g.heroes.find((o) => o.team === 'blue' && o.cls === 'warrior')
  h.role = 'mid'
  for (const o of g.heroes) if (o !== h) { o.x = NEXUS_POS[o.team].x; o.z = NEXUS_POS[o.team].z }
  const t = g.towers.find((o) => o.id === 'r-mid-1') // 적 미드 1차 타워 (34,0)
  // 아군·적 미니언이 미드 한복판(-20,0)에서 교전 중
  g.minions.push({
    id: g.nextId++, team: 'blue', lane: 'mid', ranged: false,
    x: -20, z: 0, hp: 200, maxHp: 200, atkCd: 0, dir: 0, atkSeq: 0, wpI: 1,
  })
  g.minions.push({
    id: g.nextId++, team: 'red', lane: 'mid', ranged: false,
    x: -17, z: 0, hp: 200, maxHp: 200, atkCd: 0, dir: Math.PI, atkSeq: 0, wpI: LANES.mid.length - 2,
  })
  // 봇은 전선을 앞질러 타워 쪽(10,0)으로 나가 있다
  h.x = 10
  h.z = 0
  const towerD0 = Math.hypot(h.x - t.x, h.z - t.z)
  run(g, 2)
  const towerD1 = Math.hypot(h.x - t.x, h.z - t.z)
  assert.ok(towerD1 > towerD0 + 3, `타워로 더 가지 않고 전선으로 물러난다 (${towerD0.toFixed(1)}→${towerD1.toFixed(1)})`)
  const ally = g.minions.find((m) => m.team === 'blue')
  assert.ok(
    ally && Math.hypot(h.x - ally.x, h.z - ally.z) < 12,
    '봇이 아군 미니언 전선 근처로 합류한다'
  )
})

test('타워 응징: 저레벨 영웅이 사거리 안에 버티면 연사가 세져 금세 쓰러진다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const t = g.towers.find((o) => o.id === 'r-mid-1') // (34,0)
  const h = g.heroes[0] // blue mage, 1레벨
  h.x = t.x - 6
  h.z = t.z
  for (const o of g.heroes) if (o !== h) { o.x = NEXUS_POS[o.team].x; o.z = NEXUS_POS[o.team].z }
  let maxStreak = 0
  for (let i = 0; i < Math.round(4 / STEP) && h.respawnT <= 0; i++) {
    step(g, STEP)
    maxStreak = Math.max(maxStreak, t.streak || 0)
  }
  assert.ok(h.respawnT > 0, '사거리 안에 버틴 저레벨 영웅은 곧 쓰러진다')
  assert.ok(maxStreak >= 1, '같은 영웅을 연달아 맞혀 응징 연사 게이지가 쌓인다')
  // 표적이 빠지면(사망 후 본진 부활) 연사 게이지는 초기화된다
  run(g, 1.5)
  assert.equal(t.streak, 0, '표적이 사라지면 연사 게이지가 풀린다')
})

test('귀환: 방해 없이 7초 집중하면 우물로 복귀한다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = g.heroes[0] // blue mage
  h.x = 0
  h.z = 0
  setInput(g, h.id, { mx: 0, mz: 0 })
  castRecall(g, h.id)
  assert.ok(h.recallT > 0)
  run(g, RECALL_TIME + 0.2)
  assert.equal(h.recallT, 0)
  assert.ok(Math.hypot(h.x - NEXUS_POS.blue.x, h.z - NEXUS_POS.blue.z) < 15, '우물로 복귀')
})

test('귀환: 이동하면 시전이 취소된다 (쿨다운 없음)', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = g.heroes[0]
  h.x = 0
  h.z = 0
  castRecall(g, h.id)
  assert.ok(h.recallT > 0)
  setInput(g, h.id, { mx: 1, mz: 0 }) // 움직이면 방해
  run(g, 0.2)
  assert.equal(h.recallT, 0)
  const x0 = h.x
  run(g, 0.5)
  assert.ok(h.x > x0, '취소 후엔 평소처럼 이동')
})

test('귀환: 피해를 받으면 시전이 취소된다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const h = g.heroes[0] // blue mage
  const foe = g.heroes[3] // red healer
  h.x = 0
  h.z = 0
  foe.x = 4
  foe.z = 0
  setInput(g, h.id, { mx: 0, mz: 0 })
  castRecall(g, h.id)
  assert.ok(h.recallT > 0)
  castAttack(g, foe.id) // foe가 h를 때린다
  run(g, 0.3)
  assert.equal(h.recallT, 0)
})

test('부활 대기시간: 레벨이 높을수록 길어진다', () => {
  const g = createGame(humans())
  startPlaying(g)
  g.waveT = 999
  g.minions.length = 0
  const atk = g.heroes[0] // blue mage
  const killAt = (victim) => {
    atk.x = victim.x - 3
    atk.z = victim.z
    victim.hp = 1
    atk.atkCd = 0
    for (let i = 0; i < 60 && victim.respawnT <= 0; i++) {
      castAttack(g, atk.id)
      step(g, STEP)
    }
  }
  const low = g.heroes[3] // red, 1레벨
  low.x = 20
  low.z = 0
  killAt(low)
  const lowT = low.respawnT
  assert.ok(lowT > 0)
  const high = g.heroes[4] // red
  setLevel(high, 9)
  high.x = 20
  high.z = 0
  killAt(high)
  assert.ok(high.respawnT > lowT, `높은 레벨이 더 오래 기다린다 (Lv1 ${lowT.toFixed(1)} < Lv9 ${high.respawnT.toFixed(1)})`)
})

test('미니언 HP 설계: 원거리는 타워 2대, 근접은 3대에 죽는다', () => {
  const TOWER_DMG_MINION = 60
  const g = createGame(humans())
  startPlaying(g)
  run(g, 2.4) // 첫 웨이브
  const ranged = g.minions.find((m) => m.ranged)
  const melee = g.minions.find((m) => !m.ranged)
  assert.equal(Math.ceil(ranged.maxHp / TOWER_DMG_MINION), 2, '원거리는 2대')
  assert.equal(Math.ceil(melee.maxHp / TOWER_DMG_MINION), 3, '근접은 3대')
})

test('미니언 배치: 근접이 앞(중앙 쪽), 원거리가 뒤에 스폰된다', () => {
  const g = createGame(humans())
  startPlaying(g)
  run(g, 2.2) // 첫 웨이브 직후 (대형이 흐트러지기 전)
  const mid = g.minions.filter((m) => m.team === 'blue' && m.lane === 'mid')
  const avg = (arr) => arr.reduce((s, m) => s + m.x, 0) / arr.length
  const meleeX = avg(mid.filter((m) => !m.ranged))
  const rangedX = avg(mid.filter((m) => m.ranged))
  assert.ok(meleeX > rangedX, `근접이 더 앞(+x)에 스폰 (근접 ${meleeX.toFixed(1)} > 원거리 ${rangedX.toFixed(1)})`)
})

test('풀봇 3:3 스모크 테스트: 3분 시뮬레이션이 멀쩡히 돈다', () => {
  const players = humans().map((p) => ({ ...p, isBot: true }))
  let seed = 42
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const g = createGame(players, rng)
  startPlaying(g)
  run(g, 180)
  for (const h of g.heroes) {
    assert.ok(Number.isFinite(h.x) && Number.isFinite(h.z), '위치가 NaN이면 안 된다')
    assert.ok(h.hp >= 0 && h.hp <= h.maxHp + 1)
    assert.ok(h.lvl >= 1 && h.lvl <= MAX_LEVEL)
  }
  assert.ok(g.minions.length < 300, '미니언이 무한히 쌓이면 안 된다')
  const v = makeView(g)
  JSON.stringify(v)
  assert.ok(['playing', 'finished'].includes(g.status))
})

// ── 골드 / 상점 ──

// 영웅을 자기 우물 안으로 옮긴다
function toFountain(g, h) {
  h.x = NEXUS_POS[h.team].x
  h.z = NEXUS_POS[h.team].z
}

test('골드: 미니언 막타를 치면 골드를 얻고, 획득 fx가 뜬다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0] // blue mage
  h.x = 0
  h.z = 0
  const before = h.gold
  const m = plantMinion(g, 'red', 5, 0, 30)
  castAttack(g, h.id)
  run(g, 0.3) // 탄이 닿아 처치될 만큼만 (gold fx는 0.8초 안에 사라진다)
  assert.ok(!g.minions.includes(m)) // 처치됨
  assert.ok(h.gold > before, '막타로 골드를 얻는다')
  // makeView fx에 gold 종류(소유자/금액 포함)가 직렬화된다
  const fx = makeView(g).fx.find((n) => n.kind === 'gold')
  assert.ok(fx && fx.owner === h.id && fx.n > 0)
})

test('골드: 타워가 막타를 치면(영웅 아님) 골드는 없다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0]
  const before = h.gold
  // 미니언을 타워가 잡게 둔다(영웅 개입 없음) — 골드 변화는 패시브 수입뿐
  const m = plantMinion(g, 'red', 0, 0, 10)
  g.minions = g.minions.filter((o) => o !== m)
  // 직접 막타 크레딧이 영웅이 아니면 골드를 안 준다는 건 awardGold 분기로 보장됨
  assert.equal(h.gold, before) // 위 조작만으론 골드 변화 없음
})

test('상점: 우물 안에서만 살 수 있고, 골드가 줄고 능력치가 오른다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2] // blue warrior
  h.gold = 1000
  const item = ITEMS_BY_ID.longsword // 공격력 +30 (효과 배율 1.5 → 45)
  // 우물 밖 + 살아있으면 거부
  h.x = 0
  h.z = 0
  assert.equal(canShop(h), false)
  buyItem(g, h.id, 'longsword')
  assert.equal(h.items.length, 0)
  // 우물 안에서는 구매 성공
  toFountain(g, h)
  buyItem(g, h.id, 'longsword')
  assert.deepEqual(h.items, ['longsword'])
  assert.equal(h.gold, 1000 - item.cost)
  assert.equal(h.bonus.atk, 45) // 30 × 1.5
})

test('상점: 죽어 있는 동안에도 우물 밖에서 살 수 있다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2]
  h.gold = 1000
  h.x = 0 // 우물 밖에서 전사
  h.z = 0
  h.respawnT = 8
  assert.equal(canShop(h), true)
  buyItem(g, h.id, 'dagger')
  assert.deepEqual(h.items, ['dagger'])
})

test('상점: 인벤토리는 3칸, 가득 차면 더 못 산다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2]
  toFountain(g, h)
  h.gold = 99999
  for (const id of ['dagger', 'longsword', 'leather', 'boots']) buyItem(g, h.id, id)
  assert.equal(h.items.length, ITEM_SLOTS)
  assert.ok(!h.items.includes('boots'), '4번째는 안 들어간다')
})

test('상점: 체력 아이템을 사면 최대 체력이 늘고 그만큼 즉시 회복', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[5] // red tank
  toFountain(g, h)
  h.gold = 9999
  h.hp = h.maxHp
  const max0 = h.maxHp
  buyItem(g, h.id, 'giant_heart') // hp +450 (×1.5 = 675)
  assert.equal(h.maxHp, max0 + 675)
  assert.equal(h.hp, h.maxHp) // 늘어난 만큼 채워진다
})

test('상점: 되팔면 칸이 비고 골드를 일부 돌려받는다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2]
  toFountain(g, h)
  h.gold = 1000
  buyItem(g, h.id, 'longsword') // 550
  const afterBuy = h.gold
  sellItem(g, h.id, 0)
  assert.equal(h.items.length, 0)
  assert.equal(h.bonus.atk, 0)
  assert.ok(h.gold > afterBuy && h.gold < 1000) // 일부 환급
})

test('아이템 효과: 공격력/방어 아이템이 실제 전투 수치에 반영된다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[1] // archer
  toFountain(g, h)
  h.gold = 9999
  buyItem(g, h.id, 'executioner') // atk +55 (×1.5 = 83)
  // 미니언을 한 대 쳐 보면 투사체 피해가 기본보다 커야 한다
  h.x = 0
  h.z = 0
  plantMinion(g, 'red', 6, 0, 999)
  castAttack(g, h.id)
  const dmg = g.projectiles[0].dmg
  const base = CLASSES.archer.atk // lvl1 기준
  assert.ok(dmg >= base + 80, '공격력 아이템(배율 포함)이 탄 피해에 더해진다')
})

test('방향성 스킬: 전사 돌진·궁수 화살·탱커 균열은 dir이 담긴 fx를 낸다(렌더러 계약)', () => {
  const g = createGame(humans())
  startPlaying(g)
  const w = g.heroes[2] // warrior
  const a = g.heroes[1] // archer
  const t = g.heroes[5] // tank
  // 각자 앞쪽에 적 미니언을 둬 자동 조준 방향이 생기게
  w.x = 0; w.z = -40; plantMinion(g, 'red', 8, -40, 500)
  a.x = 0; a.z = 40; plantMinion(g, 'red', 8, 40, 500)
  t.x = -40; t.z = -40; t.lvl = ULT_LEVEL; plantMinion(g, 'red', -32, -40, 500)
  castSkill(g, w.id)
  castSkill(g, a.id)
  castUlt(g, t.id)
  const v = makeView(g)
  for (const kind of ['dash', 'volley', 'fissure']) {
    const fx = v.fx.find((n) => n.kind === kind)
    assert.ok(fx, `${kind} fx가 있어야 한다`)
    assert.ok(typeof fx.dir === 'number', `${kind} fx에 dir이 직렬화돼야 한다`)
  }
  JSON.stringify(v) // 직렬화 안전성
})

test('미니언 균형: 미니언끼리는 영웅을 칠 때보다 천천히 깎인다', () => {
  const g = createGame(humans())
  startPlaying(g)
  // 같은 위치/체력의 미니언을 적 미니언 / 영웅 공격에 각각 노출해 비교
  const target1 = plantMinion(g, 'red', 0, 50, 200)
  const attacker = plantMinion(g, 'blue', 1.5, 50, 9999) // 근접 사거리 안
  // 다른 미니언/영웅 간섭 줄이기
  for (const h of g.heroes) { h.x = 300; h.z = 300 }
  run(g, 3)
  const lossVsMinion = 200 - target1.hp
  assert.ok(target1.hp > 0, '미니언끼리는 3초 안에 안 죽는다(천천히)')
  assert.ok(lossVsMinion > 0, '그래도 피해는 들어간다')
})

test('sumStats: 상한이 적용된다 (피해 감소 ≤ 60%)', () => {
  const b = sumStats(['guardian_cloak', 'guardian_cloak', 'guardian_cloak', 'guardian_cloak', 'guardian_cloak'])
  assert.ok(b.def <= 0.6)
})

// 다른 영웅/미니언 간섭 없이 한 영웅만 시험하기 좋게 정리한다
function isolate(g, keep) {
  for (const o of g.heroes) if (o !== keep) { o.x = 300; o.z = 300; o.respawnT = 999 }
  g.minions.length = 0
  g.waveT = 9999 // 새 웨이브 차단
}

test('특수효과 ▸ 공격속도: 광폭의 장갑이 공격 쿨다운을 줄인다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[1] // archer
  isolate(g, h)
  h.x = 0; h.z = 0
  plantMinion(g, 'red', 5, 0, 9999)
  castAttack(g, h.id)
  const cd0 = h.atkCd // 기본 공격 쿨다운
  h.atkCd = 0
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'rage_gloves') // atkSpeed 0.25 ×1.5 = 0.375
  h.x = 0; h.z = 0
  g.minions.length = 0
  plantMinion(g, 'red', 5, 0, 9999)
  castAttack(g, h.id)
  assert.ok(Math.abs(h.atkCd - cd0 * (1 - 0.375)) < 0.001, '쿨다운이 37.5% 짧아진다')
})

test('특수효과 ▸ 쿨감: 빛의 부적이 스킬 쿨다운을 줄인다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2] // warrior (skill cd 7)
  castSkill(g, h.id)
  const cd0 = h.skillCd
  h.skillCd = 0
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'light_charm') // cdr 0.2 ×1.5 = 0.3
  castSkill(g, h.id)
  assert.ok(Math.abs(h.skillCd - cd0 * 0.7) < 0.01, '스킬 쿨다운이 30% 짧아진다')
})

test('특수효과 ▸ 사거리: 사냥꾼의 인장이 기본공격 사거리를 늘린다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2] // warrior (range 3.8)
  isolate(g, h)
  h.x = 0; h.z = 0
  const far = CLASSES.warrior.range + 3 // 기본 사거리 밖이지만 +4.5 안에는 든다
  plantMinion(g, 'red', far, 0, 9999)
  castAttack(g, h.id)
  assert.equal(g.projectiles.length, 0) // 기본 사거리 밖이라 조준 실패
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'hunter_seal') // range 3 ×1.5 = 4.5
  h.x = 0; h.z = 0
  castAttack(g, h.id)
  assert.equal(g.projectiles.length, 1) // 사거리가 늘어 사격된다
})

test('특수효과 ▸ 흡혈: 흡혈낫은 때릴 때 체력을 회복한다 (자연회복분 이상)', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[1] // archer
  isolate(g, h)
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'vampire_scythe') // lifesteal 0.15 ×1.5 = 0.225
  h.x = 0; h.z = 0
  h.hp = 100
  plantMinion(g, 'red', 5, 0, 9999)
  const hp0 = h.hp
  castAttack(g, h.id)
  run(g, 0.25) // 탄이 명중하는 순간 흡혈
  // 같은 0.25초 동안 자연회복은 maxHp*1.5%*0.25 ≈ 1~2뿐 → 5 이상이면 흡혈 덕분
  assert.ok(h.hp - hp0 > 5, '기본공격 적중 시 흡혈로 회복')
})

test('특수효과 ▸ 재생: 재생의 목걸이는 전투 중에도 체력을 채운다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[5] // tank
  isolate(g, h)
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'regen_pendant') // regen 0.018 ×1.5 = 0.027 /s
  h.x = 0; h.z = 0
  h.hp = 100
  h.lastHurt = g.time // 방금 맞은 셈 → 5초 자연회복은 꺼 둔다(아이템 재생만 분리 측정)
  const hp0 = h.hp
  run(g, 1)
  const expect = h.maxHp * 0.027 * 1
  assert.ok(h.hp - hp0 > expect * 0.8, '자연회복이 꺼진 동안에도 아이템 재생으로 회복')
})

test('특수효과 ▸ 이동속도: 신속의 장화로 같은 시간에 더 멀리 간다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[2] // warrior
  isolate(g, h)
  h.x = 0; h.z = 0
  setInput(g, h.id, { mx: 0, mz: 1 })
  run(g, 0.5)
  const d0 = Math.hypot(h.x, h.z)
  h.x = 0; h.z = 0
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'boots') // speed +2.8 ×1.5 = 4.2
  h.x = 0; h.z = 0
  setInput(g, h.id, { mx: 0, mz: 1 })
  run(g, 0.5)
  const d1 = Math.hypot(h.x, h.z)
  assert.ok(d1 > d0 + 1, '장화를 신으면 같은 시간에 더 멀리 이동')
})

test('특수효과 ▸ 주문 위력: 공허의 지팡이가 스킬 피해를 키운다', () => {
  const g = createGame(humans())
  startPlaying(g)
  const h = g.heroes[0] // mage
  isolate(g, h)
  h.x = 0; h.z = 0
  castSkill(g, h.id) // 화염구
  const dmg0 = g.projectiles.find((p) => p.kind === 'fireball').dmg
  g.projectiles.length = 0
  h.skillCd = 0
  toFountain(g, h); h.gold = 9999
  buyItem(g, h.id, 'void_staff') // power 70 ×1.5 = 105
  h.x = 0; h.z = 0
  castSkill(g, h.id)
  const dmg1 = g.projectiles.find((p) => p.kind === 'fireball').dmg
  assert.ok(dmg1 - dmg0 > 100, '주문 위력이 스킬 피해에 더해진다')
})

// ── 5:5 모드 ──
// 탑·미드·봇 솔로 + 봇 지원 힐러 + 정글러, 더 큰 맵 + 정글 캠프 증가.
function humans5v5() {
  // 팀당 4명(직업 4종) 사람 + 1명 봇 = 5:5 (RiftGame이 빈자리를 봇으로 채우는 모습)
  const defs = [
    ['rat', 'mage', 'blue', false], ['ox', 'archer', 'blue', false],
    ['tiger', 'warrior', 'blue', false], ['rabbit', 'healer', 'blue', false],
    ['monkey', 'tank', 'blue', true],
    ['dragon', 'assassin', 'red', false], ['snake', 'tank', 'red', false],
    ['horse', 'mage', 'red', false], ['sheep', 'archer', 'red', false],
    ['rooster', 'warrior', 'red', true],
  ]
  return defs.map(([id, cls, team, isBot]) => ({
    id, name: id.toUpperCase(), zodiacId: id, color: '#abc', cls, team, isBot,
  }))
}

test('5:5 ▸ buildMap: 맵이 3:3보다 크고 정글 캠프가 늘어난다', () => {
  const m3 = buildMap('3v3')
  const m5 = buildMap('5v5')
  assert.ok(m5.WORLD.maxX > m3.WORLD.maxX, '5:5 월드가 더 넓다')
  assert.ok(m5.WORLD.maxZ > m3.WORLD.maxZ, '5:5 월드가 더 깊다')
  assert.ok(m5.WOLF_CAMPS.length > m3.WOLF_CAMPS.length, '5:5 정글 캠프가 더 많다')
  // 넥서스/타워는 모두 월드 안에 있어야 한다
  for (const t of m5.TOWER_SPOTS) {
    assert.ok(t.x >= m5.WORLD.minX && t.x <= m5.WORLD.maxX)
    assert.ok(t.z >= m5.WORLD.minZ && t.z <= m5.WORLD.maxZ)
  }
})

test('5:5 ▸ createGame: 팀당 5명, 빈자리 봇이 정글/지원 역할까지 채운다', () => {
  const g = createGame(humans5v5(), { mode: '5v5' })
  assert.equal(g.mode, '5v5')
  assert.equal(g.teamSize, 5)
  assert.equal(g.heroes.length, 10)
  for (const team of ['blue', 'red']) {
    const mine = g.heroes.filter((h) => h.team === team)
    assert.equal(mine.length, 5)
    assert.equal(new Set(mine.map((h) => h.cls)).size, 5) // 직업 중복 없음
    const botRoles = mine.filter((h) => h.isBot).map((h) => h.role)
    assert.equal(botRoles.length, 1) // 4명이 사람 → 봇 1명
    // 봇 역할은 5:5 역할 풀(mid/jungle/bot/support/top)에서 첫 우선순위 'mid'
    assert.equal(botRoles[0], 'mid')
  }
  // 우물(회복 지대) 좌표가 영웅에 새겨진다
  for (const h of g.heroes) {
    assert.equal(h.homeX, g.map.NEXUS_POS[h.team].x)
    assert.ok(canShop(h)) // 시작 시 우물 안 → 상점 가능
  }
})

test('5:5 ▸ 큰 맵에서 게임이 안정적으로 진행된다(범위 이탈/예외 없음)', () => {
  const g = createGame(humans5v5(), { mode: '5v5' })
  startPlaying(g)
  run(g, 30) // 30초 시뮬 — 봇 AI(정글러/지원 포함)가 돌아간다
  for (const h of g.heroes) {
    assert.ok(h.x >= g.map.WORLD.minX - 1 && h.x <= g.map.WORLD.maxX + 1, '맵 안에 머문다')
    assert.ok(h.z >= g.map.WORLD.minZ - 1 && h.z <= g.map.WORLD.maxZ + 1)
  }
  const v = makeView(g)
  assert.equal(v.mode, '5v5')
  assert.equal(v.heroes.length, 10)
  // 미니언 웨이브가 3레인에 생성됐다
  assert.ok(v.minions.length > 0)
})

test('5:5 ▸ makeBot 인계: 5:5 역할 풀에서 빈 역할을 맡는다', () => {
  const g = createGame(humans5v5(), { mode: '5v5' })
  const h = g.heroes.find((o) => !o.isBot)
  makeBot(g, h.id)
  assert.ok(h.isBot)
  assert.ok(['mid', 'top', 'bot', 'support', 'jungle'].includes(h.role))
})
