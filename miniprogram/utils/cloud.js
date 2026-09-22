/**
 * 云函数调用的统一入口。
 *
 * 约定：云函数一律返回
 *   成功 { ok: true, data: ... }
 *   失败 { ok: false, code: 'XXX', msg: '人能看懂的错误信息' }
 *
 * 这里把失败统一转成 reject 出去的 Error 对象，并挂上 code / msg，
 * 于是业务代码只要 .then(...).catch(err => ...) 就行，
 * 不用每次都去判断 ok 字段。
 */

function makeError(code, msg) {
  const err = new Error(msg)
  err.code = code
  err.msg = msg
  return err
}

function callCloud(name, action, data) {
  return wx.cloud
    .callFunction({
      name: name,
      data: Object.assign({ action: action }, data || {})
    })
    .then(function (res) {
      const result = res && res.result

      if (!result || typeof result.ok !== 'boolean') {
        throw makeError('INTERNAL', '云函数返回格式异常')
      }
      if (!result.ok) {
        throw makeError(result.code || 'INTERNAL', result.msg || '操作失败')
      }
      return result.data
    })
    .catch(function (err) {
      // 已经是我们的错误对象就直接往外抛，否则说明是网络或云函数本身崩了
      if (err && err.code && err.msg) throw err
      throw makeError('INTERNAL', (err && err.errMsg) || '网络异常，请稍后重试')
    })
}

module.exports = { callCloud }
