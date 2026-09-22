const zh = require('./zh')
const en = require('./en')

const DICTS = { zh, en }
const FALLBACK_LANG = 'zh'

let currentLang = FALLBACK_LANG

function setLang(lang) {
  if (DICTS[lang]) currentLang = lang
}

function getLang() {
  return currentLang
}

/**
 * 当前语言的文案快照。
 * WXML 里不能调用函数，所以页面 onLoad 时取一份放进 data，
 * 模板里直接写 {{T.someKey}}。
 *
 * 合并顺序是「中文打底 + 当前语言覆盖」，
 * 于是英文缺哪条就自动回退显示中文，而不是显示空白——
 * 这正是需求里要的行为。
 */
function dict() {
  return Object.assign({}, zh, DICTS[currentLang] || {})
}

/**
 * 取单条文案，支持 {name} 这种占位符。
 * 彻底找不到时返回 key 本身，让遗漏直接暴露在界面上。
 */
function t(key, params) {
  let text = dict()[key]
  if (text === undefined) return key
  if (params) {
    Object.keys(params).forEach(function (k) {
      text = text.split('{' + k + '}').join(String(params[k]))
    })
  }
  return text
}

module.exports = { t, dict, setLang, getLang, DICTS }
