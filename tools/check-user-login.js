/**
 * 开发用小工具：验证 user 云函数的登录逻辑。
 *
 * 云函数跑在云端、依赖微信上下文，本地没法直接调，
 * 所以这里把 wx-server-sdk 换成一个内存版的假数据库，
 * 只验证"逻辑对不对"，不验证云端连通性。
 *
 * 运行：node tools/check-user-login.js
 */
const Module = require('module')
const path = require('path')

// ---------- 假的数据库 ----------

let users = []
let idSeq = 0
let currentOpenid = 'openid-a'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function matches(doc, condition) {
  return Object.keys(condition).every(function (key) {
    return doc[key] === condition[key]
  })
}

const fakeSdk = {
  init: function () {},
  DYNAMIC_CURRENT_ENV: 'fake-env',
  getWXContext: function () {
    return { OPENID: currentOpenid }
  },
  database: function () {
    return {
      collection: function () {
        return {
          where: function (condition) {
            const chain = {
              limit: function () {
                return chain
              },
              get: async function () {
                return { data: users.filter(function (u) { return matches(u, condition) }).slice(0, 1) }
              }
            }
            return chain
          },
          add: async function (options) {
            idSeq += 1
            const id = 'u' + idSeq
            users.push(Object.assign({ _id: id }, clone(options.data)))
            return { _id: id }
          },
          doc: function (id) {
            return {
              update: async function (options) {
                const target = users.filter(function (u) { return u._id === id })[0]
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

const userFn = require(path.join(__dirname, '..', 'cloudfunctions', 'user', 'index.js'))

async function run() {
  const checks = []

  const r1 = await userFn.main({ action: 'login' })
  checks.push([
    '第一次登录会创建用户，并返回一个匿名昵称',
    r1.ok === true && r1.data.isNew === true && /^夜市迷\d{4}$/.test(r1.data.displayNameZh) && users.length === 1
  ])

  checks.push([
    '返回值里不含 openid',
    JSON.stringify(r1.data).indexOf('openid-a') === -1
  ])

  const firstNames = { zh: r1.data.displayNameZh, en: r1.data.displayNameEn }

  const r2 = await userFn.main({ action: 'login' })
  checks.push([
    '第二次登录不再新建记录',
    r2.ok === true && r2.data.isNew === false && users.length === 1
  ])

  checks.push([
    '第二次登录昵称保持不变',
    r2.data.displayNameZh === firstNames.zh && r2.data.displayNameEn === firstNames.en
  ])

  checks.push([
    '登录次数被累加',
    users[0].login_count === 2
  ])

  currentOpenid = 'openid-b'
  const r3 = await userFn.main({ action: 'login' })
  checks.push([
    '换一个用户会各自建一条记录',
    r3.ok === true && r3.data.isNew === true && users.length === 2
  ])

  const r4 = await userFn.main({ action: 'me' })
  checks.push([
    'me 能读到自己的资料',
    r4.ok === true && r4.data.displayNameZh === r3.data.displayNameZh
  ])

  currentOpenid = ''
  const r5 = await userFn.main({ action: 'login' })
  checks.push(['拿不到 openid 时明确报错', r5.ok === false && r5.code === 'NO_OPENID'])

  currentOpenid = 'openid-a'
  const r6 = await userFn.main({ action: 'not-an-action' })
  checks.push(['未知 action 被拒绝', r6.ok === false && r6.code === 'INVALID_PARAM'])

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
