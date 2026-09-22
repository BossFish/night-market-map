const i18n = require('../../i18n/index')
const auth = require('../../utils/auth')
const cloud = require('../../utils/cloud')
const aspects = require('../../utils/aspects')

const STAR_LIST = [1, 2, 3, 4, 5]

/**
 * 「我的」页。
 *
 * 一块是身份：小程序不索取头像昵称，那用户至少该知道自己以什么身份出现。
 * 另一块是「我的打分」：打过的夜市、当前状态（等待生效中 / 生效中）、
 * 改分入口，以及四个维度的词块。
 *
 * 进入这个页面就会建立身份（如果还没有）。
 */
Page({
  data: {
    T: {},
    loading: true,
    error: '',
    displayName: '',
    avatarChar: '',
    isNew: false,
    myRatings: []
  },

  onLoad() {
    this.rawRatings = []
    this.setData({ T: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('mineTitle') })
    this.refresh()
  },

  onShow() {
    // 从地图页打完分回来，列表要重新拉一次
    if (this.loadedOnce) this.loadRatings()
  },

  refresh() {
    this.setData({ loading: true, error: '' })

    auth
      .ensureLogin()
      .then((profile) => {
        const isEn = i18n.getLang() === 'en'
        const name = isEn
          ? profile.displayNameEn || profile.displayNameZh
          : profile.displayNameZh || profile.displayNameEn

        this.setData({
          loading: false,
          isNew: !!profile.isNew,
          displayName: name,
          avatarChar: name ? name.slice(0, 1) : ''
        })

        this.loadedOnce = true
        return this.loadRatings()
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: err.msg || '连接失败'
        })
      })
  },

  onRetry() {
    this.refresh()
  },

  // ---------- 我的打分 ----------

  loadRatings() {
    return cloud
      .callCloud('zone', 'mine')
      .then((list) => {
        this.rawRatings = list || []
        this.renderRatings()
      })
      .catch((err) => {
        wx.showToast({ title: err.msg || '读取失败', icon: 'none' })
      })
  },

  renderRatings() {
    const isEn = i18n.getLang() === 'en'

    const rows = this.rawRatings.map(function (item) {
      return {
        zoneId: item.zoneId,
        name: isEn ? item.name_en || item.name_zh : item.name_zh,
        pending: item.pending,
        starItems: STAR_LIST.map(function (value) {
          return { value: value, on: value <= item.stars }
        }),
        aspectRows: aspects.buildRows(item.aspects)
      }
    })

    this.setData({ myRatings: rows })
  },

  onChangeStars(e) {
    const data = e.currentTarget.dataset
    const zoneId = data.zone
    const stars = Number(data.star)
    if (!zoneId || !stars) return

    const raw = this.findRaw(zoneId)
    if (!raw || raw.stars === stars) return

    // 这里点一下就提交，不再弹确认框——改分是随时可以反悔的操作，
    // 多一次确认只是多一次打断
    this.submitStars(zoneId, stars)
  },

  submitStars(zoneId, stars) {
    wx.showLoading({ title: i18n.t('ratingSubmitting'), mask: true })

    cloud
      .callCloud('zone', 'rate', { zoneId: zoneId, stars: stars })
      .then(() => {
        wx.hideLoading()
        return this.loadRatings()
      })
      .then(() => {
        wx.showToast({ title: i18n.t('ratingDone'), icon: 'success' })
      })
      .catch((err) => {
        wx.hideLoading()
        wx.showToast({ title: err.msg || '修改失败', icon: 'none' })
      })
  },

  onPickAspect(e) {
    const data = e.currentTarget.dataset
    const zoneId = data.zone
    const dimensionKey = data.dimension
    const value = Number(data.value)
    if (!zoneId || !dimensionKey) return

    const raw = this.findRaw(zoneId)
    if (!raw) return

    const current = raw.aspects || {}
    if (current[dimensionKey] === value) return

    const next = Object.assign({}, current)
    next[dimensionKey] = value

    cloud
      .callCloud('zone', 'setAspects', { zoneId: zoneId, aspects: next })
      .then((res) => {
        raw.aspects = res.aspects
        this.renderRatings()
      })
      .catch((err) => {
        wx.showToast({ title: err.msg || '保存失败', icon: 'none' })
      })
  },

  findRaw(zoneId) {
    return this.rawRatings.filter(function (item) {
      return item.zoneId === zoneId
    })[0]
  }
})
