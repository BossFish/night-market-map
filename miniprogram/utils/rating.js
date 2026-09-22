/**
 * 把平均分翻译成人话。
 *
 * 思路来自 Steam 的总体评价：不给用户看数字，直接给一句态度。
 * 「4.2 分」需要用户自己换算成好不好，「大多好评」不用。
 *
 * 分档表集中放在这里，想调口径改这一个数组就行，不用翻遍页面。
 */
const i18n = require('../i18n/index')

// 从高到低排。判断时取第一个满足「平均分 >= min」的档位。
const LEVELS = [
  { min: 4.5, key: 'ratingOverwhelming' },
  { min: 4.0, key: 'ratingMostlyGood' },
  { min: 3.0, key: 'ratingMixed' },
  { min: 2.0, key: 'ratingUnderwhelming' },
  { min: 0, key: 'ratingPoorlyManaged' }
]

// 评分人数不到这个数，推荐度只以灰色显示，而且不给具体人数：样本太少，别当真
const CONFIDENT_COUNT = 10

function levelKey(average) {
  for (let i = 0; i < LEVELS.length; i++) {
    if (average >= LEVELS[i].min) return LEVELS[i].key
  }
  return LEVELS[LEVELS.length - 1].key
}

/** 中文用全角引号，英文用直引号 */
function quoted(text) {
  return i18n.getLang() === 'en' ? '"' + text + '"' : '“' + text + '”'
}

/**
 * 生成推荐度文案。
 * 返回 { text, confident }，confident 为 false 时界面用灰色显示。
 */
function describe(average, count) {
  if (!count) {
    return { text: i18n.t('ratingNoData'), confident: false }
  }

  const label = quoted(i18n.t(levelKey(average)))

  // 样本太少时不给具体人数，只说"不到 N 人"——
  // 写"3人评"会让人以为这个档位可信，其实只是三个人而已
  if (count < CONFIDENT_COUNT) {
    return {
      text: i18n.t('ratingLowSample', { label: label, threshold: CONFIDENT_COUNT }),
      confident: false
    }
  }

  return {
    text: i18n.t('ratingValueFormat', {
      label: label,
      count: count
    }),
    confident: true
  }
}

module.exports = {
  describe: describe,
  levelKey: levelKey,
  CONFIDENT_COUNT: CONFIDENT_COUNT
}
