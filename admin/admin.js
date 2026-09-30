/**
 * 管理后台的前端逻辑。
 *
 * 这个页面只跟本地服务器（同源的 /api）打交道，
 * 由服务器再去请求云函数。所以这里不需要处理任何跨域、密钥签名之类的事。
 */

var API = '/api'
var KEY_STORAGE = 'xian-admin-key'

var state = {
  key: '',
  zones: [],
  editingId: null
}

// ---------- 腾讯地图 ----------

var MAP_SCRIPT_URL = 'https://map.qq.com/api/gljs?v=1.exp&key='
var DEFAULT_CENTER = { latitude: 34.2619, longitude: 108.9421 }

// 一个摊位大概就这么大。鼠标点下去的位置是摊位的右下角（东南角），
// 右键能把这 2×3 转成 3×2。想改尺寸就改这两个数。
var STALL_WIDTH_M = 3 // 东西方向
var STALL_LENGTH_M = 6 // 南北方向

var mapView = {
  map: null,
  polygonLayer: null,
  ready: false,
  loading: false,
  // 是否处于框选状态：双击地图进入
  picking: false,
  // 框选时先记下的第一个角（右上角）
  pendingCorner: null
}

function el(id) {
  return document.getElementById(id)
}

// ---------- 和服务器通信 ----------

function api(action, payload) {
  return fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action, key: state.key }, payload || {}))
  })
    .then(function (res) {
      return res.text()
    })
    .then(function (text) {
      var data
      try {
        data = JSON.parse(text)
      } catch (err) {
        throw new Error('服务器返回的不是 JSON：' + text.slice(0, 200))
      }
      if (!data || typeof data.ok !== 'boolean') {
        throw new Error('返回格式异常')
      }
      if (!data.ok) {
        var error = new Error(data.msg || '操作失败')
        error.code = data.code
        throw error
      }
      return data.data
    })
    .catch(function (err) {
      if (err instanceof TypeError) {
        throw new Error('连不上本地服务器，确认 node admin/server.js 还在运行')
      }
      throw err
    })
}

// ---------- 顶部提示条 ----------

var bannerTimer = null

function showBanner(text, kind) {
  var box = el('banner')
  box.className = 'banner banner--' + (kind || 'info')
  box.textContent = text
  box.classList.remove('hidden')

  if (bannerTimer) clearTimeout(bannerTimer)
  // 成功提示一闪而过；出错的留久一点，但也别一直挡着界面，点一下能立刻关掉
  bannerTimer = setTimeout(hideBanner, kind === 'ok' ? 2000 : 6000)
}

function hideBanner() {
  el('banner').classList.add('hidden')
}

function flash(text) {
  showBanner(text, 'ok')
}

// ---------- 登录状态 ----------

function showLogin() {
  el('panel').classList.add('hidden')
  el('login').classList.remove('hidden')
  el('btnReload').classList.add('hidden')
  el('btnLogout').classList.add('hidden')
  el('keyInput').focus()
}

function enterPanel() {
  el('login').classList.add('hidden')
  el('panel').classList.remove('hidden')
  el('btnReload').classList.remove('hidden')
  el('btnLogout').classList.remove('hidden')
  loadZones()
}

function doLogin() {
  var key = el('keyInput').value.trim()
  if (!key) {
    showBanner('先输入后台密钥', 'error')
    return
  }

  state.key = key
  el('btnLogin').disabled = true

  api('ping')
    .then(function () {
      localStorage.setItem(KEY_STORAGE, key)
      el('keyInput').value = ''
      hideBanner()
      enterPanel()
    })
    .catch(function (err) {
      state.key = ''
      localStorage.removeItem(KEY_STORAGE)
      showBanner('登录失败：' + err.message, 'error')
    })
    .then(function () {
      el('btnLogin').disabled = false
    })
}

function doLogout() {
  state.key = ''
  state.zones = []
  localStorage.removeItem(KEY_STORAGE)
  hideBanner()
  showLogin()
}

// ---------- 区域列表 ----------

function loadZones() {
  var tbody = el('zoneRows')
  tbody.innerHTML = ''
  tbody.appendChild(emptyRow('加载中…'))

  api('zones.list')
    .then(function (zones) {
      state.zones = zones || []
      renderZones()
    })
    .catch(function (err) {
      state.zones = []
      renderZones()
      showBanner('读取区域失败：' + err.message, 'error')
    })
}

function emptyRow(text) {
  var tr = document.createElement('tr')
  var td = document.createElement('td')
  td.colSpan = 6
  td.className = 'empty'
  td.textContent = text
  tr.appendChild(td)
  return tr
}

function renderZones() {
  var tbody = el('zoneRows')
  tbody.innerHTML = ''
  el('countText').textContent = '共 ' + state.zones.length + ' 个区域'

  if (state.zones.length === 0) {
    tbody.appendChild(emptyRow('还没有区域，点左上角「新增区域」开始'))
    return
  }

  state.zones.forEach(function (zone) {
    tbody.appendChild(buildRow(zone))
  })
}

function textCell(text) {
  var td = document.createElement('td')
  td.textContent = text
  return td
}

function coordCell(point) {
  var td = document.createElement('td')
  td.className = 'coords'
  if (point && isFinite(point.latitude) && isFinite(point.longitude)) {
    td.textContent = point.latitude.toFixed(5) + ', ' + point.longitude.toFixed(5)
  } else {
    td.textContent = '—'
  }
  return td
}

function smallButton(label, className, onClick) {
  var btn = document.createElement('button')
  btn.className = 'btn btn--small' + (className ? ' ' + className : '')
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
}

function buildRow(zone) {
  var tr = document.createElement('tr')
  var visible = zone.is_visible !== false

  var nameTd = document.createElement('td')
  var main = document.createElement('div')
  main.textContent = zone.name_zh || '（未命名）'
  nameTd.appendChild(main)
  if (zone.name_en) {
    var sub = document.createElement('div')
    sub.className = 'muted'
    sub.textContent = zone.name_en
    nameTd.appendChild(sub)
  }
  tr.appendChild(nameTd)

  tr.appendChild(textCell(zone.business_hours || '—'))
  tr.appendChild(coordCell(zone.ne))
  tr.appendChild(coordCell(zone.sw))
  var statusTd = document.createElement('td')
  var tag = document.createElement('span')
  tag.className = 'tag ' + (visible ? 'tag--on' : 'tag--off')
  tag.textContent = visible ? '显示中' : '已下架'
  statusTd.appendChild(tag)
  tr.appendChild(statusTd)

  var opsTd = document.createElement('td')
  var ops = document.createElement('div')
  ops.className = 'table__ops-cell'
  ops.appendChild(smallButton('编辑', '', function () { openEditor(zone) }))
  ops.appendChild(smallButton('摊位', '', function () { openStallEditor(zone) }))
  ops.appendChild(smallButton(visible ? '下架' : '上架', '', function () { toggleVisible(zone) }))
  ops.appendChild(smallButton('删除', 'btn--danger', function () { removeZone(zone) }))
  opsTd.appendChild(ops)
  tr.appendChild(opsTd)

  return tr
}

// ---------- 编辑弹层 ----------

function openEditor(zone) {
  state.editingId = zone ? zone._id : null

  el('editorTitle').textContent = zone ? '编辑区域' : '新增区域'
  el('fNameZh').value = zone ? zone.name_zh || '' : ''
  el('fNameEn').value = zone ? zone.name_en || '' : ''
  el('fHours').value = zone ? zone.business_hours || '' : ''
  el('fVisible').checked = zone ? zone.is_visible !== false : true

  var ne = (zone && zone.ne) || {}
  var sw = (zone && zone.sw) || {}
  el('fNeLat').value = numberToText(ne.latitude)
  el('fNeLng').value = numberToText(ne.longitude)
  el('fSwLat').value = numberToText(sw.latitude)
  el('fSwLng').value = numberToText(sw.longitude)

  updateSizeHint()
  el('editor').classList.remove('hidden')
  el('fNameZh').focus()

  mapView.pendingCorner = null
  // 弹层显示之后再初始化地图，否则容器还没有真实尺寸，地图会渲染成一片空白
  openMapForZone(zone)
}

function closeEditor() {
  el('editor').classList.add('hidden')
  state.editingId = null
  mapView.pendingCorner = null
}

function numberToText(value) {
  return typeof value === 'number' && isFinite(value) ? String(value) : ''
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

function collectForm() {
  var payload = {
    name_zh: el('fNameZh').value.trim(),
    name_en: el('fNameEn').value.trim(),
    business_hours: el('fHours').value.trim(),
    is_visible: el('fVisible').checked,
    ne: {
      latitude: Number(el('fNeLat').value),
      longitude: Number(el('fNeLng').value)
    },
    sw: {
      latitude: Number(el('fSwLat').value),
      longitude: Number(el('fSwLng').value)
    }
  }
  if (state.editingId) payload._id = state.editingId
  return payload
}

/** 矩形实际尺寸，和小程序里 utils/geo.js 用的同一套算法 */
function rectSizeMeters(ne, sw) {
  var METERS_PER_DEGREE = 111320
  var dLat = Math.abs(ne.latitude - sw.latitude)
  var dLng = Math.abs(ne.longitude - sw.longitude)
  var midLat = (ne.latitude + sw.latitude) / 2
  return {
    height: Math.round(dLat * METERS_PER_DEGREE),
    width: Math.round(dLng * METERS_PER_DEGREE * Math.cos((midLat * Math.PI) / 180))
  }
}

/**
 * 检查表单。返回 { error } 或 { payload, size, small }
 *
 * forSave 为 true 时才会检查中文名称——因为画矩形的时候名字往往还没填，
 * 那时候提示"名称不能为空"只会干扰。
 *
 * 坐标填反属于硬错误，直接拦住；区域过小只提示，不拦，
 * 万一你真有个很小的区域呢。
 */
function evaluate(forSave) {
  var payload = collectForm()

  if (forSave && !payload.name_zh) return { error: '中文名称不能为空' }

  var fields = [
    { label: '东北角纬度', inputId: 'fNeLat', value: payload.ne.latitude },
    { label: '东北角经度', inputId: 'fNeLng', value: payload.ne.longitude },
    { label: '西南角纬度', inputId: 'fSwLat', value: payload.sw.latitude },
    { label: '西南角经度', inputId: 'fSwLng', value: payload.sw.longitude }
  ]
  for (var i = 0; i < fields.length; i++) {
    var raw = el(fields[i].inputId).value.trim()
    if (!raw || !isFinite(fields[i].value)) {
      return { error: fields[i].label + '要填数字' }
    }
  }

  if (payload.ne.latitude <= payload.sw.latitude) {
    return { error: '东北角的纬度必须大于西南角的纬度，现在是反的' }
  }
  if (payload.ne.longitude <= payload.sw.longitude) {
    return { error: '东北角的经度必须大于西南角的经度，现在是反的' }
  }

  var size = rectSizeMeters(payload.ne, payload.sw)
  return {
    payload: payload,
    size: size,
    small: size.width < 20 || size.height < 20
  }
}

function updateSizeHint() {
  var box = el('sizeHint')
  var result = evaluate(false)

  if (result.error) {
    box.className = 'hintbox hintbox--error'
    box.textContent = result.error
    return
  }

  var text =
    '矩形尺寸：东西约 ' + result.size.width + ' 米，南北约 ' + result.size.height + ' 米'

  if (result.small) {
    box.className = 'hintbox'
    box.textContent = text + '。这个尺寸偏小，正常夜市区域至少几十米，确认一下坐标没抄错。'
    return
  }

  box.className = 'hintbox hintbox--ok'
  box.textContent = text
}

function save() {
  var result = evaluate(true)
  if (result.error) {
    showBanner(result.error, 'error')
    updateSizeHint()
    return
  }

  var action = state.editingId ? 'zones.update' : 'zones.create'
  el('btnSave').disabled = true

  api(action, result.payload)
    .then(function () {
      hideBanner()
      closeEditor()
      loadZones()
      flash('已保存')
    })
    .catch(function (err) {
      showBanner('保存失败：' + err.message, 'error')
    })
    .then(function () {
      el('btnSave').disabled = false
    })
}

// ---------- 行内操作 ----------

function zoneToPayload(zone, overrides) {
  return Object.assign(
    {
      _id: zone._id,
      name_zh: zone.name_zh,
      name_en: zone.name_en,
      business_hours: zone.business_hours,
      is_visible: zone.is_visible !== false,
      ne: zone.ne,
      sw: zone.sw
    },
    overrides || {}
  )
}

function toggleVisible(zone) {
  var next = !(zone.is_visible !== false)
  api('zones.update', zoneToPayload(zone, { is_visible: next }))
    .then(function () {
      loadZones()
      flash(next ? '已上架' : '已下架')
    })
    .catch(function (err) {
      showBanner('操作失败：' + err.message, 'error')
    })
}

function removeZone(zone) {
  var name = zone.name_zh || '这个区域'
  if (!window.confirm('确定删除「' + name + '」吗？\n\n删除后小程序上立刻消失，而且无法恢复。')) return

  api('zones.delete', { _id: zone._id })
    .then(function () {
      loadZones()
      flash('已删除')
    })
    .catch(function (err) {
      showBanner('删除失败：' + err.message, 'error')
    })
}

// ---------- 示例数据 ----------

function seedDemo() {
  var okToSeed = window.confirm(
    '生成示例数据？\n\n会先清掉上一批示例数据，再新建 6 个夜市和一批评分。\n你自己录的区域和评分不受影响。'
  )
  if (!okToSeed) return

  el('btnSeedDemo').disabled = true
  api('demo.seed')
    .then(function (res) {
      loadZones()
      flash('已生成 ' + res.zones + ' 个示例夜市、' + res.ratings + ' 条评分')
    })
    .catch(function (err) {
      showBanner('生成失败：' + err.message, 'error')
    })
    .then(function () {
      el('btnSeedDemo').disabled = false
    })
}

function clearDemo() {
  var okToClear = window.confirm(
    '清除所有示例数据？\n\n只会删掉带示例标记的区域和评分，你自己录的不受影响。'
  )
  if (!okToClear) return

  el('btnClearDemo').disabled = true
  api('demo.clear')
    .then(function (res) {
      loadZones()
      flash('已清除 ' + res.zones + ' 个示例夜市、' + res.ratings + ' 条评分')
    })
    .catch(function (err) {
      showBanner('清除失败：' + err.message, 'error')
    })
    .then(function () {
      el('btnClearDemo').disabled = false
    })
}

// ---------- 地图 ----------

function setMapStatus(text, kind) {
  var box = el('mapStatus')
  box.className = 'mapstatus' + (kind ? ' mapstatus--' + kind : '')
  box.textContent = text
}

/** 动态加载腾讯地图脚本。key 不对或授权域名不匹配时，这里会给出明确原因 */
function loadTencentMapScript() {
  return new Promise(function (resolve, reject) {
    if (window.TMap && window.TMap.Map) {
      resolve()
      return
    }

    var key = window.ADMIN_MAP_KEY || ''
    if (!key) {
      reject(new Error('还没配置腾讯地图 key，见 admin/map.config.js'))
      return
    }

    var settled = false
    var script = document.createElement('script')
    script.src = MAP_SCRIPT_URL + encodeURIComponent(key)

    script.onload = function () {
      settled = true
      if (window.TMap && window.TMap.Map) {
        resolve()
      } else {
        reject(new Error('脚本加载了但 TMap 没出现——通常是 key 无效，或授权域名没包含当前地址'))
      }
    }
    script.onerror = function () {
      settled = true
      reject(new Error('脚本加载失败：检查网络，或 key 的授权域名是否包含当前地址'))
    }
    document.head.appendChild(script)

    setTimeout(function () {
      if (!settled) reject(new Error('脚本 10 秒内没加载完，检查网络'))
    }, 10000)
  })
}

// TMap 的 LatLng 既能当属性读也能当方法调，这里两种都兼容一下
function latOf(pos) {
  if (!pos) return NaN
  if (typeof pos.lat === 'number') return pos.lat
  if (typeof pos.getLat === 'function') return pos.getLat()
  return NaN
}

function lngOf(pos) {
  if (!pos) return NaN
  if (typeof pos.lng === 'number') return pos.lng
  if (typeof pos.getLng === 'function') return pos.getLng()
  return NaN
}

/**
 * 把地图的点击区分成单击和双击。
 *
 * 地图只会说"被点了"，不区分单击双击，而双击本身也是两次单击，
 * 所以这里用一个短延时兜一下：250 毫秒内来了第二下就当双击，
 * 同时把第一下压住不处理。
 *
 * 回调收到的 point 是 { latitude, longitude }；双击时传 null。
 */
function makeClickGate(handler) {
  var timer = null

  return function (evt) {
    if (timer) {
      clearTimeout(timer)
      timer = null
      handler(null)
      return
    }

    var pos = (evt && (evt.latLng || evt.latLngs)) || null
    if (Array.isArray(pos)) pos = pos[0]

    var lat = latOf(pos)
    var lng = lngOf(pos)
    if (!isFinite(lat) || !isFinite(lng)) return

    var point = { latitude: lat, longitude: lng }
    timer = setTimeout(function () {
      timer = null
      handler(point)
    }, 250)
  }
}

function openMapForZone(zone) {
  if (mapView.ready) {
    focusMapOnZone(zone)
    syncMapFromForm()
    return
  }
  if (mapView.loading) return
  mapView.loading = true

  setMapStatus('地图加载中…')

  // 等一帧，让弹层的布局先算完
  setTimeout(function () {
    loadTencentMapScript()
      .then(function () {
        createMap()
        mapView.ready = true
        mapView.loading = false
        setMapStatus('地图就绪。双击地图开始框选，然后点一下选右上角、再点一下选左下角。', 'ok')
        focusMapOnZone(zone)
        syncMapFromForm()
      })
      .catch(function (err) {
        mapView.loading = false
        setMapStatus('地图没能加载：' + err.message + '。不影响使用，继续手填经纬度即可。', 'error')
      })
  }, 0)
}

function createMap() {
  mapView.map = new TMap.Map(el('mapContainer'), {
    center: new TMap.LatLng(DEFAULT_CENTER.latitude, DEFAULT_CENTER.longitude),
    zoom: 14,
    pitch: 0,
    rotation: 0
  })

  mapView.map.on('click', makeClickGate(onZoneMapClick))

  mapView.polygonLayer = new TMap.MultiPolygon({
    map: mapView.map,
    styles: {
      rect: new TMap.PolygonStyle({
        color: 'rgba(34, 197, 94, 0.30)',
        borderColor: '#15803D',
        borderWidth: 2
      })
    },
    geometries: []
  })
}

/** 把地图视野移到这个区域上。没有坐标就用默认的钟楼中心 */
function focusMapOnZone(zone) {
  if (!mapView.ready) return

  var ne = zone && zone.ne
  var sw = zone && zone.sw
  var lat = DEFAULT_CENTER.latitude
  var lng = DEFAULT_CENTER.longitude
  var zoom = 14

  if (ne && sw && isFinite(ne.latitude) && isFinite(sw.latitude) && isFinite(ne.longitude) && isFinite(sw.longitude)) {
    lat = (ne.latitude + sw.latitude) / 2
    lng = (ne.longitude + sw.longitude) / 2
    zoom = 16
  }

  mapView.map.setCenter(new TMap.LatLng(lat, lng))
  mapView.map.setZoom(zoom)
}

/** 只判断坐标本身能不能画出一个矩形，不管名称之类的东西 */
function coordinatesOfForm() {
  var payload = collectForm()
  var ne = payload.ne
  var sw = payload.sw

  var ok =
    isFinite(ne.latitude) &&
    isFinite(ne.longitude) &&
    isFinite(sw.latitude) &&
    isFinite(sw.longitude) &&
    ne.latitude > sw.latitude &&
    ne.longitude > sw.longitude

  return { ne: ne, sw: sw, ok: ok }
}

/** 按表单里的坐标重画矩形和四个角 */
function syncMapFromForm() {
  if (!mapView.ready) return

  var coords = coordinatesOfForm()
  if (!coords.ok) {
    mapView.polygonLayer.setGeometries([])
    return
  }

  var ne = coords.ne
  var sw = coords.sw

  mapView.polygonLayer.setGeometries([
    {
      id: 'rect',
      styleId: 'rect',
      paths: [
        [
          new TMap.LatLng(ne.latitude, sw.longitude),
          new TMap.LatLng(ne.latitude, ne.longitude),
          new TMap.LatLng(sw.latitude, ne.longitude),
          new TMap.LatLng(sw.latitude, sw.longitude)
        ]
      ]
    }
  ])
}

/** 在地图上点两下框出区域：第一下是一个角，第二下是斜对面那个角 */
/**
 * 地图点击。point 为 null 表示双击。
 *
 * 交互约定（和用户对齐过）：
 *   双击       → 清空坐标，进入框选状态
 *   单击第一下  → 选右上角
 *   单击第二下  → 选左下角，框选完成
 *   再双击      → 重来
 */
function onZoneMapClick(point) {
  if (!mapView.ready) return

  if (!point) {
    mapView.pendingCorner = null
    mapView.picking = true
    el('fNeLat').value = ''
    el('fNeLng').value = ''
    el('fSwLat').value = ''
    el('fSwLng').value = ''
    updateSizeHint()
    syncMapFromForm()
    setMapStatus('已清空。点一下地图选右上角。', 'ok')
    return
  }

  if (!mapView.picking) {
    setMapStatus('想重新框选，先在地图上双击。', '')
    return
  }

  if (!mapView.pendingCorner) {
    mapView.pendingCorner = point
    el('fNeLat').value = String(round6(point.latitude))
    el('fNeLng').value = String(round6(point.longitude))
    updateSizeHint()
    syncMapFromForm()
    setMapStatus('右上角已选。再点一下地图选左下角。', 'ok')
    return
  }

  var first = mapView.pendingCorner
  mapView.pendingCorner = null
  mapView.picking = false

  fillCoordInputs(
    {
      latitude: Math.max(first.latitude, point.latitude),
      longitude: Math.max(first.longitude, point.longitude)
    },
    {
      latitude: Math.min(first.latitude, point.latitude),
      longitude: Math.min(first.longitude, point.longitude)
    }
  )

  updateSizeHint()
  syncMapFromForm()
  setMapStatus('框好了。想重来就再双击地图。', 'ok')
}

function fillCoordInputs(ne, sw) {
  el('fNeLat').value = String(round6(ne.latitude))
  el('fNeLng').value = String(round6(ne.longitude))
  el('fSwLat').value = String(round6(sw.latitude))
  el('fSwLng').value = String(round6(sw.longitude))
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

/** 表单任何一项变了：刷新尺寸提示，同时把地图上的方框重新画一遍 */
function onFormChanged() {
  updateSizeHint()
  syncMapFromForm()
}

// ---------- 摊位编辑 ----------

var stallView = {
  map: null,
  polygonLayer: null,
  ready: false,
  readyPromise: null,
  zone: null,
  stalls: [],
  selectedId: '',
  // 价目表：界面上是若干行输入框，这里存对应的数据
  priceItems: [],
  // 是否处于"鼠标跟着走、等着落点"的放置状态：双击地图进入
  placing: false,
  // 右键旋转过没有（2×3 转成 3×2）
  rotated: false,
  // 最近一次鼠标位置，旋转时用它重算
  anchor: null,
  // 黄色的预览框，来自鼠标位置或者表单里的坐标
  draftNe: null,
  draftSw: null
}

function setStallStatus(text, kind) {
  var box = el('stallMapStatus')
  box.className = 'mapstatus' + (kind ? ' mapstatus--' + kind : '')
  box.textContent = text
}

/** 矩形的四个顶点，腾讯地图的多边形要的是闭合环 */
function tmapRectPath(ne, sw) {
  return [
    new TMap.LatLng(ne.latitude, sw.longitude),
    new TMap.LatLng(ne.latitude, ne.longitude),
    new TMap.LatLng(sw.latitude, ne.longitude),
    new TMap.LatLng(sw.latitude, sw.longitude)
  ]
}

function ensureStallMap() {
  if (stallView.ready) return Promise.resolve()
  if (stallView.readyPromise) return stallView.readyPromise

  setStallStatus('地图加载中…')

  stallView.readyPromise = loadTencentMapScript()
    .then(function () {
      stallView.map = new TMap.Map(el('stallMapContainer'), {
        center: new TMap.LatLng(DEFAULT_CENTER.latitude, DEFAULT_CENTER.longitude),
        zoom: 17,
        pitch: 0,
        rotation: 0
      })

      stallView.map.on('click', makeClickGate(onStallMapClick))
      stallView.map.on('mousemove', onStallMapMove)
      stallView.map.on('rightclick', onStallMapRightClick)

      // 放置摊位时要用右键旋转，得先把浏览器自己的右键菜单挡掉
      el('stallMapContainer').addEventListener('contextmenu', function (e) {
        if (stallView.placing) e.preventDefault()
      })

      stallView.polygonLayer = new TMap.MultiPolygon({
        map: stallView.map,
        styles: {
          zone: new TMap.PolygonStyle({
            color: 'rgba(34, 197, 94, 0.18)',
            borderColor: '#15803D',
            borderWidth: 2
          }),
          stall: new TMap.PolygonStyle({
            color: 'rgba(249, 115, 22, 0.32)',
            borderColor: '#EA580C',
            borderWidth: 2
          }),
          stallActive: new TMap.PolygonStyle({
            color: 'rgba(249, 115, 22, 0.58)',
            borderColor: '#C2410C',
            borderWidth: 3
          }),
          // 黄色：还没保存的预览框
          draft: new TMap.PolygonStyle({
            color: 'rgba(250, 204, 21, 0.40)',
            borderColor: '#CA8A04',
            borderWidth: 2
          })
        },
        geometries: []
      })

      stallView.ready = true
      setStallStatus('地图就绪。点「新增摊位」然后在地图上点两下。', 'ok')
      return true
    })
    .catch(function (err) {
      stallView.readyPromise = null
      throw err
    })

  return stallView.readyPromise
}

function focusStallMap() {
  if (!stallView.ready || !stallView.zone) return

  var zone = stallView.zone
  if (!zone.ne || !zone.sw) return

  stallView.map.setCenter(
    new TMap.LatLng(
      (zone.ne.latitude + zone.sw.latitude) / 2,
      (zone.ne.longitude + zone.sw.longitude) / 2
    )
  )
  // 摊位是按实际尺寸画的（几米见方），17 级时只有几个像素宽，根本看不见。
  // 19 级差不多一米一像素，摊位才有个能看清的大小。想看得远就滚轮缩出去。
  stallView.map.setZoom(19)
}

function drawStallShapes() {
  if (!stallView.ready) return

  var geometries = []

  if (stallView.zone && stallView.zone.ne && stallView.zone.sw) {
    geometries.push({
      id: 'zone',
      styleId: 'zone',
      paths: [tmapRectPath(stallView.zone.ne, stallView.zone.sw)]
    })
  }

  stallView.stalls.forEach(function (stall) {
    if (!stall.ne || !stall.sw) return
    geometries.push({
      id: stall._id,
      styleId: stall._id === stallView.selectedId ? 'stallActive' : 'stall',
      paths: [tmapRectPath(stall.ne, stall.sw)]
    })
  })

  // 黄色的预览框：正在放置时来自鼠标位置，否则来自表单里填的坐标
  if (stallView.draftNe && stallView.draftSw) {
    geometries.push({
      id: 'draft',
      styleId: 'draft',
      paths: [tmapRectPath(stallView.draftNe, stallView.draftSw)]
    })
  }

  stallView.polygonLayer.setGeometries(geometries)
}

function openStallEditor(zone) {
  stallView.zone = zone
  stallView.selectedId = ''
  stallView.placing = false
  stallView.rotated = false
  stallView.anchor = null
  stallView.draftNe = null
  stallView.draftSw = null
  stallView.stalls = []

  el('stallZoneName').textContent = zone.name_zh || ''
  fillStallForm(null)
  showStallForm(false)
  renderStallList()
  el('stallEditor').classList.remove('hidden')

  // 弹层显示之后容器才有尺寸，地图不能在此之前创建
  setTimeout(function () {
    ensureStallMap()
      .then(function () {
        focusStallMap()
        drawStallShapes()
        setStallStatus('双击地图可以放置摊位位置。橙色是已保存的，黄色是正在放置的。', 'ok')
      })
      .catch(function (err) {
        setStallStatus('地图没能加载：' + err.message + '。摊位列表仍然能编辑，只是没法在地图上画框。', 'error')
      })
      .then(function () {
        loadStalls()
      })
  }, 0)
}

function closeStallEditor() {
  el('stallEditor').classList.add('hidden')
  stallView.zone = null
  stallView.selectedId = ''
  stallView.placing = false
  stallView.draftNe = null
  stallView.draftSw = null
  stallView.stalls = []
}

function loadStalls() {
  if (!stallView.zone) return Promise.resolve()

  return api('stalls.list', { zoneId: stallView.zone._id })
    .then(function (list) {
      stallView.stalls = list || []
      renderStallList()
      drawStallShapes()
    })
    .catch(function (err) {
      showBanner('读取摊位失败：' + err.message, 'error')
    })
}

function renderStallList() {
  var box = el('stallList')
  box.innerHTML = ''
  el('stallCountText').textContent = stallView.stalls.length ? '共 ' + stallView.stalls.length + ' 个' : ''

  if (!stallView.stalls.length) {
    var empty = document.createElement('div')
    empty.className = 'stall-list__empty'
    empty.textContent = '还没有摊位，点「新增摊位」开始画'
    box.appendChild(empty)
    return
  }

  stallView.stalls.forEach(function (stall) {
    var item = document.createElement('div')
    item.className =
      'stall-list__item' + (stall._id === stallView.selectedId ? ' stall-list__item--active' : '')

    var name = document.createElement('span')
    name.className = 'stall-list__name'
    name.textContent = stall.name_zh || '（未命名）'
    item.appendChild(name)

    var summary = priceSummary(stall.price_items)
    if (summary) {
      var price = document.createElement('span')
      price.className = 'stall-list__price'
      price.textContent = summary
      item.appendChild(price)
    }

    item.addEventListener('click', function () {
      selectStall(stall)
    })

    box.appendChild(item)
  })
}

/** 价目表在列表里只显示一个价格区间，省地方 */
function priceSummary(items) {
  if (!Array.isArray(items) || !items.length) return ''

  var prices = items
    .map(function (item) {
      return Number(item.price)
    })
    .filter(function (value) {
      return isFinite(value)
    })

  if (!prices.length) return ''

  var min = Math.min.apply(null, prices)
  var max = Math.max.apply(null, prices)
  return min === max ? min + ' 元' : min + '-' + max + ' 元'
}

function selectStall(stall) {
  stallView.selectedId = stall._id
  stallView.placing = false

  fillStallForm(stall)
  showStallForm(true)
  renderStallList()
  drawStallShapes()
  setStallStatus('正在编辑「' + (stall.name_zh || '') + '」。双击地图可以重新框选位置，改完记得保存。', 'ok')
}

function startNewStall() {
  // 填了一半又点新增，先问一声，别把内容弄丢了
  var hasDraft = el('sNameZh').value.trim() && !stallView.selectedId
  if (hasDraft && !window.confirm('当前填的内容还没保存，确定要重新开始吗？')) return

  stallView.selectedId = ''
  stallView.placing = false
  stallView.rotated = false
  stallView.anchor = null
  stallView.draftNe = null
  stallView.draftSw = null
  // 清掉旧的坐标，免得双击放置前的预览框停在上一处
  el('sNeLat').value = ''
  el('sNeLng').value = ''
  el('sSwLat').value = ''
  el('sSwLng').value = ''

  fillStallForm(null)
  showStallForm(true)
  renderStallList()
  drawStallShapes()
  el('sNameZh').focus()
  setStallStatus('双击地图开始放置：黄框跟着鼠标走，左键确定，右键旋转。', 'ok')
}

function showStallForm(show) {
  el('stallForm').classList.toggle('hidden', !show)
}

// ---------- 价目表 ----------
//
// 三种模板，可以混用（真实摊子经常既有系列又有增项）：
//   单品 一个菜一个价，可以带若干"搭配"，每种搭配单独标价
//   系列 一个烹饪系列一个统一价，系列下可选几种搭配，不单独标价
//   增项 加配菜之类的，每种单独一个价

var PRICE_KIND_LABELS = [
  { value: 'single', label: '单品' },
  { value: 'series', label: '系列' },
  { value: 'addon', label: '增项' }
]

function makeInput(className, placeholder, value) {
  var input = document.createElement('input')
  input.className = 'input ' + className
  input.type = 'text'
  input.placeholder = placeholder
  input.value = value === 0 || value ? String(value) : ''
  return input
}

function namePlaceholder(kind) {
  if (kind === 'series') return '蛋炒系列'
  if (kind === 'addon') return '加香肠'
  return '凉皮'
}

function renderPriceRows() {
  var box = el('priceRows')
  box.innerHTML = ''

  if (!stallView.priceItems.length) {
    var empty = document.createElement('div')
    empty.className = 'price-empty'
    empty.textContent = '还没有价目。上面三个按钮对应三种模板。'
    box.appendChild(empty)
    return
  }

  stallView.priceItems.forEach(function (item, index) {
    box.appendChild(buildPriceBlock(item, index))
  })
}

function buildPriceBlock(item, index) {
  var kind = item.kind || 'single'

  var block = document.createElement('div')
  block.className = 'price-block'

  var head = document.createElement('div')
  head.className = 'price-block__head'

  var select = document.createElement('select')
  select.className = 'input price-block__kind js-kind'
  PRICE_KIND_LABELS.forEach(function (option) {
    var node = document.createElement('option')
    node.value = option.value
    node.textContent = option.label
    if (option.value === kind) node.selected = true
    select.appendChild(node)
  })
  select.addEventListener('change', function () {
    readPriceRows()
    stallView.priceItems[index].kind = select.value
    // 换类型要重画：搭配那段显示不显示、要不要标价都不一样
    renderPriceRows()
    updateStallSizeHint()
  })
  head.appendChild(select)

  var remove = document.createElement('button')
  remove.className = 'price-block__remove'
  remove.type = 'button'
  remove.textContent = '×'
  remove.title = '删掉这一条'
  remove.addEventListener('click', function () {
    readPriceRows()
    stallView.priceItems.splice(index, 1)
    renderPriceRows()
    updateStallSizeHint()
  })
  head.appendChild(remove)
  block.appendChild(head)

  var main = document.createElement('div')
  main.className = 'price-block__main'
  main.appendChild(makeInput('js-name-zh', namePlaceholder(kind), item.name_zh))
  main.appendChild(makeInput('js-name-en', '拼音或英文', item.name_en))
  // 单品没有统一价，价格全在搭配上
  if (kind !== 'single') {
    main.appendChild(makeInput('js-price', kind === 'series' ? '统一价' : '价格', item.price))
  }
  block.appendChild(main)

  // 增项只是加个配菜，不需要小字说明
  if (kind !== 'addon') {
    block.appendChild(makeInput('js-note', '小字：烹饪方式、主要食材', item.note_zh))
  }

  if (kind !== 'addon') {
    block.appendChild(buildOptions(item.options || [], kind, index))
  }

  return block
}

function buildOptions(options, kind, blockIndex) {
  var wrap = document.createElement('div')
  wrap.className = 'price-options'

  var label = document.createElement('div')
  label.className = 'price-options__label'
  label.textContent =
    kind === 'series' ? '这个系列可以选的（价格用上面的统一价）' : '搭配（每种单独标价）'
  wrap.appendChild(label)

  options.forEach(function (option, optionIndex) {
    var row = document.createElement('div')
    row.className = 'price-option js-option'
    row.appendChild(
      makeInput('js-opt-name-zh', kind === 'series' ? '炒饼' : '加肉', option.name_zh)
    )
    row.appendChild(makeInput('js-opt-name-en', '拼音或英文', option.name_en))
    if (kind === 'single') {
      row.appendChild(makeInput('js-opt-price', '价格', option.price))
    }

    var remove = document.createElement('button')
    remove.className = 'price-block__remove'
    remove.type = 'button'
    remove.textContent = '×'
    remove.title = '删掉这个搭配'
    remove.addEventListener('click', function () {
      readPriceRows()
      stallView.priceItems[blockIndex].options.splice(optionIndex, 1)
      renderPriceRows()
      updateStallSizeHint()
    })
    row.appendChild(remove)

    wrap.appendChild(row)
  })

  var add = document.createElement('button')
  add.className = 'btn btn--small'
  add.type = 'button'
  add.textContent = '+ 搭配'
  add.addEventListener('click', function () {
    readPriceRows()
    stallView.priceItems[blockIndex].options.push({ name_zh: '', name_en: '', price: '' })
    renderPriceRows()
    updateStallSizeHint()
  })
  wrap.appendChild(add)

  return wrap
}

/** 把界面上填的价目读回内存。删条目、加条目、保存之前都要先调一次 */
function readPriceRows() {
  var blocks = el('priceRows').querySelectorAll('.price-block')
  var items = []

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i]
    var options = []
    var optionRows = block.querySelectorAll('.js-option')

    for (var j = 0; j < optionRows.length; j++) {
      var optionRow = optionRows[j]
      var option = {
        name_zh: optionRow.querySelector('.js-opt-name-zh').value.trim(),
        name_en: optionRow.querySelector('.js-opt-name-en').value.trim()
      }
      var optionPrice = optionRow.querySelector('.js-opt-price')
      if (optionPrice) option.price = optionPrice.value.trim()
      options.push(option)
    }

    var priceEl = block.querySelector('.js-price')
    var noteEl = block.querySelector('.js-note')

    items.push({
      kind: block.querySelector('.js-kind').value,
      name_zh: block.querySelector('.js-name-zh').value.trim(),
      name_en: block.querySelector('.js-name-en').value.trim(),
      price: priceEl ? priceEl.value.trim() : '',
      note_zh: noteEl ? noteEl.value.trim() : '',
      options: options
    })
  }

  stallView.priceItems = items
  return items
}

function addPriceBlock(kind) {
  readPriceRows()
  stallView.priceItems.push({
    kind: kind,
    name_zh: '',
    name_en: '',
    price: '',
    note_zh: '',
    options: kind === 'addon' ? [] : [{ name_zh: '', name_en: '', price: '' }]
  })
  renderPriceRows()

  var blocks = el('priceRows').querySelectorAll('.price-block')
  var last = blocks[blocks.length - 1]
  if (last) last.querySelector('.js-name-zh').focus()
}

function isGoodPrice(text) {
  var value = Number(text)
  return !!text && isFinite(value) && value >= 0
}

/**
 * 检查价目表。整条空着的会跳过，填了名字却没填对价格的会报错——
 * 那种情况一般是填漏了，静默丢掉比报错更糟。
 */
function validatePriceItems(items) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    var options = item.options || []
    var hasOptions = options.some(function (option) {
      return option.name_zh || option.name_en || option.price
    })

    if (!item.name_zh && !item.name_en && !item.price && !item.note_zh && !hasOptions) continue
    if (!item.name_zh) return '价目表第 ' + (i + 1) + ' 条没填名称'

    // 单品不设统一价，所以只检查系列和增项
    if (item.kind !== 'single' && !isGoodPrice(item.price)) {
      return '价目表第 ' + (i + 1) + ' 条的价格不是有效数字'
    }

    if (item.kind === 'single') {
      for (var j = 0; j < options.length; j++) {
        var option = options[j]
        if (!option.name_zh && !option.name_en && !option.price) continue
        if (!option.name_zh) return '价目表第 ' + (i + 1) + ' 条的搭配没填名字'
        if (!isGoodPrice(option.price)) {
          return '价目表第 ' + (i + 1) + ' 条的搭配「' + option.name_zh + '」没填对价格'
        }
      }
    }
  }
  return ''
}

function fillStallForm(stall) {
  el('sNameZh').value = stall ? stall.name_zh || '' : ''
  el('sNameEn').value = stall ? stall.name_en || '' : ''
  var items = (stall && Array.isArray(stall.price_items) ? stall.price_items : []).map(function (item) {
    return {
      kind: item.kind || 'single',
      name_zh: item.name_zh || '',
      name_en: item.name_en || '',
      price: item.price === 0 || item.price ? String(item.price) : '',
      note_zh: item.note_zh || '',
      options: (Array.isArray(item.options) ? item.options : []).map(function (option) {
        return {
          name_zh: option.name_zh || '',
          name_en: option.name_en || '',
          price: option.price === 0 || option.price ? String(option.price) : ''
        }
      })
    }
  })
  // 新建时先给一条空白的单品
  stallView.priceItems = items.length
    ? items
    : [{ kind: 'single', name_zh: '', name_en: '', price: '', note_zh: '', options: [] }]
  renderPriceRows()

  var ne = (stall && stall.ne) || {}
  var sw = (stall && stall.sw) || {}
  el('sNeLat').value = numberToText(ne.latitude)
  el('sNeLng').value = numberToText(ne.longitude)
  el('sSwLat').value = numberToText(sw.latitude)
  el('sSwLng').value = numberToText(sw.longitude)

  el('stallFormLegend').textContent = stall ? '正在编辑：' + (stall.name_zh || '') : '新增摊位'
  el('btnDeleteStall').disabled = !stall

  updateStallSizeHint()
}

function evaluateStallForm() {
  var nameZh = el('sNameZh').value.trim()
  if (!nameZh) return { error: '摊位名称不能为空' }

  var fields = [
    { label: '东北角纬度', inputId: 'sNeLat' },
    { label: '东北角经度', inputId: 'sNeLng' },
    { label: '西南角纬度', inputId: 'sSwLat' },
    { label: '西南角经度', inputId: 'sSwLng' }
  ]

  var values = {}
  for (var i = 0; i < fields.length; i++) {
    var raw = el(fields[i].inputId).value.trim()
    var value = Number(raw)
    if (!raw || !isFinite(value)) return { error: fields[i].label + '要填数字' }
    values[fields[i].inputId] = value
  }

  var ne = { latitude: values.sNeLat, longitude: values.sNeLng }
  var sw = { latitude: values.sSwLat, longitude: values.sSwLng }

  if (ne.latitude <= sw.latitude) {
    return { error: '东北角的纬度必须大于西南角的纬度，现在是反的' }
  }
  if (ne.longitude <= sw.longitude) {
    return { error: '东北角的经度必须大于西南角的经度，现在是反的' }
  }

  var priceItems = readPriceRows()
  var priceError = validatePriceItems(priceItems)
  if (priceError) return { error: priceError }

  return {
    payload: {
      name_zh: nameZh,
      name_en: el('sNameEn').value.trim(),
      price_items: priceItems.filter(function (item) {
        return item.name_zh || item.name_en || item.price
      }),
      ne: ne,
      sw: sw
    },
    size: rectSizeMeters(ne, sw)
  }
}

function updateStallSizeHint() {
  refreshDraft()
  drawStallShapes()

  var box = el('stallSizeHint')
  var result = evaluateStallForm()

  if (result.error) {
    box.className = 'hintbox'
    box.textContent = result.error
    return
  }

  box.className = 'hintbox hintbox--ok'
  box.textContent =
    '摊位尺寸：东西约 ' + result.size.width + ' 米，南北约 ' + result.size.height + ' 米'
}

// ---------- 摊位位置的放置 ----------

function metersToLatDegrees(meters) {
  return meters / 111320
}

function metersToLngDegrees(meters, latitude) {
  return meters / (111320 * Math.cos((latitude * Math.PI) / 180))
}

/**
 * 由鼠标位置算出摊位矩形。
 *
 * 约定：鼠标位置是摊位的**右下角**（东南角）。
 * 没旋转时东西 2 米、南北 3 米；旋转后两者互换。
 */
function rectFromAnchor(anchor, rotated) {
  var widthM = rotated ? STALL_LENGTH_M : STALL_WIDTH_M
  var heightM = rotated ? STALL_WIDTH_M : STALL_LENGTH_M

  var south = anchor.latitude
  var east = anchor.longitude

  return {
    ne: {
      latitude: south + metersToLatDegrees(heightM),
      longitude: east
    },
    sw: {
      latitude: south,
      longitude: east - metersToLngDegrees(widthM, south)
    }
  }
}

/** 只判断表单里的四个坐标能不能画出一个矩形，不管名称和价目 */
function coordinatesOfStallForm() {
  var fields = ['sNeLat', 'sNeLng', 'sSwLat', 'sSwLng']
  var values = {}

  for (var i = 0; i < fields.length; i++) {
    var raw = el(fields[i]).value.trim()
    var num = Number(raw)
    if (!raw || !isFinite(num)) return null
    values[fields[i]] = num
  }

  var ne = { latitude: values.sNeLat, longitude: values.sNeLng }
  var sw = { latitude: values.sSwLat, longitude: values.sSwLng }

  if (ne.latitude <= sw.latitude || ne.longitude <= sw.longitude) return null
  return { ne: ne, sw: sw }
}

/** 不在放置状态时，预览框跟着表单里的坐标走 */
function refreshDraft() {
  if (stallView.placing) return

  var coords = coordinatesOfStallForm()
  stallView.draftNe = coords ? coords.ne : null
  stallView.draftSw = coords ? coords.sw : null
}

function startPlacing() {
  stallView.placing = true
  stallView.rotated = false
  stallView.anchor = null
  stallView.draftNe = null
  stallView.draftSw = null
  drawStallShapes()
  setStallStatus('移动鼠标选位置（鼠标是摊位的右下角），左键点一下确定，右键旋转 90°。', 'ok')
}

function confirmPlacement(point) {
  stallView.placing = false
  stallView.anchor = point

  var rect = rectFromAnchor(point, stallView.rotated)
  stallView.draftNe = rect.ne
  stallView.draftSw = rect.sw

  el('sNeLat').value = String(round6(rect.ne.latitude))
  el('sNeLng').value = String(round6(rect.ne.longitude))
  el('sSwLat').value = String(round6(rect.sw.latitude))
  el('sSwLng').value = String(round6(rect.sw.longitude))

  updateStallSizeHint()
  drawStallShapes()
  el('sNameZh').focus()
  setStallStatus('位置已放好（黄色框就是它）。填上名称和价目再保存，想挪位置就再双击地图。', 'ok')
}

/** 鼠标在动时，黄框跟着走 */
function onStallMapMove(evt) {
  if (!stallView.placing) return

  var pos = (evt && (evt.latLng || evt.latLngs)) || null
  if (Array.isArray(pos)) pos = pos[0]

  var lat = latOf(pos)
  var lng = lngOf(pos)
  if (!isFinite(lat) || !isFinite(lng)) return

  stallView.anchor = { latitude: lat, longitude: lng }

  var rect = rectFromAnchor(stallView.anchor, stallView.rotated)
  stallView.draftNe = rect.ne
  stallView.draftSw = rect.sw
  drawStallShapes()
}

/** 右键把摊位转 90 度 */
function onStallMapRightClick() {
  if (!stallView.placing) return

  stallView.rotated = !stallView.rotated

  if (stallView.anchor) {
    var rect = rectFromAnchor(stallView.anchor, stallView.rotated)
    stallView.draftNe = rect.ne
    stallView.draftSw = rect.sw
    drawStallShapes()
  }

  setStallStatus(
    stallView.rotated
      ? '已旋转：东西 3 米 × 南北 2 米。左键确定位置。'
      : '已旋转：东西 2 米 × 南北 3 米。左键确定位置。',
    'ok'
  )
}

/**
 * 摊位地图的点击。point 为 null 表示双击。
 *
 * 交互约定：
 *   双击       → 进入放置状态，黄框跟着鼠标走
 *   左键点一下  → 确定位置
 *   右键       → 旋转 90°
 */
function onStallMapClick(point) {
  if (!stallView.ready) return

  if (!point) {
    if (el('stallForm').classList.contains('hidden')) {
      setStallStatus('先点「新增摊位」，或者从左边选一个摊位，才能放位置。', '')
      return
    }
    startPlacing()
    return
  }

  if (stallView.placing) {
    confirmPlacement(point)
    return
  }

  setStallStatus('要挪摊位位置，先在地图上双击。', '')
}

function saveStall() {
  var result = evaluateStallForm()
  if (result.error) {
    showBanner(result.error, 'error')
    updateStallSizeHint()
    return
  }

  var payload = Object.assign({ zoneId: stallView.zone._id }, result.payload)
  var action = 'stalls.create'
  if (stallView.selectedId) {
    action = 'stalls.update'
    payload._id = stallView.selectedId
  }

  el('btnSaveStall').disabled = true

  api(action, payload)
    .then(function (res) {
      if (res && res._id) stallView.selectedId = res._id
      flash('已保存')
      return loadStalls()
    })
    .then(function () {
      var current = stallView.stalls.filter(function (stall) {
        return stall._id === stallView.selectedId
      })[0]
      if (current) fillStallForm(current)
      renderStallList()
      drawStallShapes()
    })
    .catch(function (err) {
      showBanner('保存失败：' + err.message, 'error')
    })
    .then(function () {
      el('btnSaveStall').disabled = false
    })
}

function removeStall() {
  var current = stallView.stalls.filter(function (stall) {
    return stall._id === stallView.selectedId
  })[0]
  if (!current) return

  var name = current.name_zh || '这个摊位'
  if (!window.confirm('删除「' + name + '」？\n\n小程序上立刻消失，投票记录会保留。')) return

  api('stalls.delete', { _id: current._id })
    .then(function () {
      stallView.selectedId = ''
      fillStallForm(null)
      flash('已删除')
      return loadStalls()
    })
    .catch(function (err) {
      showBanner('删除失败：' + err.message, 'error')
    })
}

// ---------- 启动 ----------

function bindEvents() {
  el('banner').addEventListener('click', hideBanner)

  el('btnLogin').addEventListener('click', doLogin)
  el('keyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin()
  })

  el('btnReload').addEventListener('click', loadZones)
  el('btnLogout').addEventListener('click', doLogout)
  el('btnNew').addEventListener('click', function () { openEditor(null) })
  el('btnSeedDemo').addEventListener('click', seedDemo)
  el('btnClearDemo').addEventListener('click', clearDemo)

  el('btnCancel').addEventListener('click', closeEditor)
  el('btnSave').addEventListener('click', save)
  el('editor').addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.close) closeEditor()
  })

  el('btnNewStall').addEventListener('click', startNewStall)
  el('btnAddSingle').addEventListener('click', function () { addPriceBlock('single') })
  el('btnAddSeries').addEventListener('click', function () { addPriceBlock('series') })
  el('btnAddAddon').addEventListener('click', function () { addPriceBlock('addon') })
  el('btnSaveStall').addEventListener('click', saveStall)
  el('btnDeleteStall').addEventListener('click', removeStall)
  el('btnCloseStall').addEventListener('click', closeStallEditor)
  el('stallEditor').addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.closeStall) closeStallEditor()
  })
  ;['sNeLat', 'sNeLng', 'sSwLat', 'sSwLng', 'sNameZh'].forEach(function (id) {
    el(id).addEventListener('input', updateStallSizeHint)
  })

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    if (!el('stallEditor').classList.contains('hidden')) {
      closeStallEditor()
      return
    }
    if (!el('editor').classList.contains('hidden')) closeEditor()
  })

  ;['fNameZh', 'fNeLat', 'fNeLng', 'fSwLat', 'fSwLng'].forEach(function (id) {
    el(id).addEventListener('input', onFormChanged)
  })
}

function boot() {
  bindEvents()

  var savedKey = localStorage.getItem(KEY_STORAGE) || ''
  if (!savedKey) {
    showLogin()
    return
  }

  // 有存过的密钥，先悄悄验一次，省得每次都要重新输
  state.key = savedKey
  api('ping')
    .then(function () {
      enterPanel()
    })
    .catch(function (err) {
      state.key = ''
      showLogin()
      showBanner('自动登录失败：' + err.message, 'error')
    })
}

boot()
