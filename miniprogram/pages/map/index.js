const i18n = require('../../i18n/index')
const geo = require('../../utils/geo')
const theme = require('../../utils/theme')
const cloud = require('../../utils/cloud')
const auth = require('../../utils/auth')
const rating = require('../../utils/rating')
const aspects = require('../../utils/aspects')

// 版本号只打到控制台，方便确认真机跑的是哪一版代码
const BUILD_TAG = 'S7'

const DEFAULT_CENTER = { latitude: 34.2619, longitude: 108.9421 }
const DEFAULT_SCALE = 14

// 卡片收起动画时长，要和 wxss 里的 card-out 对上
const CARD_CLOSE_ANIM_MS = 180

function buildPolygons(zones, selectedId) {
  return zones.map(function (zone) {
    const active = zone._id === selectedId
    return {
      points: geo.rectToPoints(zone.ne, zone.sw),
      strokeWidth: active ? 3 : 2,
      strokeColor: active ? theme.rectStrokeActive : theme.rectStroke,
      fillColor: active ? theme.rectFillActive : theme.rectFill,
      zIndex: active ? 100 : 10
    }
  })
}

function decorate(zone, lang) {
  const isEn = lang === 'en'
  return Object.assign({}, zone, {
    displayName: isEn ? zone.name_en || zone.name_zh : zone.name_zh,
    displayNameSub: isEn ? zone.name_zh : zone.name_en || ''
  })
}

Page({
  data: {
    T: {},
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    scale: DEFAULT_SCALE,
    polygons: [],
    zoneCount: 0,

    loading: true,
    loadError: '',

    bubbles: [],

    starList: [1, 2, 3, 4, 5],
    selectedZone: null,
    cardClosing: false
  },

  onLoad() {
    this.zones = []
    this.selectedId = ''
    this.closingTimer = null
    this.mapRect = null
    this.regionBusy = false
    this.bubbleTimer = null
    this.loadedOnce = false

    // 卡片上的评分是一份"草稿"：点星星、点词块都只改本地，
    // 等卡片被关掉（点地图空白处、切到别的夜市、离开页面）才统一提交
    this.draft = null

    console.log('[map] 代码版本 ' + BUILD_TAG)

    wx.setNavigationBarTitle({ title: i18n.t('appName') })
    this.setData({ T: i18n.dict() })
    this.render()
    this.loadZones()
  },

  onReady() {
    this.measureMap().then((rect) => {
      this.mapRect = rect
      this.updateBubbles()
    })
  },

  onShow() {
    // 从别的页面回来时，先清掉可能卡住的刷新状态。
    // 页面被切走时地图是挂起的，getRegion 的回调可能一直不回来，
    // 那个"正在刷新"的标志就会永远卡住，导致气泡再也不更新。
    this.regionBusy = false
    this.mapRect = null

    if (!this.loadedOnce) {
      this.loadedOnce = true
      return
    }

    // 重新量一次地图尺寸再刷数据：页面来回切换后布局可能有变化
    this.measureMap().then((rect) => {
      this.mapRect = rect
      // 先让气泡立刻恢复跟随，不用等网络请求回来
      this.updateBubbles()
      this.loadZones()
    })
  },

  onHide() {
    this.flushDraft()
    // 页面看不见的时候没必要继续刷气泡，回来时 onShow 会重新启动
    this.stopBubbleLoop()
  },

  onUnload() {
    this.flushDraft()
    this.stopBubbleLoop()
    if (this.closingTimer) {
      clearTimeout(this.closingTimer)
      this.closingTimer = null
    }
  },

  // ---------- 数据 ----------

  loadZones() {
    this.setData({ loading: true, loadError: '' })

    cloud
      .callCloud('zone', 'list')
      .then((zones) => {
        this.zones = zones || []
        this.selectedId = ''
        this.draft = null
        this.setData({ loading: false })
        this.render()
        this.updateBubbles()
      })
      .catch((err) => {
        this.zones = []
        this.selectedId = ''
        this.draft = null
        this.setData({
          loading: false,
          loadError: err.msg || '加载失败'
        })
        this.render()
        this.updateBubbles()
      })
  },

  onRetry() {
    this.loadZones()
  },

  // ---------- 渲染 ----------

  /**
   * 渲染拆成两块是有原因的：卡片里的内容变了（点星星、点词块），
   * 不能顺手把 polygons 一起重新 setData——地图会收到一份全新的多边形数组，
   * 然后整个重画一遍，看起来就是闪一下。
   */
  render() {
    this.renderMap()
    this.renderCard()
  },

  renderMap() {
    this.setData({
      polygons: buildPolygons(this.zones, this.selectedId),
      zoneCount: this.zones.length
    })
  },

  renderCard() {
    const found = this.zones.filter((zone) => {
      return zone._id === this.selectedId
    })[0] || null

    let selected = null
    if (found) {
      const info = found.rating || {}
      const described = rating.describe(info.avg || 0, info.count || 0)
      const mine = found.mine || null
      const draft = this.draft && this.draft.zoneId === found._id ? this.draft : null

      const myStars = draft && draft.stars ? draft.stars : mine ? mine.stars : 0
      const myAspects = draft ? draft.aspects : (mine && mine.aspects) || {}

      selected = decorate(found, i18n.getLang())
      selected.ratingText = described.text
      selected.ratingConfident = described.confident
      selected.myStars = myStars
      selected.rated = myStars > 0
      selected.aspectRows = aspects.buildRows(myAspects)
      selected.statusText = mine
        ? i18n.t(mine.pending ? 'ratingStatusPending' : 'ratingStatusActive')
        : ''
      selected.statusPending = !!(mine && mine.pending)
      selected.ratingHint = selected.rated ? i18n.t('ratingHintNote') : i18n.t('ratingHintTap')
    }

    this.setData({ selectedZone: selected })
  },

  // ---------- 地图上的星星气泡 ----------

  measureMap() {
    return new Promise(function (resolve) {
      wx.createSelectorQuery()
        .select('#market-map')
        .boundingClientRect(function (rect) {
          resolve(rect || null)
        })
        .exec()
    })
  },

  readRegion() {
    return new Promise(function (resolve) {
      wx.createMapContext('market-map').getRegion({
        success: function (res) {
          resolve(res)
        },
        fail: function () {
          resolve(null)
        }
      })
    })
  },

  /**
   * 重算气泡位置。
   *
   * 地图组件没有"经纬度换算成屏幕坐标"的接口，所以自己算：
   * 先用 getRegion 拿到当前可视范围的经纬度边界，再做线性插值。
   * 市区尺度上线性插值的误差可以忽略。
   *
   * 拖动过程中 regionchange 会连续触发，用"上一次还没回来"当节流阀：
   * 这样气泡会跟着地图走，而不是等停下来才跳一下，
   * 也不会因为请求堆积把界面拖卡。
   */
  updateBubbles() {
    if (this.regionBusy) return
    this.regionBusy = true

    // 兜底：万一回调没回来（页面被切走、地图被挂起），
    // 不能让这个标志永远卡住，否则气泡之后再也不更新
    const guard = setTimeout(() => {
      this.regionBusy = false
    }, 1500)

    const measuring = this.mapRect ? Promise.resolve(this.mapRect) : this.measureMap()

    measuring
      .then((rect) => {
        this.mapRect = rect
        return this.readRegion()
      })
      .then((region) => {
        clearTimeout(guard)
        this.regionBusy = false
        if (!region || !this.mapRect) return
        this.renderBubbles(region)
      })
      .catch(() => {
        clearTimeout(guard)
        this.regionBusy = false
      })
  },

  renderBubbles(region) {
    const rated = this.zones.filter(function (zone) {
      return zone.mine && zone.mine.stars
    })

    if (!rated.length) {
      this.stopBubbleLoop()
      if (this.data.bubbles.length) this.setData({ bubbles: [] })
      return
    }

    this.startBubbleLoop()

    const west = region.southwest.longitude
    const east = region.northeast.longitude
    const south = region.southwest.latitude
    const north = region.northeast.latitude
    if (!(east > west) || !(north > south)) return

    const rect = this.mapRect
    const bubbles = []

    rated.forEach(function (zone, index) {
      const center = geo.rectCenter(zone.ne, zone.sw)
      const x = rect.left + ((center.longitude - west) / (east - west)) * rect.width
      const y = rect.top + ((north - center.latitude) / (north - south)) * rect.height

      // 滑出屏幕的就不渲染
      if (x < rect.left - 60 || x > rect.left + rect.width + 60) return
      if (y < rect.top - 60 || y > rect.top + rect.height + 60) return

      bubbles.push({
        key: zone._id,
        x: Math.round(x),
        y: Math.round(y),
        delay: (index % 5) * 0.22
      })
    })

    // 位置没变就别 setData，轮询才不会变成无谓的开销
    if (this.sameBubbles(bubbles)) return
    this.setData({ bubbles: bubbles })
  },

  sameBubbles(next) {
    const current = this.data.bubbles
    if (current.length !== next.length) return false
    for (let i = 0; i < next.length; i++) {
      if (current[i].key !== next[i].key) return false
      if (current[i].x !== next[i].x || current[i].y !== next[i].y) return false
    }
    return true
  },

  /**
   * 定时刷新气泡位置。
   *
   * 为什么不只靠 regionchange：拖动时它会连续触发，但双指缩放时往往
   * 只在结束时来一次，于是缩放过程中气泡会僵在原地。
   * 加一个 200ms 的轮询兜底，只在真有气泡存在时才跑。
   */
  startBubbleLoop() {
    if (this.bubbleTimer) return
    this.bubbleTimer = setInterval(() => {
      this.updateBubbles()
    }, 200)
  },

  stopBubbleLoop() {
    if (this.bubbleTimer) {
      clearInterval(this.bubbleTimer)
      this.bubbleTimer = null
    }
  },

  onRegionChange() {
    this.updateBubbles()
  },

  // ---------- 地图交互 ----------

  onMapTap(e) {
    this.applyTapPoint((e && e.detail) || {})
  },

  /**
   * 点击地图上的地名。
   * 实测：点中地名时地图只发 poitap、不发 tap，不管它卡片就会僵住。
   */
  onPoiTap(e) {
    this.applyTapPoint((e && e.detail) || {})
  },

  applyTapPoint(detail) {
    if (typeof detail.latitude !== 'number' || typeof detail.longitude !== 'number') return

    const point = { latitude: detail.latitude, longitude: detail.longitude }
    const found = this.zones.filter(function (zone) {
      return geo.pointInRect(point, zone.ne, zone.sw)
    })[0]

    if (!found) {
      this.closeCard()
      return
    }

    if (this.selectedId === found._id) return

    // 切到别的夜市之前，先把上一个的草稿提交掉
    this.flushDraft()
    this.cancelClosing()
    this.selectedId = found._id
    this.openDraft(found)
    this.render()
  },

  // ---------- 卡片里的评分草稿 ----------

  openDraft(zone) {
    const mine = zone.mine
    this.draft = {
      zoneId: zone._id,
      stars: mine ? mine.stars : 0,
      aspects: Object.assign({}, (mine && mine.aspects) || {}),
      dirty: false
    }
  },

  onTapStar(e) {
    const stars = Number(e.currentTarget.dataset.star)
    if (!stars || !this.selectedId) return

    if (!this.draft || this.draft.zoneId !== this.selectedId) {
      const zone = this.zones.filter((item) => {
        return item._id === this.selectedId
      })[0]
      if (!zone) return
      this.openDraft(zone)
    }

    if (this.draft.stars === stars) return
    this.draft.stars = stars
    this.draft.dirty = true
    this.renderCard()
  },

  onPickAspect(e) {
    const data = e.currentTarget.dataset
    const dimensionKey = data.dimension
    const value = Number(data.value)

    if (!dimensionKey || !this.draft || !this.draft.stars) return
    if (this.draft.aspects[dimensionKey] === value) return

    this.draft.aspects[dimensionKey] = value
    this.draft.dirty = true
    this.renderCard()
  },

  /** 把草稿提交到云端。没有改动就什么都不做 */
  flushDraft() {
    const draft = this.draft
    if (!draft || !draft.dirty || !draft.stars) return Promise.resolve()

    const zoneId = draft.zoneId
    const payload = {
      zoneId: zoneId,
      stars: draft.stars,
      aspects: draft.aspects
    }

    // 先断开引用，避免同一个草稿被提交两次
    draft.dirty = false
    if (this.draft === draft) this.draft = null

    return auth
      .ensureLogin()
      .then(function () {
        return cloud.callCloud('zone', 'rate', payload)
      })
      .then((result) => {
        const zone = this.zones.filter(function (item) {
          return item._id === zoneId
        })[0]
        if (zone) {
          zone.rating = result.rating
          zone.mine = result.mine
        }
        this.renderCard()
        this.updateBubbles()
        wx.showToast({ title: i18n.t('ratingDone'), icon: 'success' })
      })
      .catch((err) => {
        if (err.code === 'TOO_FREQUENT') {
          wx.showModal({
            title: i18n.t('commonNotice'),
            content: i18n.t('ratingTooFrequent'),
            showCancel: false,
            confirmText: i18n.t('commonGotIt')
          })
          return
        }
        wx.showToast({ title: err.msg || '保存失败', icon: 'none' })
      })
  },

  // ---------- 卡片 ----------

  onOpenMine() {
    // 先把草稿提交掉再跳转，否则「我的打分」可能查不到刚打的分——
    // 提交是异步的，而页面切换不等它
    this.flushDraft().then(function () {
      wx.navigateTo({ url: '/pages/mine/index' })
    })
  },

  closeCard() {
    if (!this.selectedId || this.data.cardClosing) return

    this.flushDraft()
    this.setData({ cardClosing: true })

    this.closingTimer = setTimeout(() => {
      this.closingTimer = null
      this.selectedId = ''
      this.setData({ cardClosing: false })
      this.render()
    }, CARD_CLOSE_ANIM_MS)
  },

  cancelClosing() {
    if (this.closingTimer) {
      clearTimeout(this.closingTimer)
      this.closingTimer = null
    }
    if (this.data.cardClosing) {
      this.setData({ cardClosing: false })
    }
  }
})
