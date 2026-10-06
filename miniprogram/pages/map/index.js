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

// 触摸区域和显示区域保持一致：点哪儿就是哪儿，不往外扩。
// 之前为了好点中往外放了 6 米，结果点旁边空的地方也会选中，反而困惑。
const STALL_TAP_MARGIN_M = 0

/**
 * 摊位显示时的最小短边（米）。
 *
 * 摊位显示时的最小短边（米）。0 = 严格按真实尺寸显示，画多大就显示多大。
 *
 * 曾经为了让小摊位看得见、点得中，把它设成 6 或 10，结果框比实际大好几倍，
 * 一眼就看得出比例不对。现在改回真实尺寸：**显示和触摸都按真实大小来**。
 * 代价是 3×6 米的摊位在能看全夜市的缩放下只有几像素，要点中得先双指放大，
 * 或者用夜市卡片里的摊位名字列表。
 */
const MIN_STALL_DISPLAY_M = 0

function metersPerLatDegree() {
  return 111320
}

/** 按比例放大矩形，保证短边不小于 MIN_STALL_DISPLAY_M 米。中心点不动 */
function displayRect(ne, sw) {
  const midLat = (ne.latitude + sw.latitude) / 2
  const heightM = (ne.latitude - sw.latitude) * metersPerLatDegree()
  const widthM =
    (ne.longitude - sw.longitude) *
    metersPerLatDegree() *
    Math.cos((midLat * Math.PI) / 180)

  const shortSide = Math.min(heightM, widthM)
  if (MIN_STALL_DISPLAY_M <= 0 || shortSide <= 0 || shortSide >= MIN_STALL_DISPLAY_M) {
    return { ne: ne, sw: sw }
  }

  const scale = MIN_STALL_DISPLAY_M / shortSide
  const centerLat = midLat
  const centerLng = (ne.longitude + sw.longitude) / 2
  const halfLat = ((ne.latitude - sw.latitude) / 2) * scale
  const halfLng = ((ne.longitude - sw.longitude) / 2) * scale

  return {
    ne: { latitude: centerLat + halfLat, longitude: centerLng + halfLng },
    sw: { latitude: centerLat - halfLat, longitude: centerLng - halfLng }
  }
}

function inflateRect(ne, sw, meters) {
  const dLat = meters / 111320
  const midLat = (ne.latitude + sw.latitude) / 2
  const dLng = meters / (111320 * Math.cos((midLat * Math.PI) / 180))

  return {
    ne: { latitude: ne.latitude + dLat, longitude: ne.longitude + dLng },
    sw: { latitude: sw.latitude - dLat, longitude: sw.longitude - dLng }
  }
}

/** 绿色的是夜市区域，橙色的是摊位，选中的那份颜色更深 */
function buildPolygons(zones, stalls, zoneId, stallId) {
  const list = zones.map(function (zone) {
    const active = zone._id === zoneId
    return {
      points: geo.rectToPoints(zone.ne, zone.sw),
      strokeWidth: active ? 3 : 2,
      strokeColor: active ? theme.rectStrokeActive : theme.rectStroke,
      fillColor: active ? theme.rectFillActive : theme.rectFill,
      zIndex: active ? 100 : 10
    }
  })

  stalls.forEach(function (stall) {
    const active = stall._id === stallId
    const box = displayRect(stall.ne, stall.sw)
    list.push({
      points: geo.rectToPoints(box.ne, box.sw),
      strokeWidth: active ? 3 : 2,
      strokeColor: active ? theme.stallStrokeActive : theme.stallStroke,
      fillColor: active ? theme.stallFillActive : theme.stallFill,
      zIndex: active ? 300 : 200
    })
  })

  return list
}

/**
 * 按当前语言取名字。
 *
 * 中文模式下就只显示中文——不再把英文名当副标题挂在下面。
 * 英文要等到用户主动切了语言才出现（英文缺失时回退中文）。
 */
function decorate(item, lang) {
  const isEn = lang === 'en'
  return Object.assign({}, item, {
    displayName: isEn ? item.name_en || item.name_zh : item.name_zh
  })
}

/**
 * 把价目表整理成能直接渲染的样子。
 *
 * 三种模板在这里统一：系列的价格挂在标题上（同价），单品的价格在每条搭配上，
 * 增项只有名字和价格。
 */
function buildMenu(items) {
  const isEn = i18n.getLang() === 'en'
  const currency = i18n.t('priceUnit')

  return (items || []).map(function (item, index) {
    const kind = item.kind || 'single'

    return {
      key: index,
      kind: kind,
      name: isEn ? item.name_en || item.name_zh : item.name_zh,
      priceText: item.price === undefined || item.price === null ? '' : item.price + currency,
      note: item.note_zh || '',
      options: (item.options || []).map(function (option, optionIndex) {
        return {
          key: optionIndex,
          name: isEn ? option.name_en || option.name_zh : option.name_zh,
          priceText:
            option.price === undefined || option.price === null ? '' : option.price + currency
        }
      })
    }
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
    stallError: '',

    bubbles: [],

    // 当前选中的夜市里的摊位，以及被点开的那个摊位
    stalls: [],
    selectedStall: null,
    stallLabels: [],
    // 拉摊位数据的时候在屏幕中间挡一层，不然点完区域会有一小段没反应的空白
    stallLoading: false,

    starList: [1, 2, 3, 4, 5],
    selectedZone: null,
    cardClosing: false
  },

  onLoad() {
    this.zones = []
    this.selectedId = ''
    this.stalls = []
    this.selectedStallId = ''
    this.selectedStall = null
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
        this.stalls = []
        this.selectedStallId = ''
    this.selectedStall = null
        this.draft = null
        this.setData({ loading: false })
        this.render()
        this.updateBubbles()
      })
      .catch((err) => {
        this.zones = []
        this.selectedId = ''
        this.stalls = []
        this.selectedStallId = ''
    this.selectedStall = null
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

  onRetryStalls() {
    const zone = this.zones.filter((item) => {
      return item._id === this.selectedId
    })[0]
    if (zone) this.loadStalls(zone)
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
      polygons: buildPolygons(this.zones, this.stalls || [], this.selectedId, this.selectedStallId),
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
      // 分数选完之后，下次打开卡片就不再显示「你的评分」了
      selected.showMyRating = !mine
      // 维度选中过的才显示所有人的比例
      selected.aspectRows = aspects.buildRows(
        myAspects,
        (found.rating && found.rating.aspects) || {}
      )
      selected.statusText = mine
        ? i18n.t(mine.pending ? 'ratingStatusPending' : 'ratingStatusActive')
        : ''
      selected.statusPending = !!(mine && mine.pending)
      selected.ratingHint = selected.rated ? i18n.t('ratingHintNote') : i18n.t('ratingHintTap')
      // 「摊点数量」这行现在显示真实数字，也顺便当个诊断：
      // 显示 0 说明后台还没给这个夜市录摊位
      selected.stallCount = found._id === this.selectedId ? (this.stalls || []).length : 0
      // 摊位在手机上只有几个像素宽，直接点方框很难点中，
      // 所以卡片里再给一份名字列表，点名字一样能打开摊位卡片
      selected.stallList = (this.stalls || []).map(function (stall) {
        return {
          _id: stall._id,
          name: i18n.getLang() === 'en' ? stall.name_en || stall.name_zh : stall.name_zh
        }
      })
    }

    let stall = null
    // 直接用手上那个摊位对象，不再拿 id 回列表里查。
    // 之前是"只存 id、渲染时回查"，一旦列表被重新拉过（id 变了）就查不到，
    // 表现成"命中成功却弹不出卡片"
    if (this.selectedStall) {
      const picked = this.selectedStall
      stall = decorate(picked, i18n.getLang())
      stall.menu = buildMenu(picked.price_items)
    }

    this.setData({
      selectedZone: selected,
      selectedStall: stall,
      stalls: this.stalls || []
    })
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

  /** 当前视野下，经纬度换到屏幕像素 */
  projectionOf(region) {
    const rect = this.mapRect
    if (!rect || !region || !region.southwest || !region.northeast) return null

    const west = region.southwest.longitude
    const east = region.northeast.longitude
    const south = region.southwest.latitude
    const north = region.northeast.latitude
    if (!(east > west) || !(north > south)) return null

    return {
      rect: rect,
      x: function (lng) {
        return rect.left + ((lng - west) / (east - west)) * rect.width
      },
      y: function (lat) {
        return rect.top + ((north - lat) / (north - south)) * rect.height
      }
    }
  },

  /** 画星星气泡（打过分的夜市）和摊位名字标签 */
  renderBubbles(region) {
    const project = this.projectionOf(region)
    if (!project) return

    const rect = project.rect
    const bubbles = []
    const selectedId = this.selectedId

    this.zones
      .filter(function (zone) {
        return zone.mine && zone.mine.stars
      })
      .forEach(function (zone, index) {
        // 这个夜市正开着卡片时，星星挪到卡片里显示，地图上就先不画
        if (zone._id === selectedId) return

        const center = geo.rectCenter(zone.ne, zone.sw)
        const x = project.x(center.longitude)
        const y = project.y(center.latitude)

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

    const labels = this.selectedId && (this.stalls || []).length
      ? this.buildStallLabels(project)
      : []

    // 有东西要跟着地图走就开轮询，没有就停掉
    if (bubbles.length || labels.length) this.startBubbleLoop()
    else this.stopBubbleLoop()

    // 位置没变就别 setData，轮询才不会变成无谓的开销
    if (!this.sameBubbles(bubbles)) this.setData({ bubbles: bubbles })
    if (!this.sameLabels(labels)) this.setData({ stallLabels: labels })
  },

  /**
   * 摊位名字的排布。
   *
   * 规则：默认贴在方框外、上方；如果和左边那个标签横向撞上了，
   * 就挪到方框下方——上下交错，互相不压。
   *
   * 估宽只影响"要不要错开"这个判断，不影响名字本身的显示。
   */
  buildStallLabels(project) {
    const isEn = i18n.getLang() === 'en'
    const rect = project.rect
    const items = []

    this.stalls.forEach(function (stall) {
      const name = isEn ? stall.name_en || stall.name_zh : stall.name_zh
      if (!name) return

      const box = displayRect(stall.ne, stall.sw)
      const left = project.x(box.sw.longitude)
      const right = project.x(box.ne.longitude)
      const top = project.y(box.ne.latitude)
      const bottom = project.y(box.sw.latitude)
      const centerX = (left + right) / 2

      if (centerX < rect.left - 120 || centerX > rect.left + rect.width + 120) return

      items.push({
        key: stall._id,
        text: name,
        centerX: centerX,
        top: top,
        bottom: bottom,
        width: Math.max(52, name.length * 15 + 14)
      })
    })

    items.sort(function (a, b) {
      return a.centerX - b.centerX
    })

    const GAP = 6
    const rowRight = [-Infinity, -Infinity]
    const labels = []

    items.forEach(function (item) {
      const left = item.centerX - item.width / 2
      const right = item.centerX + item.width / 2

      let row = 0
      if (left < rowRight[0] + GAP) {
        row = 1
        // 下面也挤，就还是回上面，挤一挤总比叠在一起强
        if (left < rowRight[1] + GAP) row = 0
      }
      rowRight[row] = right

      labels.push({
        key: item.key,
        text: item.text,
        x: Math.round(item.centerX),
        y: Math.round(row === 0 ? item.top - 6 : item.bottom + 6),
        below: row === 1
      })
    })

    return labels
  },

  sameLabels(next) {
    const current = this.data.stallLabels
    if (current.length !== next.length) return false

    for (let i = 0; i < next.length; i++) {
      if (current[i].key !== next[i].key) return false
      if (current[i].x !== next[i].x || current[i].y !== next[i].y) return false
      if (current[i].below !== next[i].below) return false
    }
    return true
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

    // 摊位盖在区域上面，所以先看有没有点中摊位
    if (this.selectedId && (this.stalls || []).length) {
      const stall = this.stalls.filter(function (item) {
        const shown = displayRect(item.ne, item.sw)
        const box = inflateRect(shown.ne, shown.sw, STALL_TAP_MARGIN_M)
        return geo.pointInRect(point, box.ne, box.sw)
      })[0]

      if (stall) {
        this.selectedStallId = stall._id
        this.selectedStall = stall
        this.setData({ stallError: '' })
        this.render()
        return
      }
    }

    const found = this.zones.filter(function (zone) {
      return geo.pointInRect(point, zone.ne, zone.sw)
    })[0]

    // 临时诊断：点在这个夜市里、也有摊位，却没命中任何一个。
    // 这行红字能告诉我们"是命中判断偏了"而不是"数据没加载"
    if (found && found._id === this.selectedId && (this.stalls || []).length) {
      this.setData({
        stallError: '点到了区域，但没命中摊位（这个区域有 ' + this.stalls.length + ' 个）'
      })
    }

    // 卡片是两层的：开着摊位卡片时，点别处先退回夜市卡片
    if (this.data.selectedStall) {
      this.selectedStallId = ''
    this.selectedStall = null
      this.render()
      return
    }

    if (!found) {
      this.closeCard()
      return
    }

    if (this.selectedId === found._id) return

    // 切到别的夜市之前，先把上一个的草稿提交掉
    this.flushDraft()
    this.cancelClosing()
    this.selectedId = found._id
    this.selectedStallId = ''
    this.selectedStall = null
    this.stalls = []
    this.openDraft(found)
    this.loadStalls(found)
    this.fitZone(found)
    this.render()
    // 星星要挪进卡片里，地图上那份得重新算
    this.updateBubbles()
  },

  /** 把视野缩放到刚好装下这个夜市。底部留出卡片的位置 */
  fitZone(zone) {
    wx.createMapContext('market-map').includePoints({
      points: [
        { latitude: zone.ne.latitude, longitude: zone.ne.longitude },
        { latitude: zone.sw.latitude, longitude: zone.sw.longitude }
      ],
      padding: [80, 60, 340, 60]
    })
  },

  loadStalls(zone) {
    const zoneId = zone._id
    this.setData({ stallLoading: true, stallError: '' })

    cloud
      .callCloud('zone', 'stalls', { zoneId: zoneId })
      .then((list) => {
        // 用户可能已经切到别的夜市了，晚到的结果丢掉
        if (this.selectedId !== zoneId) return
        this.stalls = list || []
        this.setData({ stallLoading: false, stallError: '' })
        this.render()
        // 摊位名字要靠地图视野换算位置，拉到数据后立刻画一遍
        this.updateBubbles()
      })
      .catch((err) => {
        // 这里必须让用户看得见：如果云函数还没部署新版，
        // 报错会被 console 吞掉，表现成"后台明明加了摊位却显示 0"
        console.warn('[map] 读取摊位失败', err)
        this.setData({ stallLoading: false, stallError: err.msg || '读取摊位失败' })
      })
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

    // 已经提交过的维度，卡片里就只看了——想改去「我的 → 我的打分」。
    // 只有这次打开卡片新填的（草稿），关闭前还能反悔
    const current = this.zones.filter((item) => {
      return item._id === this.selectedId
    })[0]
    const submitted = current && current.mine && current.mine.aspects
    if (submitted && submitted[dimensionKey] !== undefined) {
      wx.showToast({ title: i18n.t('aspectLockedHint'), icon: 'none' })
      return
    }

    // 本地先把自己这票算进去，绿色填充立刻就有动静，
    // 不用等关卡片提交、再重新拉一次列表
    const zone = this.zones.filter((item) => {
      return item._id === this.selectedId
    })[0]

    if (zone) {
      if (!zone.rating) zone.rating = { avg: 0, count: 0, aspects: {} }
      if (!zone.rating.aspects) zone.rating.aspects = {}
      if (!Array.isArray(zone.rating.aspects[dimensionKey])) {
        zone.rating.aspects[dimensionKey] = [0, 0, 0]
      }

      const bucket = zone.rating.aspects[dimensionKey]
      const previous = this.draft.aspects[dimensionKey]
      if (previous !== undefined && bucket[previous] > 0) bucket[previous] -= 1
      if (value >= 0 && value < bucket.length) bucket[value] += 1
    }

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

  /** 点卡片里的摊位名字，和点地图上的橙色方框是同一件事 */
  onTapStallRow(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return

    const stall = (this.stalls || []).filter(function (item) {
      return item._id === id
    })[0]
    if (!stall) return

    this.selectedStallId = id
    this.selectedStall = stall
    this.setData({ stallError: '' })
    this.render()

    // 顺带把地图挪到那个摊位上，让人看清方框在哪
    this.focusStall(stall)
  },

  focusStall(stall) {
    const center = geo.rectCenter(stall.ne, stall.sw)
    // 地图中心由 latitude / longitude 这两个属性控制，改它们就会挪视野
    this.setData({ latitude: center.latitude, longitude: center.longitude })
  },

  closeCard() {
    if (!this.selectedId || this.data.cardClosing) return

    this.flushDraft()
    this.setData({ cardClosing: true })

    this.closingTimer = setTimeout(() => {
      this.closingTimer = null
      this.selectedId = ''
      this.stalls = []
      this.selectedStallId = ''
    this.selectedStall = null
      this.setData({ cardClosing: false })
      this.render()
      // 卡片收回了，星星重新回到地图上
      this.updateBubbles()
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
