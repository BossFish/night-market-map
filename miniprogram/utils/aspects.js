/**
 * 评分的四个维度，每个维度三个词，从好到差。
 *
 * 用户不需要知道这些维度的"名字"（卫生、座位、拥挤、管理），
 * 界面上只摆三组词让他挑——词本身就把维度说清楚了。
 *
 * 存储时只存 0 / 1 / 2，不存文字，
 * 这样以后改词或者加英文都不影响已经存在的数据。
 */
const i18n = require('../i18n/index')

const DIMENSIONS = [
  {
    dimensionKey: 'hygiene',
    labels: ['aspectHygieneGood', 'aspectHygieneOk', 'aspectHygieneBad']
  },
  {
    dimensionKey: 'seating',
    labels: ['aspectSeatingAny', 'aspectSeatingGrab', 'aspectSeatingTakeaway']
  },
  {
    dimensionKey: 'crowding',
    labels: ['aspectCrowdingPacked', 'aspectCrowdingLively', 'aspectCrowdingEmpty']
  },
  {
    dimensionKey: 'management',
    labels: ['aspectManagementTidy', 'aspectManagementNormal', 'aspectManagementChaotic']
  }
]

/**
 * 生成四行待渲染的数据。
 * picked 形如 { hygiene: 0, seating: 2 }，是我自己选过的。
 * counts 形如 { hygiene: [1, 5, 2] }，是所有人在这三个词上的票数。
 *
 * 绿色填充的规则：**这个维度我自己选过了**，才把所有人的比例显示出来；
 * 没选过的维度保持普通样子——否则会形成从众，后看到的人会跟着多数走。
 */
function buildRows(picked, counts) {
  const chosen = picked || {}
  const buckets = counts || {}

  return DIMENSIONS.map(function (dimension) {
    const key = dimension.dimensionKey
    const answered = chosen[key] !== undefined
    const bucket = Array.isArray(buckets[key]) ? buckets[key] : []
    const total = bucket.reduce(function (sum, value) {
      return sum + value
    }, 0)
    const showFill = answered && total > 0

    return {
      dimensionKey: key,
      showFill: showFill,
      options: dimension.labels.map(function (labelKey, value) {
        return {
          value: value,
          label: i18n.t(labelKey),
          selected: chosen[key] === value,
          percent: showFill ? Math.round(((bucket[value] || 0) / total) * 100) : 0
        }
      })
    }
  })
}

module.exports = {
  buildRows: buildRows,
  DIMENSIONS: DIMENSIONS
}
