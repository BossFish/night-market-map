/**
 * 开发用小工具：验证 zone 云函数的评分逻辑。
 *
 * 覆盖：48 小时生效期、改分、去掉最高最低、刷分降权、频率上限、
 * 四个维度的读写、我的打分列表。
 *
 * 云函数依赖微信上下文，本地跑不了，所以这里用内存版假数据库，
 * 连聚合管道和查询命令符都照着我们用到的那几种实现了一遍。
 * 只验证逻辑，不验证云端连通性。
 *
 * 运行：node tools/check-zone-rate.js
 */
const Module = require('module')
const path = require('path')

const HOUR = 60 * 60 * 1000

function makeZone(id, order) {
  return {
    _id: id,
    name_zh: '夜市' + id,
    name_en: 'Market ' + id,
    business_hours: '17:00 - 01:00',
    ne: { latitude: 34.27, longitude: 108.94 },
    sw: { latitude: 34.26, longitude: 108.93 },
    sort_order: order,
    is_visible: true
  }
}

let zones = []
for (let i = 1; i <= 14; i++) zones.push(makeZone('z' + i, i))

let ratings = []
let ratingSeq = 0
let currentOpenid = 'openid-a'

function clone(value) {
  // 注意要保住 Date 对象：走 JSON 克隆会把它变成字符串，
  // 之后所有时间比较都会失效（这个坑测试里真踩过一次）。
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(function (key) {
      out[key] = clone(value[key])
    })
    return out
  }
  return value
}

/** 查询命令符：只实现我们真正用到的几个 */
const queryOps = {
  gt: function (value) {
    return { __op: 'gt', value: value }
  },
  gte: function (value) {
    return { __op: 'gte', value: value }
  },
  lte: function (value) {
    return { __op: 'lte', value: value }
  },
  in: function (value) {
    return { __op: 'in', value: value }
  }
}

function compare(fieldValue, condition) {
  if (condition && condition.__op) {
    switch (condition.__op) {
      case 'gt':
        return fieldValue > condition.value
      case 'gte':
        return fieldValue >= condition.value
      case 'lte':
        return fieldValue <= condition.value
      case 'in':
        return condition.value.indexOf(fieldValue) >= 0
      default:
        return false
    }
  }
  return fieldValue === condition
}

function matches(doc, condition) {
  return Object.keys(condition).every(function (key) {
    return compare(doc[key], condition[key])
  })
}

const aggregateOps = {
  avg: function (field) {
    return { __op: 'avg', field: field }
  },
  sum: function (value) {
    return { __op: 'sum', value: value }
  }
}

function fieldName(expression) {
  return String(expression).replace('$', '')
}

function makeAggregate(source) {
  let rows = source.slice()
  let grouped = null

  const pipeline = {
    match: function (condition) {
      rows = rows.filter(function (row) {
        return matches(row, condition)
      })
      return pipeline
    },
    group: function (spec) {
      const buckets = {}
      const idField = fieldName(spec._id)

      rows.forEach(function (row) {
        const key = row[idField]
        if (!buckets[key]) buckets[key] = []
        buckets[key].push(row)
      })

      grouped = Object.keys(buckets).map(function (key) {
        const group = buckets[key]
        const out = { _id: key }
        Object.keys(spec).forEach(function (name) {
          if (name === '_id') return
          const op = spec[name]
          if (!op || !op.__op) return
          if (op.__op === 'sum') out[name] = group.length * op.value
          if (op.__op === 'avg') {
            const field = fieldName(op.field)
            out[name] = group.reduce(function (total, row) {
              return total + row[field]
            }, 0) / group.length
          }
        })
        return out
      })
      return pipeline
    },
    end: async function () {
      return { list: grouped || [] }
    }
  }

  return pipeline
}

const fakeSdk = {
  init: function () {},
  DYNAMIC_CURRENT_ENV: 'fake-env',
  getWXContext: function () {
    return { OPENID: currentOpenid }
  },
  database: function () {
    return {
      command: Object.assign({ aggregate: aggregateOps }, queryOps),
      collection: function (name) {
        const source = name === 'zones' ? zones : ratings

        return {
          limit: function () {
            return {
              get: async function () {
                return { data: source.slice() }
              }
            }
          },
          where: function (condition) {
            const rows = function () {
              return source.filter(function (row) {
                return matches(row, condition)
              })
            }
            const chain = {
              limit: function () {
                return chain
              },
              get: async function () {
                return { data: rows() }
              },
              count: async function () {
                return { total: rows().length }
              }
            }
            return chain
          },
          add: async function (options) {
            ratingSeq += 1
            const id = 'r' + ratingSeq
            ratings.push(Object.assign({ _id: id }, clone(options.data)))
            return { _id: id }
          },
          doc: function (id) {
            return {
              get: async function () {
                const found = zones.filter(function (z) {
                  return z._id === id
                })[0]
                if (!found) {
                  const err = new Error('document not exists')
                  err.errCode = -502002
                  throw err
                }
                return { data: found }
              },
              update: async function (options) {
                const target = ratings.filter(function (r) {
                  return r._id === id
                })[0]
                if (target) Object.assign(target, clone(options.data))
                return {}
              }
            }
          },
          aggregate: function () {
            return makeAggregate(source)
          }
        }
      }
    }
  }
}

const originalLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk
  return originalLoad.apply(this, arguments)
}

const zoneFn = require(path.join(__dirname, '..', 'cloudfunctions', 'zone', 'index.js'))

// ---------- 造数据的小工具 ----------

let seedSeq = 0

/** 直接往库里塞一条评分，绕过接口，用来构造统计场景 */
function seedRating(zoneId, openid, stars, ageHours) {
  seedSeq += 1
  const created = new Date(Date.now() - ageHours * HOUR)
  ratings.push({
    _id: 'seed' + seedSeq,
    zone_id: zoneId,
    openid: openid,
    stars: stars,
    aspects: {},
    created_at: created,
    updated_at: created
  })
}

/** 把某人刚提交的评分改成"很久以前"，模拟 48 小时已经过去 */
function ageRating(zoneId, openid, ageHours) {
  const doc = ratings.filter(function (r) {
    return r.zone_id === zoneId && r.openid === openid
  })[0]
  if (doc) doc.created_at = new Date(Date.now() - ageHours * HOUR)
}

function reset() {
  ratings = []
  seedSeq = 0
  currentOpenid = 'openid-a'
}

function zoneOf(list, id) {
  return list.data.filter(function (z) {
    return z._id === id
  })[0]
}

async function run() {
  const checks = []

  // ---------- 打分与 48 小时生效期 ----------

  reset()
  const list0 = await zoneFn.main({ action: 'list' })
  checks.push([
    '初始状态：没有推荐度，也没有我的评分',
    list0.data[0].rating.count === 0 && list0.data[0].mine === null
  ])

  const r1 = await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 5 })
  checks.push([
    '刚打完分，我的评分能看到，但推荐度还不算它',
    r1.ok === true && r1.data.mine.stars === 5 && r1.data.mine.pending === true && r1.data.rating.count === 0
  ])

  const listPending = await zoneFn.main({ action: 'list' })
  checks.push([
    '等待生效期间，区域列表里的推荐度仍是零',
    zoneOf(listPending, 'z1').rating.count === 0 && zoneOf(listPending, 'z1').mine.pending === true
  ])

  ageRating('z1', 'openid-a', 49)
  const listEffective = await zoneFn.main({ action: 'list' })
  checks.push([
    '满 48 小时后评分生效，推荐度开始计入',
    zoneOf(listEffective, 'z1').rating.count === 1 &&
      zoneOf(listEffective, 'z1').rating.avg === 5 &&
      zoneOf(listEffective, 'z1').mine.pending === false
  ])

  // ---------- 改分 ----------

  const r2 = await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 3 })
  checks.push([
    '改分成功，人数不变',
    r2.ok === true && r2.data.mine.stars === 3 && r2.data.rating.count === 1 && r2.data.rating.avg === 3
  ])
  checks.push(['改分不会把 48 小时重新计时', r2.data.mine.pending === false])

  // ---------- 去掉一个最高分和一个最低分 ----------

  reset()
  seedRating('z2', 'u1', 1, 72)
  seedRating('z2', 'u2', 5, 72)
  seedRating('z2', 'u3', 5, 72)
  seedRating('z2', 'u4', 5, 72)
  seedRating('z2', 'u5', 5, 72)
  const listTrim = await zoneFn.main({ action: 'list' })
  checks.push([
    '去掉一个最低最低分，平均分从 4.2 变成 5',
    zoneOf(listTrim, 'z2').rating.count === 5 && zoneOf(listTrim, 'z2').rating.avg === 5
  ])

  seedRating('z3', 'u1', 1, 72)
  seedRating('z3', 'u2', 5, 72)
  const listTiny = await zoneFn.main({ action: 'list' })
  checks.push([
    '只有两条评分时不去极值，直接取平均',
    zoneOf(listTiny, 'z3').rating.count === 2 && zoneOf(listTiny, 'z3').rating.avg === 3
  ])

  // ---------- 刷分降权 ----------

  reset()
  seedRating('z4', 'u1', 1, 72)
  seedRating('z4', 'u2', 2, 72)
  seedRating('z4', 'spammer', 4, 72)
  seedRating('z4', 'u3', 5, 72)
  seedRating('z4', 'u4', 5, 72)

  const beforeSpam = await zoneFn.main({ action: 'list' })
  checks.push([
    '刷分者还在正常权重时，平均分 3.7',
    zoneOf(beforeSpam, 'z4').rating.avg === 3.7
  ])

  for (let i = 5; i <= 14; i++) {
    seedRating('z' + i, 'spammer', 1, 1)
  }
  const afterSpam = await zoneFn.main({ action: 'list' })
  checks.push([
    '刷分者按两成权重算之后，同一个区域的平均分降到 3.5',
    zoneOf(afterSpam, 'z4').rating.avg === 3.5
  ])

  // ---------- 频率上限 ----------

  reset()
  currentOpenid = 'openid-x'
  for (let i = 1; i <= 10; i++) {
    seedRating('z' + i, 'openid-x', 4, 1)
  }

  const blocked = await zoneFn.main({ action: 'rate', zoneId: 'z11', stars: 4 })
  checks.push([
    '48 小时内评满 10 个区域后，第 11 个被拦下',
    blocked.ok === false && blocked.code === 'TOO_FREQUENT'
  ])

  const editAllowed = await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 5 })
  checks.push(['已经评过的区域仍然可以改分', editAllowed.ok === true])

  process.env.ADMIN_OPENIDS = 'openid-x'
  const adminAllowed = await zoneFn.main({ action: 'rate', zoneId: 'z12', stars: 4 })
  checks.push(['管理员不受频率限制', adminAllowed.ok === true])
  delete process.env.ADMIN_OPENIDS

  // ---------- 四个维度 ----------

  reset()
  const aspectsBefore = await zoneFn.main({ action: 'setAspects', zoneId: 'z1', aspects: { hygiene: 0 } })
  checks.push(['没打过分就不能填维度', aspectsBefore.ok === false && aspectsBefore.code === 'NOT_FOUND'])

  await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 4 })
  const aspectsAfter = await zoneFn.main({
    action: 'setAspects',
    zoneId: 'z1',
    aspects: { hygiene: 0, seating: 2, crowding: 1, management: 9 }
  })
  checks.push([
    '维度能存下来，非法值被丢掉',
    aspectsAfter.ok === true &&
      aspectsAfter.data.aspects.hygiene === 0 &&
      aspectsAfter.data.aspects.seating === 2 &&
      aspectsAfter.data.aspects.crowding === 1 &&
      aspectsAfter.data.aspects.management === undefined
  ])

  // ---------- 我的打分 ----------

  reset()
  currentOpenid = 'openid-a'
  await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 5 })
  await zoneFn.main({ action: 'rate', zoneId: 'z2', stars: 3 })
  const mineList = await zoneFn.main({ action: 'mine' })
  checks.push([
    '我的打分能列出两个区域，并带上名称',
    mineList.ok === true &&
      mineList.data.length === 2 &&
      mineList.data[0].name_zh.indexOf('夜市') === 0
  ])

  currentOpenid = 'openid-z'
  const mineEmpty = await zoneFn.main({ action: 'mine' })
  checks.push(['没打过分的人，我的打分是空列表', mineEmpty.data.length === 0])

  currentOpenid = ''
  const noOpenid = await zoneFn.main({ action: 'rate', zoneId: 'z1', stars: 3 })
  checks.push(['拿不到身份时拒绝打分', noOpenid.code === 'NO_OPENID'])

  let failed = 0
  checks.forEach(function (item) {
    if (!item[1]) failed += 1
    console.log((item[1] ? 'PASS  ' : 'FAIL  ') + item[0])
  })
  console.log('')
  console.log(failed === 0 ? '全部通过（' + checks.length + ' 项）' : failed + ' 项失败')
  process.exit(failed === 0 ? 0 : 1)
}

run()
