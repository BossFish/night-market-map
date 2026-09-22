/**
 * 云函数：user
 *
 * 负责用户身份。目前只有两个动作：
 *   login —— 第一次调用时在 users 里建一条记录，之后每次只是更新「最后活跃时间」
 *   me    —— 只读，取自己的资料
 *
 * 关于身份本身：微信云开发里，云函数通过 cloud.getWXContext() 就能拿到
 * 调用者的 openid，**不需要用户授权任何东西**，也不会有授权弹窗。
 * 所以这里的「登录」对用户是完全无感的，它只是把这个人记下来而已。
 *
 * 安全约定：openid 只在云端使用，永远不返回给前端。
 * 前端不需要知道自己的 openid——需要身份时，云函数自己从上下文里取。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const COLLECTION = 'users'

function ok(data) {
  return { ok: true, data: data }
}

function fail(code, msg) {
  return { ok: false, code: code, msg: msg }
}

function randomDigits(count) {
  let text = ''
  for (let i = 0; i < count; i++) {
    text += Math.floor(Math.random() * 10)
  }
  return text
}

/**
 * 给用户生成一个匿名昵称。
 *
 * 因为不索取头像昵称，用户得有个人人看得见的名字挂在留言边上。
 * 中英各生成一份，中英切换时用对应那份。
 */
function makeDisplayNames() {
  const digits = randomDigits(4)
  return {
    zh: '夜市迷' + digits,
    en: 'Night Owl ' + digits
  }
}

function isCollectionMissing(err) {
  return !!(err && (err.errCode === -502005 || /collection not exists/i.test(err.errMsg || '')))
}

/** 把这个用户对外可见的信息整理出来。注意这里不含 openid */
function toClientProfile(doc, isNew) {
  return {
    isNew: !!isNew,
    displayNameZh: doc.display_name_zh || '',
    displayNameEn: doc.display_name_en || '',
    createdAt: doc.created_at || null
  }
}

async function findUser(openid) {
  const res = await db
    .collection(COLLECTION)
    .where({ openid: openid })
    .limit(1)
    .get()
  return res.data[0] || null
}

async function login(openid) {
  const existing = await findUser(openid)

  if (existing) {
    await db
      .collection(COLLECTION)
      .doc(existing._id)
      .update({
        data: {
          last_seen_at: new Date(),
          login_count: (existing.login_count || 0) + 1
        }
      })
    return ok(toClientProfile(existing, false))
  }

  const names = makeDisplayNames()
  const doc = {
    openid: openid,
    display_name_zh: names.zh,
    display_name_en: names.en,
    created_at: new Date(),
    last_seen_at: new Date(),
    login_count: 1
  }

  await db.collection(COLLECTION).add({ data: doc })
  return ok(toClientProfile(doc, true))
}

async function me(openid) {
  const existing = await findUser(openid)
  if (!existing) return fail('NOT_FOUND', '还没有你的记录')
  return ok(toClientProfile(existing, false))
}

exports.main = async (event) => {
  const action = (event && event.action) || ''
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  if (!openid) {
    return fail('NO_OPENID', '没有拿到用户身份。这个函数只能由小程序调用。')
  }

  try {
    switch (action) {
      case 'login':
        return await login(openid)
      case 'me':
        return await me(openid)
      default:
        return fail('INVALID_PARAM', '未知操作：' + action)
    }
  } catch (err) {
    if (isCollectionMissing(err)) {
      return fail('COLLECTION_MISSING', 'users 集合还没建。去云开发控制台的数据库里新建一个叫 users 的集合。')
    }
    console.error('[user] action=' + action + ' 执行失败', err)
    return fail('INTERNAL', '服务异常，请稍后重试')
  }
}
