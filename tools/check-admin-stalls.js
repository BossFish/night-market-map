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
  price_range: '10-30 元',
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
      named.price_range === '10-30 元' &&
      named.zone_id === 'z1' &&
      named.is_deleted === false
  ])

  const list = await action('stalls.list', { zoneId: 'z1' })
  checks.push(['能按区域列出摊位', list.ok === true && list.data.length === 1])

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
  checks.push(['删除是软删除：记录还在，只是打了标记', store.stalls.length === 1 && store.stalls[0].is_deleted === true])

  const afterDelete = await action('stalls.list', { zoneId: 'z1' })
  checks.push(['软删除之后列表里看不到了', afterDelete.data.length === 0])

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
