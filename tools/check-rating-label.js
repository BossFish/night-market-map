/**
 * 开发用小工具：验证「夜市推荐度」的分档和灰色门槛。
 *
 * 推荐度是纯前端逻辑（不依赖微信环境），所以这个测试跑的是真实代码，
 * 不是替身。分档边界最容易出错，专门把边界值都测一遍。
 *
 * 运行：node tools/check-rating-label.js
 */
const path = require('path')

const rating = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'rating.js'))
const i18n = require(path.join(__dirname, '..', 'miniprogram', 'i18n', 'index.js'))

function levelOf(average, count) {
  return rating.levelKey(average)
}

async function run() {
  const checks = []

  i18n.setLang('zh')

  checks.push([
    '没人评价时提示来打分',
    rating.describe(0, 0).text === '请为这个夜市打分' && rating.describe(0, 0).confident === false
  ])

  checks.push([
    '每人评也有平均分，但不算"可信"',
    rating.describe(4.6, 1).confident === false
  ])

  checks.push([
    '9 人评价仍是灰色',
    rating.describe(4.6, 9).confident === false
  ])

  checks.push([
    '到 10 人才变成正常颜色',
    rating.describe(4.6, 10).confident === true
  ])

  const cases = [
    [5.0, 'ratingOverwhelming'],
    [4.5, 'ratingOverwhelming'],
    [4.4, 'ratingMostlyGood'],
    [4.0, 'ratingMostlyGood'],
    [3.9, 'ratingMixed'],
    [3.0, 'ratingMixed'],
    [2.9, 'ratingUnderwhelming'],
    [2.0, 'ratingUnderwhelming'],
    [1.9, 'ratingPoorlyManaged'],
    [1.0, 'ratingPoorlyManaged']
  ]

  let allLevelsOk = true
  const detail = []
  cases.forEach(function (item) {
    const actual = levelOf(item[0], 10)
    if (actual !== item[1]) allLevelsOk = false
    detail.push(item[0] + '→' + i18n.t(actual))
  })
  checks.push(['各档位的分界值都对：' + detail.join('，'), allLevelsOk])

  const zhText = rating.describe(4.6, 12).text
  checks.push([
    '人数够了才给出具体人数',
    zhText === '“好评如潮” · 12人评'
  ])

  const lowSample = rating.describe(4.6, 3)
  checks.push([
    '人数不足时不给具体人数，只说少于几个人',
    lowSample.text === '“好评如潮” · 少于10人评价' && lowSample.confident === false
  ])

  i18n.setLang('en')
  const enText = rating.describe(4.6, 12).text
  checks.push([
    '切到英文后档位和引号都跟着换',
    enText === '"Overwhelmingly Positive" · 12 ratings'
  ])

  const enGray = rating.describe(3.2, 3)
  checks.push([
    '英文下人数不足同样只说少于几个人',
    enGray.confident === false && enGray.text === '"Mixed" · fewer than 10 ratings'
  ])

  i18n.setLang('zh')

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
