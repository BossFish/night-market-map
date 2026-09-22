/**
 * 云函数：admin
 *
 * 管理后台专用。所有操作都要带密钥，密钥存在云函数的环境变量 ADMIN_KEY 里，
 * 代码和仓库里都不会出现明文。
 *
 * 这个函数既能被小程序用 callFunction 调用，也能被「HTTP 访问服务」
 * 映射成网址给网页后台用。两种调用方式下返回值都是同一个约定格式：
 *   成功 { ok: true, data }
 *   失败 { ok: false, code, msg }
 * 所以函数内部不需要关心自己是被谁调用的。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTION = 'zones'

// 经纬度的合理范围，放得很宽（覆盖整个中国），以后往别的城市扩展也不用改。
// 用途是挡住明显填错的坐标。
const LAT_RANGE = { min: 3, max: 54 }
const LNG_RANGE = { min: 73, max: 136 }

/**
 * 这个函数有两种被调用的方式，事件结构完全不同：
 *
 *   1. 小程序 callFunction 调用：event 就是 { action, key, ... }
 *   2. 被「HTTP 访问服务」映射成网址后调用：event 是 HTTP 那一套
 *      { httpMethod, headers, body, isBase64Encoded, ... }，
 *      我们发的 JSON 在 body 里，而且是一段字符串。
 *
 * 这里统一成第 1 种形状，后面的逻辑就不用关心自己是怎么被调用的了。
 * 这个坑很隐蔽：不解析 body 的话，event.key 永远是 undefined，
 * 表现为"密钥怎么输都不对"。
 */
function parseEvent(rawEvent) {
  const event = rawEvent || {}

  const looksLikeHttp = typeof event.httpMethod === 'string' || typeof event.body === 'string'
  if (!looksLikeHttp) return event

  let body = event.body || ''
  if (event.isBase64Encoded) {
    try {
      body = Buffer.from(body, 'base64').toString('utf8')
    } catch (err) {
      return {}
    }
  }

  try {
    return JSON.parse(body || '{}')
  } catch (err) {
    return {}
  }
}

function ok(data) {
  return { ok: true, data: data }
}

function fail(code, msg) {
  return { ok: false, code: code, msg: msg }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

/**
 * 校验密钥。返回 null 表示通过，返回错误对象表示不通过。
 */
async function rejectIfBadKey(event) {
  const expected = process.env.ADMIN_KEY
  if (!expected) {
    return fail(
      'CONFIG_MISSING',
      '云函数还没配置 ADMIN_KEY 环境变量。去云开发控制台，找到 admin 函数，在配置里加一个环境变量。'
    )
  }

  const provided = (event && event.key) || ''
  if (!provided) {
    // 走到这里通常是请求体没被正确解析，而不是真的忘了填密钥。
    // 单独给一句话，省得以后又对着"密钥不正确"干瞪眼。
    return fail('NO_KEY', '请求里没有带密钥。如果是通过 HTTP 访问服务调用，多半是请求体没解析出来。')
  }
  if (provided !== expected) {
    // 故意拖慢一点，给暴力猜密钥增加成本
    await sleep(300)
    return fail('FORBIDDEN', '密钥不正确')
  }

  return null
}

/**
 * 校验并整理前端传来的区域数据。
 * 返回 { error: '...' } 或 { doc: {...} }。
 */
function normalizeZoneInput(payload) {
  const p = payload || {}

  const nameZh = String(p.name_zh || '').trim()
  if (!nameZh) return { error: '中文名称不能为空' }

  const ne = p.ne || {}
  const sw = p.sw || {}

  const neLat = Number(ne.latitude)
  const neLng = Number(ne.longitude)
  const swLat = Number(sw.latitude)
  const swLng = Number(sw.longitude)

  const coords = [
    { label: '东北角纬度', value: neLat, range: LAT_RANGE },
    { label: '东北角经度', value: neLng, range: LNG_RANGE },
    { label: '西南角纬度', value: swLat, range: LAT_RANGE },
    { label: '西南角经度', value: swLng, range: LNG_RANGE }
  ]
  for (let i = 0; i < coords.length; i++) {
    const item = coords[i]
    if (!isFinite(item.value)) return { error: item.label + '不是有效数字' }
    if (item.value < item.range.min || item.value > item.range.max) {
      return { error: item.label + '超出合理范围（' + item.range.min + ' ~ ' + item.range.max + '）' }
    }
  }

  // 这两条最值得拦：填反了矩形会翻转成跨半球的怪东西
  if (neLat <= swLat) {
    return { error: '东北角的纬度必须大于西南角的纬度（纬度越大越靠北）' }
  }
  if (neLng <= swLng) {
    return { error: '东北角的经度必须大于西南角的经度（经度越大越靠东）' }
  }

  return {
    doc: {
      name_zh: nameZh,
      name_en: String(p.name_en || '').trim(),
      business_hours: String(p.business_hours || '').trim(),
      ne: { latitude: neLat, longitude: neLng },
      sw: { latitude: swLat, longitude: swLng },
      sort_order: Number(p.sort_order) || 0,
      is_visible: p.is_visible !== false
    }
  }
}

/** 管理端要看到全部区域，包括已经下架的 */
async function listZones() {
  const res = await db.collection(COLLECTION).limit(200).get()
  const zones = res.data.sort(function (a, b) {
    return (a.sort_order || 0) - (b.sort_order || 0)
  })
  return ok(zones)
}

async function createZone(payload) {
  const checked = normalizeZoneInput(payload)
  if (checked.error) return fail('INVALID_PARAM', checked.error)

  const doc = Object.assign({}, checked.doc, {
    created_at: new Date(),
    updated_at: new Date()
  })
  const res = await db.collection(COLLECTION).add({ data: doc })
  return ok({ _id: res._id })
}

async function updateZone(payload) {
  const p = payload || {}
  const id = String(p._id || '').trim()
  if (!id) return fail('INVALID_PARAM', '缺少 _id')

  const checked = normalizeZoneInput(p)
  if (checked.error) return fail('INVALID_PARAM', checked.error)

  const doc = Object.assign({}, checked.doc, { updated_at: new Date() })
  await db.collection(COLLECTION).doc(id).update({ data: doc })
  return ok({ _id: id })
}

async function deleteZone(payload) {
  const id = String((payload && payload._id) || '').trim()
  if (!id) return fail('INVALID_PARAM', '缺少 _id')

  await db.collection(COLLECTION).doc(id).remove()
  return ok({ _id: id })
}

/** 集合还不存在时统一按"没有数据"处理，别甩英文异常给用户 */
function isCollectionMissing(err) {
  return !!(err && (err.errCode === -502005 || /collection not exists/i.test(err.errMsg || '')))
}

// ---------- 示例数据 ----------

/**
 * 用来把「推荐度」的各种状态一次性展示出来的示例夜市。
 *
 * stars 里写的是"每个星级各有多少人投"，例如 { 5: 6, 4: 2 } 就是
 * 6 个人投 5 分、2 个人投 4 分。
 * 实际平均分还要经过"去掉一个最高最低"，所以下面的注释写的是最终结果。
 *
 * 所有示例数据都带 is_demo 标记，一键就能全部清掉，不会碰到你自己的数据。
 */
const DEMO_ZONES = [
  {
    name_zh: '永兴坊',
    name_en: 'Yongxingfang',
    business_hours: '10:00 - 22:00',
    ne: { latitude: 34.2695, longitude: 108.961 },
    sw: { latitude: 34.2665, longitude: 108.9575 },
    stars: {} // 没人评过 → 「请为这个夜市打分」
  },
  {
    name_zh: '小南门夜市',
    name_en: 'Xiaonanmen Night Market',
    business_hours: '18:00 - 次日 02:00',
    ne: { latitude: 34.253, longitude: 108.9385 },
    sw: { latitude: 34.2495, longitude: 108.9345 },
    stars: { 4: 2, 5: 1 } // 3 人 → 去掉极值后 4.0 → 灰色「大多好评」
  },
  {
    name_zh: '龙首村夜市',
    name_en: 'Longshoucun Night Market',
    business_hours: '17:00 - 次日 01:00',
    ne: { latitude: 34.2915, longitude: 108.952 },
    sw: { latitude: 34.288, longitude: 108.9475 },
    stars: { 5: 9, 4: 2 } // 11 人 → 4.9 → 「好评如潮」（过了 10 人门槛，正常颜色）
  },
  {
    name_zh: '纺织城夜市',
    name_en: 'Fangzhicheng Night Market',
    business_hours: '18:00 - 次日 01:00',
    ne: { latitude: 34.262, longitude: 109.0425 },
    sw: { latitude: 34.2585, longitude: 109.038 },
    stars: { 1: 1, 2: 2, 3: 4, 4: 5, 5: 3 } // 15 人 → 3.5 → 「褒贬不一」
  },
  {
    name_zh: '电子城夜市',
    name_en: 'Dianzicheng Night Market',
    business_hours: '18:00 - 次日 02:00',
    ne: { latitude: 34.222, longitude: 108.9225 },
    sw: { latitude: 34.2185, longitude: 108.9185 },
    stars: { 1: 2, 2: 6, 3: 7, 4: 3, 5: 2 } // 20 人 → 2.8 → 「差强人意」
  },
  {
    name_zh: '大唐不夜城',
    name_en: 'Datang Everlasting City',
    business_hours: '19:00 - 次日 03:00',
    ne: { latitude: 34.2205, longitude: 108.966 },
    sw: { latitude: 34.2165, longitude: 108.9615 },
    stars: { 1: 7, 2: 3, 3: 1, 5: 1 } // 12 人 → 1.5 → 「缺乏管理」
  }
]

function expandStars(spec) {
  const out = []
  Object.keys(spec || {}).forEach(function (star) {
    const count = spec[star]
    for (let i = 0; i < count; i++) out.push(Number(star))
  })
  return out
}

async function removeWhere(collection, condition) {
  try {
    const res = await db.collection(collection).where(condition).remove()
    return (res.stats && res.stats.removed) || 0
  } catch (err) {
    if (isCollectionMissing(err)) return 0
    throw err
  }
}

/** 清掉所有带 is_demo 标记的数据，不动你自己的区域和评分 */
async function clearDemo() {
  const zonesRemoved = await removeWhere('zones', { is_demo: true })
  const ratingsRemoved = await removeWhere('zone_ratings', { is_demo: true })
  return ok({ zones: zonesRemoved, ratings: ratingsRemoved })
}

async function seedDemo() {
  await clearDemo()

  // 五天前，确保这些评分都已经过了 48 小时生效期
  const createdAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
  let ratingCount = 0

  for (let index = 0; index < DEMO_ZONES.length; index++) {
    const demo = DEMO_ZONES[index]

    const zoneRes = await db.collection('zones').add({
      data: {
        name_zh: demo.name_zh,
        name_en: demo.name_en,
        business_hours: demo.business_hours,
        ne: demo.ne,
        sw: demo.sw,
        sort_order: 100 + index,
        is_visible: true,
        is_demo: true,
        created_at: createdAt,
        updated_at: createdAt
      }
    })

    const stars = expandStars(demo.stars)
    ratingCount += stars.length

    // 并发写入，别一条一条串行等
    await Promise.all(
      stars.map(function (value, starIndex) {
        return db.collection('zone_ratings').add({
          data: {
            zone_id: zoneRes._id,
            openid: 'demo-' + index + '-' + starIndex,
            stars: value,
            aspects: {},
            is_demo: true,
            created_at: createdAt,
            updated_at: createdAt
          }
        })
      })
    )
  }

  return ok({ zones: DEMO_ZONES.length, ratings: ratingCount })
}

exports.main = async (rawEvent) => {
  const event = parseEvent(rawEvent)
  const action = (event && event.action) || ''

  const badKey = await rejectIfBadKey(event)
  if (badKey) return badKey

  try {
    switch (action) {
      // ping 用来让后台在登录时同时验证密钥和连通性
      case 'ping':
        return ok({ pong: true, time: new Date().toISOString() })
      case 'zones.list':
        return await listZones()
      case 'zones.create':
        return await createZone(event)
      case 'zones.update':
        return await updateZone(event)
      case 'zones.delete':
        return await deleteZone(event)
      case 'demo.seed':
        return await seedDemo()
      case 'demo.clear':
        return await clearDemo()
      default:
        return fail('INVALID_PARAM', '未知操作：' + action)
    }
  } catch (err) {
    if (isCollectionMissing(err)) return ok([])
    console.error('[admin] action=' + action + ' 执行失败', err)
    return fail('INTERNAL', '服务异常，请稍后重试')
  }
}
