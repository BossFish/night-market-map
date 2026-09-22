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
 * picked 形如 { hygiene: 0, seating: 2 }，没选的维度就不高亮。
 */
function buildRows(picked) {
  const chosen = picked || {}

  return DIMENSIONS.map(function (dimension) {
    return {
      dimensionKey: dimension.dimensionKey,
      options: dimension.labels.map(function (labelKey, value) {
        return {
          value: value,
          label: i18n.t(labelKey),
          selected: chosen[dimension.dimensionKey] === value
        }
      })
    }
  })
}

module.exports = {
  buildRows: buildRows,
  DIMENSIONS: DIMENSIONS
}
