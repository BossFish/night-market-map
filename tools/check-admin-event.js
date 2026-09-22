/**
 * 开发用小工具：验证 admin 云函数能同时处理两种调用方式。
 *
 * 背景：云函数被小程序 callFunction 调用、和被「HTTP 访问服务」当网址调用时，
 * 收到的事件结构完全不同。前者是 { action, key }，后者是
 * { httpMethod, body: "...", isBase64Encoded }，数据藏在字符串里。
 * 不解析 body 的话，密钥永远读不到，表现成"密钥怎么输都不对"。
 *
 * 云函数跑在云端，本地没法直接调，所以这里把 wx-server-sdk 换成假的，
 * 只验证"事件解析 + 参数校验"这一层。
 *
 * 运行：node tools/check-admin-event.js
 */
const Module = require('module')
const path = require('path')

const fakeSdk = {
  init: function () {},
  DYNAMIC_CURRENT_ENV: 'fake-env',
  database: function () {
    return {
      collection: function () {
        return {
          limit: function () {
            return this
          },
          get: async function () {
            return { data: [] }
          },
          add: async function () {
            return { _id: 'fake-id' }
          },
          doc: function () {
            return {
              update: async function () {
                return {}
              },
              remove: async function () {
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

const baseZone = {
  name_zh: '测试区域',
  name_en: 'Test Zone',
  business_hours: '18:00 - 02:00',
  sort_order: 1,
  is_visible: true,
  ne: { latitude: 34.27, longitude: 108.94 },
  sw: { latitude: 34.26, longitude: 108.93 }
}

async function run() {
  const checks = []

  const r1 = await admin.main({ action: 'ping', key: 'test-key' })
  checks.push(['callFunction 事件形状 + 正确密钥', r1.ok === true])

  const r2 = await admin.main({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ping', key: 'test-key' })
  })
  checks.push(['HTTP 事件形状 + 正确密钥', r2.ok === true])

  const r3 = await admin.main({
    httpMethod: 'POST',
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ action: 'ping', key: 'test-key' })).toString('base64')
  })
  checks.push(['HTTP 事件 + base64 编码的 body', r3.ok === true])

  const r4 = await admin.main({ action: 'ping', key: 'wrong' })
  checks.push(['错误密钥被拒绝', r4.ok === false && r4.code === 'FORBIDDEN'])

  const r5 = await admin.main({ action: 'ping' })
  checks.push(['完全没带密钥时给出可诊断的提示', r5.ok === false && r5.code === 'NO_KEY'])

  const r6 = await admin.main({ action: 'not-an-action', key: 'test-key' })
  checks.push(['未知 action 被拒绝', r6.ok === false && r6.code === 'INVALID_PARAM'])

  const r7 = await admin.main(
    Object.assign({ action: 'zones.create', key: 'test-key' }, baseZone, {
      ne: { latitude: 34.26, longitude: 108.94 },
      sw: { latitude: 34.27, longitude: 108.93 }
    })
  )
  checks.push(['东北角与西南角填反被拦住', r7.ok === false && r7.code === 'INVALID_PARAM'])

  const r8 = await admin.main(
    Object.assign({ action: 'zones.create', key: 'test-key' }, baseZone, { name_zh: '   ' })
  )
  checks.push(['中文名称为空被拦住', r8.ok === false && r8.code === 'INVALID_PARAM'])

  const r9 = await admin.main(Object.assign({ action: 'zones.create', key: 'test-key' }, baseZone))
  checks.push(['合法数据能通过校验', r9.ok === true])

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
