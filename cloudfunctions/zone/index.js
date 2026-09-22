/**
 * 云函数：zone
 *
 * 负责「夜市区域」和「区域评分」，用 action 区分：
 *   list        —— 全部可见区域，附带推荐度统计和我自己的评分
 *   rate        —— 打分（新评或改分）
 *   setAspects  —— 设置四个维度（卫生/座位/拥挤/管理）
 *   mine        —— 我打过的所有分，给「我的 → 我的打分」用
 *
 * 三条评分规则，都在这个文件里实现：
 *   1. 打完分要等 48 小时才生效，期间不计入推荐度
 *   2. 统计时去掉一个最高分和一个最低分
 *   3. 48 小时内给满 10 个不同区域打过分的人，判定为刷分：
 *      他的评分在统计里只按八成权重算，而且不能再给第 11 个区域打分
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const ZONES = 'zones'
const RATINGS = 'zone_ratings'

// 评分等多久才生效
const PENDING_MS = 48 * 60 * 60 * 1000

// 48 小时内给这么多个不同区域打过分，就判定为刷分
const SPAM_ZONE_LIMIT = 10

// 判定刷分后，这个人的评分在统计里只按两成权重算
const SPAM_WEIGHT = 0.2

// 一次最多扫这么多条评分来算统计。
// 初期数据量小，够用；涨到接近这个数的时候需要改成聚合管道，见文件末尾说明。
const MAX_RATINGS_SCAN = 1000

function ok(data) {
  return { ok: true, data: data }
}

function fail(code, msg) {
  return { ok: false, code: code, msg: msg }
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function isCollectionMissing(err) {
  return !!(err && (err.errCode === -502005 || /collection not exists/i.test(err.errMsg || '')))
}

/** 这个时间点之前的评分才算生效 */
function effectiveBefore() {
  return new Date(Date.now() - PENDING_MS)
}

function isPending(doc) {
  const created = doc.created_at ? new Date(doc.created_at).getTime() : 0
  return Date.now() - created < PENDING_MS
}

/** 管理员不受频率限制。openid 列表放在云函数环境变量 ADMIN_OPENIDS 里，逗号分隔 */
function isAdmin(openid) {
  const raw = process.env.ADMIN_OPENIDS || ''
  return raw
    .split(',')
    .map(function (item) {
      return item.trim()
    })
    .filter(Boolean)
    .indexOf(openid) >= 0
}

function toClientZone(doc) {
  const ne = doc.ne || {}
  const sw = doc.sw || {}
  return {
    _id: doc._id,
    name_zh: doc.name_zh || '',
    name_en: doc.name_en || '',
    business_hours: doc.business_hours || '',
    ne: { latitude: ne.latitude, longitude: ne.longitude },
    sw: { latitude: sw.latitude, longitude: sw.longitude }
  }
}

function toClientMine(doc) {
  if (!doc) return null
  return {
    stars: doc.stars,
    pending: isPending(doc),
    aspects: doc.aspects || {}
  }
}

// ---------- 统计 ----------

/**
 * 找出「最近 48 小时内评了 10 个以上区域」的人。
 *
 * 一个人对一个区域只有一条评分记录，所以最近 48 小时的记录条数
 * 就等于他评过的区域数，不用再去重。
 */
async function penalizedOpenids() {
  try {
    const res = await db
      .collection(RATINGS)
      .aggregate()
      .match({ created_at: _.gt(effectiveBefore()) })
      .group({ _id: '$openid', count: $.sum(1) })
      .match({ count: _.gte(SPAM_ZONE_LIMIT) })
      .end()

    const map = {}
    ;(res.list || []).forEach(function (row) {
      if (row._id) map[row._id] = true
    })
    return map
  } catch (err) {
    if (isCollectionMissing(err)) return {}
    throw err
  }
}

/**
 * 去掉一个最高分和一个最低分。
 *
 * 只有 1~2 条评分时不去极值——否则会一条不剩，平均分变成 0。
 * 反正评分人数不到 7 个的时候前端也不显示档位，这里只要保证数字是合理的。
 */
function trimExtremes(docs) {
  if (docs.length <= 2) return docs.slice()

  const sorted = docs.slice().sort(function (a, b) {
    return a.stars - b.stars
  })
  const lowest = sorted[0]
  const highest = sorted[sorted.length - 1]

  const kept = docs.slice()
  kept.splice(kept.indexOf(lowest), 1)
  kept.splice(kept.indexOf(highest), 1)
  return kept
}

/** 加权平均：被判刷分的人，每一票只算 SPAM_WEIGHT 的份量 */
function weightedAverage(docs, penalized) {
  let weightedSum = 0
  let weightTotal = 0

  docs.forEach(function (doc) {
    const weight = penalized[doc.openid] ? SPAM_WEIGHT : 1
    weightedSum += weight * doc.stars
    weightTotal += weight
  })

  if (!weightTotal) return 0
  return round1(weightedSum / weightTotal)
}

/**
 * 算出每个区域的推荐度。
 *
 * 返回 { 区域id: { avg, count } }。count 是**已生效的评分人数**，
 * 也就是真实评过分的总人数；avg 是"去掉一个最高最低 + 刷分者降权"之后的结果。
 * 两者口径不同是有意的：人数给用户看的是"多少人评过"，
 * 而平均分需要做防刷处理。
 *
 * 这里把待统计的评分取回云函数里算，而不是全用聚合管道：
 * "去掉最高最低"和"按人降权"叠在一起，用管道表达非常绕，容易算错。
 * 代价是一次最多处理 MAX_RATINGS_SCAN 条，
 * 等数据量真的长起来，再改成管道里算或把结果缓存起来。
 */
async function summarize() {
  let docs = []

  try {
    const res = await db
      .collection(RATINGS)
      .where({ created_at: _.lte(effectiveBefore()) })
      .limit(MAX_RATINGS_SCAN)
      .get()
    docs = res.data
  } catch (err) {
    if (isCollectionMissing(err)) return {}
    throw err
  }

  if (!docs.length) return {}

  const penalized = await penalizedOpenids()

  const byZone = {}
  docs.forEach(function (doc) {
    if (!byZone[doc.zone_id]) byZone[doc.zone_id] = []
    byZone[doc.zone_id].push(doc)
  })

  const result = {}
  Object.keys(byZone).forEach(function (zoneId) {
    const group = byZone[zoneId]
    result[zoneId] = {
      avg: weightedAverage(trimExtremes(group), penalized),
      count: group.length
    }
  })
  return result
}

async function findRating(zoneId, openid) {
  const res = await db
    .collection(RATINGS)
    .where({ zone_id: zoneId, openid: openid })
    .limit(1)
    .get()
  return res.data[0] || null
}

/** 最近 48 小时内评过多少个区域 */
async function recentZoneCount(openid) {
  const res = await db
    .collection(RATINGS)
    .where({ openid: openid, created_at: _.gt(effectiveBefore()) })
    .count()
  return res.total || 0
}

// ---------- 各个 action ----------

async function listZones(openid) {
  const res = await db.collection(ZONES).limit(200).get()
  const overview = await summarize()

  // 我自己的评分单独查，它可能还在等待生效，不在 overview 里
  const mineMap = {}
  if (openid) {
    const mineRes = await db.collection(RATINGS).where({ openid: openid }).limit(200).get()
    mineRes.data.forEach(function (doc) {
      mineMap[doc.zone_id] = doc
    })
  }

  return res.data
    .filter(function (doc) {
      return doc.is_visible !== false
    })
    .filter(function (doc) {
      return doc.ne && doc.sw && doc.ne.latitude && doc.sw.latitude
    })
    .sort(function (a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0)
    })
    .map(function (doc) {
      return Object.assign(toClientZone(doc), {
        rating: overview[doc._id] || { avg: 0, count: 0 },
        mine: toClientMine(mineMap[doc._id])
      })
    })
}

const ASPECT_KEYS = ['hygiene', 'seating', 'crowding', 'management']

/** 只接受 0 / 1 / 2，其它一律当没选 */
function normalizeAspects(raw) {
  const input = raw || {}
  const out = {}
  ASPECT_KEYS.forEach(function (key) {
    const value = Number(input[key])
    if (value === 0 || value === 1 || value === 2) out[key] = value
  })
  return out
}

async function submitRating(openid, event) {
  const zoneId = String((event && event.zoneId) || '').trim()
  const stars = Number(event && event.stars)
  // 四个维度可以跟分数一起提交，也可以不提交（那就保持原样）
  const aspects = event && event.aspects ? normalizeAspects(event.aspects) : null

  if (!zoneId) return fail('INVALID_PARAM', '缺少区域 id')
  if (!isFinite(stars) || stars < 1 || stars > 5 || Math.floor(stars) !== stars) {
    return fail('INVALID_PARAM', '星级必须是 1 到 5 的整数')
  }

  // 区域必须真的存在，防止凭空写评分
  let zoneDoc = null
  try {
    const zoneRes = await db.collection(ZONES).doc(zoneId).get()
    zoneDoc = zoneRes && zoneRes.data
  } catch (err) {
    zoneDoc = null
  }
  if (!zoneDoc) return fail('NOT_FOUND', '这个区域不存在或已下架')

  const existing = await findRating(zoneId, openid)

  if (existing) {
    // 改分：不重置 48 小时，避免"先随便打一个、生效后再改成想要的"
    const data = { stars: stars, updated_at: new Date() }
    if (aspects) data.aspects = aspects

    await db
      .collection(RATINGS)
      .doc(existing._id)
      .update({ data: data })
  } else {
    if (!isAdmin(openid)) {
      const recent = await recentZoneCount(openid)
      if (recent >= SPAM_ZONE_LIMIT) {
        return fail('TOO_FREQUENT', '打分太频繁咯，稍后再试吧')
      }
    }

    await db.collection(RATINGS).add({
      data: {
        zone_id: zoneId,
        openid: openid,
        stars: stars,
        aspects: aspects || {},
        created_at: new Date(),
        updated_at: new Date()
      }
    })
  }

  const overview = await summarize()
  const mine = await findRating(zoneId, openid)

  return ok({
    rating: overview[zoneId] || { avg: 0, count: 0 },
    mine: toClientMine(mine)
  })
}

async function setAspects(openid, event) {
  const zoneId = String((event && event.zoneId) || '').trim()
  if (!zoneId) return fail('INVALID_PARAM', '缺少区域 id')

  const existing = await findRating(zoneId, openid)
  if (!existing) return fail('NOT_FOUND', '先给这个夜市打分，才能填写这几个维度')

  const aspects = normalizeAspects(event && event.aspects)
  await db
    .collection(RATINGS)
    .doc(existing._id)
    .update({ data: { aspects: aspects, updated_at: new Date() } })

  return ok({ aspects: aspects })
}

/** 「我的打分」列表：我评过的区域 + 我的分数和四个维度 */
async function myRatings(openid) {
  const res = await db.collection(RATINGS).where({ openid: openid }).limit(200).get()
  const mine = res.data
  if (!mine.length) return []

  const zoneIds = mine.map(function (doc) {
    return doc.zone_id
  })

  const zoneRes = await db
    .collection(ZONES)
    .where({ _id: _.in(zoneIds) })
    .limit(200)
    .get()

  const zoneMap = {}
  zoneRes.data.forEach(function (doc) {
    zoneMap[doc._id] = doc
  })

  return mine
    .filter(function (doc) {
      return !!zoneMap[doc.zone_id]
    })
    .sort(function (a, b) {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
    .map(function (doc) {
      const zone = zoneMap[doc.zone_id]
      return {
        zoneId: doc.zone_id,
        name_zh: zone.name_zh || '',
        name_en: zone.name_en || '',
        stars: doc.stars,
        pending: isPending(doc),
        aspects: doc.aspects || {},
        createdAt: doc.created_at
      }
    })
}

exports.main = async (event) => {
  const action = (event && event.action) || ''
  const openid = cloud.getWXContext().OPENID || ''

  try {
    switch (action) {
      case 'list':
        return ok(await listZones(openid))
      case 'rate':
        if (!openid) return fail('NO_OPENID', '没有拿到用户身份')
        return await submitRating(openid, event)
      case 'setAspects':
        if (!openid) return fail('NO_OPENID', '没有拿到用户身份')
        return await setAspects(openid, event)
      case 'mine':
        if (!openid) return fail('NO_OPENID', '没有拿到用户身份')
        return ok(await myRatings(openid))
      default:
        return fail('INVALID_PARAM', '未知操作：' + action)
    }
  } catch (err) {
    if (isCollectionMissing(err)) return ok([])
    console.error('[zone] action=' + action + ' 执行失败', err)
    return fail('INTERNAL', '服务异常，请稍后重试')
  }
}
