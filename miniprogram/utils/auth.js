/**
 * 身份管理。
 *
 * 对业务代码来说只需要记住一件事：**要用身份的地方，await ensureLogin() 就行。**
 *
 * 为什么不需要弹授权框：微信云开发里，云函数从调用上下文直接拿 openid，
 * 平台已经知道是谁在调用，不需要用户点任何东西。
 * 所以我们需要的"登录"只是一次云函数调用，对用户完全无感。
 *
 * 两条设计约束：
 *   1. 不主动登录。只有真正需要身份的操作才会触发，浏览永远不需要。
 *   2. 同一时刻只发一次登录请求。连续点两下不会建出两条用户记录。
 */
const cloud = require('./cloud')

let profile = null // 登录成功后的资料缓存，进程内有效
let pending = null // 正在进行的登录请求，用来去重

function getProfile() {
  return profile
}

function isLoggedIn() {
  return !!profile
}

/**
 * 确保已经拿到身份，返回用户资料。
 * 已经登录时直接返回缓存，不会重复请求云端。
 */
function ensureLogin() {
  if (profile) return Promise.resolve(profile)
  if (pending) return pending

  pending = cloud
    .callCloud('user', 'login')
    .then(function (res) {
      pending = null
      profile = res
      return profile
    })
    .catch(function (err) {
      pending = null
      throw err
    })

  return pending
}

/** 退出登录状态（只是清掉本地缓存，不涉及任何账号概念） */
function clear() {
  profile = null
  pending = null
}

module.exports = {
  ensureLogin: ensureLogin,
  getProfile: getProfile,
  isLoggedIn: isLoggedIn,
  clear: clear
}
