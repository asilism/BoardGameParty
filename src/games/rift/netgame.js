// 파티 리프트 — 실시간 네트코드 어댑터(서버 권위 + 클라 예측/보간 공용).
import {
  createGame, setInput, castAttack, castSkill, castSkill2, castUlt, castRecall, buyItem, sellItem, resetShop,
  step, makeView, makeBot, STEP, TEAM_SIZE, TEAM_SIZES, CLASS_IDS,
} from './engine.js'
import { ZODIAC, getZodiac } from '../../shared/zodiac.js'
import { racers } from '../../net/realtime/roster.js'

export const riftNet = {
  id: 'rift',
  STEP,
  // 교전이 잦은 AOS라 20Hz보다 촘촘한 30Hz(33ms)로 방송해 체감 반응을 높인다.
  snapshotMs: 33,

  buildParticipants(players, config) {
    const mode = config?.mode || '3v3'
    const teams = config?.teams || {}
    const classes = config?.classes || {}
    const teamSize = TEAM_SIZES[mode] || TEAM_SIZE
    const humans = racers(players).map((p) => ({
      id: p.id, name: p.name, zodiacId: p.zodiacId, color: getZodiac(p.zodiacId)?.color,
      team: teams[p.id] || 'blue', cls: classes[p.id],
    }))
    const used = new Set((players || []).map((p) => p.zodiacId))
    const free = ZODIAC.filter((z) => !used.has(z.id))
    const bots = []
    for (const team of ['blue', 'red']) {
      const mine = humans.filter((h) => h.team === team)
      const takenCls = new Set(mine.map((h) => h.cls))
      for (let i = mine.length; i < teamSize; i++) {
        const z = free.shift()
        if (!z) break
        const cls = CLASS_IDS.find((c) => !takenCls.has(c))
        takenCls.add(cls)
        bots.push({
          id: `bot-${z.id}`, name: `${z.name}봇`, zodiacId: z.id, color: z.color,
          team, cls, isBot: true,
        })
      }
    }
    return { players: [...humans, ...bots], opts: { mode } }
  },
  createGame: (players, opts) => createGame(players, { mode: opts?.mode, rng: Math.random }),
  setInput,
  applyAction(state, action, pid) {
    if (action.type === 'cast') {
      if (action.slot === 'atk') castAttack(state, pid)
      else if (action.slot === 'skill') castSkill(state, pid)
      else if (action.slot === 'skill2') castSkill2(state, pid)
      else if (action.slot === 'ult') castUlt(state, pid)
      else if (action.slot === 'recall') castRecall(state, pid)
    } else if (action.type === 'buy') buyItem(state, pid, action.itemId)
    else if (action.type === 'sell') sellItem(state, pid, action.slot)
    else if (action.type === 'resetShop') resetShop(state, pid)
  },
  step,
  makeView,
  makeBot,

  // ── 클라 예측(①): 내 영웅 이동 ──
  localKey: 'heroes',
  angleField: 'dir',
  readInput: (c) => ({ mx: c.mx || 0, mz: c.mz || 0 }),
  inputSig: (c) => `${(c.mx || 0).toFixed(2)}|${(c.mz || 0).toFixed(2)}`,
  predictLocal(pred, ctrl, me, dt) {
    // 사망/기절/정신집중/귀환 중엔 제자리 → 권위값에 맡김(클라 예측 정지)
    if (me.respawnT > 0 || me.stunT > 0 || me.castT > 0 || me.recallT > 0) return
    const len = Math.hypot(ctrl.mx || 0, ctrl.mz || 0)
    if (len <= 0.12) return
    const sp = me.mvSpeed || 8
    pred.ang = Math.atan2(ctrl.mz, ctrl.mx)
    pred.x += (ctrl.mx / len) * sp * dt
    pred.z += (ctrl.mz / len) * sp * dt
  },

  // ── 게스트 보간(③) ──
  interpolate(buf, t) {
    if (!buf.length) return null
    let a = null
    let b = buf[buf.length - 1]
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].at <= t) {
        a = buf[i]
        b = buf[i + 1] || buf[i]
        break
      }
    }
    if (!a || a === b || b.at <= a.at) return b.v
    const f = Math.min(1, (t - a.at) / (b.at - a.at))
    const lerp = (x, y) => x + (y - x) * f
    const lerpAng = (x, y) => {
      let d = y - x
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return x + d * f
    }
    const lerpList = (la, lb, extra) =>
      lb.map((eb) => {
        const ea = la?.find((o) => o.id === eb.id)
        if (!ea) return eb
        return { ...eb, x: lerp(ea.x, eb.x), z: lerp(ea.z, eb.z), ...(extra ? extra(ea, eb) : null) }
      })
    return {
      ...b.v,
      time: lerp(a.v.time ?? 0, b.v.time ?? 0),
      heroes: lerpList(a.v.heroes, b.v.heroes, (ea, eb) => ({ dir: lerpAng(ea.dir, eb.dir) })),
      minions: lerpList(a.v.minions, b.v.minions, (ea, eb) => ({ dir: lerpAng(ea.dir || 0, eb.dir || 0) })),
      monsters: lerpList(a.v.monsters, b.v.monsters),
      projectiles: lerpList(a.v.projectiles, b.v.projectiles),
    }
  },
}
