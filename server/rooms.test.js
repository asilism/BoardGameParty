import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoomStore, normalizeCode, MAX_PLAYERS } from './rooms.js'

test('방 생성: 4글자 코드, 만든 기기가 호스트', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  assert.equal(room.code.length, 4)
  assert.equal(room.hostId, 'dev-A')
  assert.equal(room.screen, 'lobby')
  assert.equal(s.rooms.get(room.code), room)
})

test('참여: 코드 대소문자/공백 무시, 없는 코드는 에러', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  const joined = s.join(` ${room.code.toLowerCase()} `, 'dev-B')
  assert.equal(joined, room)
  assert.throws(() => s.join('ZZZZZZ', 'dev-C'), /찾을 수 없어요/)
})

test('참가자: 기기별 추가, 말 중복 금지, 전체 정원 제한', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-A', { zodiacId: 'rat', name: '아라' })
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: '' })
  assert.throws(() => s.addPlayer(room, 'dev-B', { zodiacId: 'rat', name: 'X' }), /이미 누가/)
  assert.throws(() => s.addPlayer(room, 'dev-B', { zodiacId: 'lion', name: 'X' }), /알 수 없는/)

  const more = ['tiger', 'rabbit', 'dragon']
  more.forEach((z) => s.addPlayer(room, 'dev-A', { zodiacId: z, name: z }))
  assert.equal(s.allPlayers(room).length, MAX_PLAYERS)
  assert.throws(() => s.addPlayer(room, 'dev-B', { zodiacId: 'snake' }), /최대/)
})

test('참가자 제거: 내 것만 가능, 호스트는 모두 가능', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-A', { zodiacId: 'rat', name: 'A' })
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: 'B' })

  assert.throws(() => s.removePlayer(room, 'dev-B', 'rat'), /내 참가자만/)
  s.removePlayer(room, 'dev-B', 'ox') // 내 것 OK
  s.removePlayer(room, 'dev-A', 'rat') // 호스트 OK
  assert.equal(s.allPlayers(room).length, 0)
})

test('화면 전환은 호스트만', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  assert.throws(() => s.setScreen(room, 'dev-B', 'ladder'), /호스트만/)
  s.setScreen(room, 'dev-A', 'ladder')
  assert.equal(room.screen, 'ladder')
})

test('이탈: 게스트는 참가자만 빠지고, 호스트가 나가면 방이 닫힌다', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: 'B' })

  assert.equal(s.leave(room, 'dev-B'), 'left')
  assert.equal(s.allPlayers(room).length, 0)
  assert.ok(s.rooms.has(room.code))

  assert.equal(s.leave(room, 'dev-A'), 'closed')
  assert.ok(!s.rooms.has(room.code))
})

test('스냅샷: 모든 기기의 참가자를 합쳐 deviceId와 함께 반환', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-A', { zodiacId: 'rat', name: '아라' })
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: 'burrito' }) // 6자 초과 → 잘림
  const snap = s.snapshot(room)
  assert.equal(snap.deviceCount, 2)
  assert.deepEqual(
    snap.players.map((p) => [p.id, p.deviceId]),
    [['rat', 'dev-A'], ['ox', 'dev-B']]
  )
  assert.equal(snap.players[1].name, 'burrit')
})

test('연결 상태: 오프라인 표시는 참가자를 유지하고 스냅샷에 드러난다', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: 'B' })

  assert.equal(s.setOnline(room, 'dev-B', false), true)
  assert.equal(s.setOnline(room, 'dev-X', false), false) // 없는 기기

  let snap = s.snapshot(room)
  assert.equal(snap.hostOnline, true)
  assert.equal(snap.deviceCount, 1) // 온라인 기기만 센다
  assert.deepEqual(snap.players.map((p) => [p.id, p.online]), [['ox', false]])

  // 호스트가 끊기면 hostOnline=false (방은 유예 동안 유지)
  s.setOnline(room, 'dev-A', false)
  snap = s.snapshot(room)
  assert.equal(snap.hostOnline, false)
  assert.ok(s.rooms.has(room.code))
})

test('재접속: findRoomByDevice로 방을 찾고, join은 기존 참가자를 유지한 채 복귀', () => {
  const s = createRoomStore()
  const room = s.create('dev-A')
  s.join(room.code, 'dev-B')
  s.addPlayer(room, 'dev-B', { zodiacId: 'ox', name: 'B' })
  s.setOnline(room, 'dev-B', false)

  assert.equal(s.findRoomByDevice('dev-B'), room)
  assert.equal(s.findRoomByDevice('dev-X'), null)

  // 새로고침 후 같은 코드로 다시 join → 온라인 복귀 + 참가자 그대로
  const rejoined = s.join(room.code, 'dev-B')
  assert.equal(rejoined, room)
  const snap = s.snapshot(rejoined)
  assert.deepEqual(snap.players.map((p) => [p.id, p.online]), [['ox', true]])
  assert.equal(snap.deviceCount, 2)
})

test('normalizeCode', () => {
  assert.equal(normalizeCode(' ab2x '), 'AB2X')
})
