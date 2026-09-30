/**
 * 开发用小工具：验证 admin 云函数里的摊位增删改查。
 *
 * 重点看两件事：参数校验拦不拦得住，以及删除是不是真的只打标记（软删除）。
 *
 * 运行：node tools/check-admin-stalls.js
 */
const Module = require('module')
const path = require('path')

const store = { zones: [], stalls: [] }
let seq = 0

function clone(value) {
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

function matches(doc, condition) {
  return Object.keys(condition).every(function (key) {
    return doc[key] === condition[key]
  })
}

const fakeSdk = {
  init: function () {},
  DYNAMIC_CURRENT_ENV: 'fake-env',
  database: function () {
    return {
      collection: function (name) {
        const rows = function () {
          return store[name] || (store[name] = [])
        }

        return {
          where: function (condition) {
            const chain = {
              limit: function () {
                return chain
              },
              get: async function () {
                return {
                  data: rows().filter(function (row) {
                    return matches(row, condition)
                  })
                }
              }
            }
            return chain
          },
          limit: function () {
            return {
              get: async function () {
                return { data: rows().slice() }
              }
            }
          },
          add: async function (options) {
            seq += 1
            const id = 'id' + seq
            rows().push(Object.assign({ _id: id }, clone(options.data)))
            return { _id: id }
          },
          doc: function (id) {
            return {
              update: async function (options) {
                const target = rows().filter(function (row) {
                  return row._id === id
                })[0]
                if (target) Object.assign(target, clone(options.data))
                return {}
              }
            }
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

process.env.ADMIN_KEY = 'test-key'
const admin = require(path.join(__dirname, '..', 'cloudfunctions', 'admin', 'index.js'))

const validStall = {
  name_zh: '老马家烤肉',
  name_en: 'Lao Ma BBQ',
  price_items: [
    {
      kind: 'single',
      name_zh: '羊肉串',
      name_en: 'Lamb skewer',
      note_zh: '现穿现烤',
      options: [{ name_zh: '原味', price: 5 }]
    },
    { kind: 'addon', name_zh: '加馕', name_en: '', price: 3 }
  ],
  sort_order: 1,
  ne: { latitude: 34.2655, longitude: 108.9405 },
  sw: { latitude: 34.2652, longitude: 108.9402 }
}

async function run() {
  const checks = []
  const action = function (name, payload) {
    return admin.main(Object.assign({ action: name, key: 'test-key' }, payload || {}))
  }

  const created = await action('stalls.create', Object.assign({ zoneId: 'z1' }, validStall))
  checks.push(['能新建摊位', created.ok === true && !!created.data._id])

  const stallId = created.data._id

  const named = store.stalls.filter(function (s) {
    return s._id === stallId
  })[0]
  checks.push([
    '存下来的字段对得上',
    named.name_zh === '老马家烤肉' &&
      named.price_items.length === 2 &&
      named.price_items[0].price === undefined &&
      named.price_items[0].options[0].price === 5 &&
      named.zone_id === 'z1' &&
      named.is_deleted === false
  ])

  const emptyRow = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '只有空行的摊位',
      price_items: [{ name_zh: '', name_en: '', price: '' }]
    })
  )
  checks.push([
    '价目表里整行空着的会被跳过',
    emptyRow.ok === true && store.stalls[1].price_items.length === 0
  ])

  // 三种模板
  const kinds = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '三种模板',
      price_items: [
        {
          kind: 'single',
          name_zh: '凉皮',
          price: 8,
          note_zh: '手工现蒸',
          options: [{ name_zh: '加肉', price: 15 }, { name_zh: '加蛋', price: 10 }]
        },
        {
          kind: 'series',
          name_zh: '蛋炒系列',
          price: 12,
          options: [{ name_zh: '炒饼' }, { name_zh: '炒米' }]
        },
        { kind: 'addon', name_zh: '加香肠', price: 3 }
      ]
    })
  )
  const saved = store.stalls[store.stalls.length - 1]
  checks.push([
    '三种模板都能存下来：单品的搭配各自带价',
    kinds.ok === true &&
      saved.price_items[0].kind === 'single' &&
      saved.price_items[0].options.length === 2 &&
      saved.price_items[0].options[0].price === 15
  ])
  checks.push([
    '系列：统一价 + 不带价格的搭配',
    saved.price_items[1].kind === 'series' &&
      saved.price_items[1].price === 12 &&
      saved.price_items[1].options[1].name_zh === '炒米' &&
      saved.price_items[1].options[1].price === undefined
  ])
  checks.push([
    '增项：只留名称和价格，不生成搭配、也没有小字',
    saved.price_items[2].kind === 'addon' &&
      saved.price_items[2].price === 3 &&
      saved.price_items[2].options === undefined &&
      saved.price_items[2].note_zh === undefined
  ])
  checks.push(['小字能存下来', saved.price_items[0].note_zh === '手工现蒸'])

  const singleNoPrice = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '单品不带价',
      price_items: [{ kind: 'single', name_zh: '凉皮', price: '' }]
    })
  )
  checks.push(['单品可以不填价格（只列搭配价格也行）', singleNoPrice.ok === true])

  const seriesNoPrice = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '系列不带价',
      price_items: [{ kind: 'series', name_zh: '蛋炒系列', price: '', options: [{ name_zh: '炒饼' }] }]
    })
  )
  checks.push(['系列不填统一价会被拦下', seriesNoPrice.ok === false && seriesNoPrice.code === 'INVALID_PARAM'])

  const addonNoPrice = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '增项不带价',
      price_items: [{ kind: 'addon', name_zh: '加香肠', price: '' }]
    })
  )
  checks.push(['增项不填价格会被拦下', addonNoPrice.ok === false && addonNoPrice.code === 'INVALID_PARAM'])

  const optionNoPrice = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      name_zh: '搭配不带价',
      price_items: [{ kind: 'single', name_zh: '凉皮', price: 8, options: [{ name_zh: '加肉' }] }]
    })
  )
  checks.push([
    '单品的搭配没填价格会被拦下',
    optionNoPrice.ok === false && optionNoPrice.code === 'INVALID_PARAM'
  ])

  const badPrice = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      price_items: [
        { kind: 'series', name_zh: '蛋炒系列', price: '免费', options: [{ name_zh: '炒饼' }] }
      ]
    })
  )
  checks.push(['价格不是数字会被拦下', badPrice.ok === false && badPrice.code === 'INVALID_PARAM'])

  const list = await action('stalls.list', { zoneId: 'z1' })
  checks.push([
    '能按区域列出摊位',
    list.ok === true &&
      list.data.filter(function (s) {
        return s._id === stallId
      }).length === 1
  ])

  const otherZone = await action('stalls.list', { zoneId: 'z2' })
  checks.push(['别的区域看不到它', otherZone.data.length === 0])

  const noName = await action('stalls.create', Object.assign({ zoneId: 'z1' }, validStall, { name_zh: '   ' }))
  checks.push(['不给名字不让建', noName.ok === false && noName.code === 'INVALID_PARAM'])

  const reversed = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, {
      ne: { latitude: 34.2652, longitude: 108.9405 },
      sw: { latitude: 34.2655, longitude: 108.9402 }
    })
  )
  checks.push(['东北角和西南角填反了不让建', reversed.ok === false && reversed.code === 'INVALID_PARAM'])

  const badNumber = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, { ne: { latitude: 'x', longitude: 108.9405 } })
  )
  checks.push(['坐标不是数字不让建', badNumber.ok === false && badNumber.code === 'INVALID_PARAM'])

  const outOfRange = await action(
    'stalls.create',
    Object.assign({ zoneId: 'z1' }, validStall, { ne: { latitude: 99, longitude: 108.9405 } })
  )
  checks.push(['坐标超出合理范围不让建', outOfRange.ok === false && outOfRange.code === 'INVALID_PARAM'])

  const noZone = await action('stalls.create', validStall)
  checks.push(['没指定区域不让建', noZone.ok === false && noZone.code === 'INVALID_PARAM'])

  const updated = await action('stalls.update', Object.assign({ _id: stallId }, validStall, { name_zh: '改名了' }))
  checks.push(['能改摊位', updated.ok === true && store.stalls[0].name_zh === '改名了'])

  const removed = await action('stalls.delete', { _id: stallId })
  checks.push(['删除返回成功', removed.ok === true])
  checks.push([
    '删除是软删除：记录还在，只是打了标记',
    store.stalls.filter(function (s) {
      return s._id === stallId
    })[0].is_deleted === true
  ])

  const afterDelete = await action('stalls.list', { zoneId: 'z1' })
  checks.push([
    '软删除之后列表里看不到了',
    afterDelete.data.filter(function (s) {
      return s._id === stallId
    }).length === 0
  ])

  const badUpdate = await action('stalls.update', Object.assign({}, validStall, { name_zh: '' }))
  checks.push(['改的时候不给名字也被拦', badUpdate.ok === false && badUpdate.code === 'INVALID_PARAM'])

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
