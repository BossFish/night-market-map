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

var mapView = {
  map: null,
  polygonLayer: null,
  ready: false,
  loading: false,
  // 点两下框区域时，先记下的第一个角
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
  if (kind === 'ok') {
    bannerTimer = setTimeout(hideBanner, 2500)
  }
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
  td.colSpan = 7
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
  tr.appendChild(textCell(String(zone.sort_order == null ? 0 : zone.sort_order)))

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
  el('fSort').value = zone ? (zone.sort_order == null ? 0 : zone.sort_order) : state.zones.length + 1
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
    sort_order: Number(el('fSort').value) || 0,
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
      sort_order: zone.sort_order,
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
        setMapStatus('地图就绪。在地图上点两下就能框出区域。', 'ok')
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

  mapView.map.on('click', onMapClick)

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
function onMapClick(evt) {
  if (!mapView.ready) return

  var pos = (evt && (evt.latLng || evt.latLngs)) || null
  if (Array.isArray(pos)) pos = pos[0]

  var lat = latOf(pos)
  var lng = lngOf(pos)

  if (!isFinite(lat) || !isFinite(lng)) {
    setMapStatus('点到了，但没能读出经纬度。用点两下的方式重画，或者直接手填坐标。', 'error')
    return
  }

  if (!mapView.pendingCorner) {
    mapView.pendingCorner = { latitude: lat, longitude: lng }
    setMapStatus('已记住第一个角。再点一下斜对面那个角，区域就框出来了。', 'ok')
    return
  }

  var first = mapView.pendingCorner
  var second = { latitude: lat, longitude: lng }
  mapView.pendingCorner = null

  // 不管先点哪两个角，都换算成东北角 + 西南角
  fillCoordInputs(
    {
      latitude: Math.max(first.latitude, second.latitude),
      longitude: Math.max(first.longitude, second.longitude)
    },
    {
      latitude: Math.min(first.latitude, second.latitude),
      longitude: Math.min(first.longitude, second.longitude)
    }
  )

  updateSizeHint()
  syncMapFromForm()
  setMapStatus('区域已框出。再点两下可以重画，也可以直接改左边的数字。', 'ok')
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
  // 点两下画摊位时先记下的第一个角
  pendingCorner: null,
  drawing: false
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

      stallView.map.on('click', onStallMapClick)

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
  // 17 级大概能看到五百米宽，正好放下一个夜市区域
  stallView.map.setZoom(17)
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

  stallView.polygonLayer.setGeometries(geometries)
}

function openStallEditor(zone) {
  stallView.zone = zone
  stallView.selectedId = ''
  stallView.pendingCorner = null
  stallView.drawing = false
  stallView.stalls = []

  el('stallZoneName').textContent = zone.name_zh || ''
  fillStallForm(null)
  renderStallList()
  el('stallEditor').classList.remove('hidden')

  // 弹层显示之后容器才有尺寸，地图不能在此之前创建
  setTimeout(function () {
    ensureStallMap()
      .then(function () {
        focusStallMap()
        drawStallShapes()
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
  stallView.pendingCorner = null
  stallView.drawing = false
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

    if (stall.price_range) {
      var price = document.createElement('span')
      price.className = 'stall-list__price'
      price.textContent = stall.price_range
      item.appendChild(price)
    }

    item.addEventListener('click', function () {
      selectStall(stall)
    })

    box.appendChild(item)
  })
}

function selectStall(stall) {
  stallView.selectedId = stall._id
  stallView.pendingCorner = null
  stallView.drawing = false

  fillStallForm(stall)
  renderStallList()
  drawStallShapes()
  setStallStatus('正在编辑「' + (stall.name_zh || '') + '」。改完记得点保存。', 'ok')
}

function startNewStall() {
  stallView.selectedId = ''
  stallView.pendingCorner = null
  stallView.drawing = true

  fillStallForm(null)
  renderStallList()
  drawStallShapes()
  setStallStatus('在地图上点两下框出摊位位置：先点一个角，再点斜对面那个角。', 'ok')
}

function fillStallForm(stall) {
  el('sNameZh').value = stall ? stall.name_zh || '' : ''
  el('sNameEn').value = stall ? stall.name_en || '' : ''
  el('sPrice').value = stall ? stall.price_range || '' : ''
  el('sSort').value = stall
    ? stall.sort_order == null
      ? 0
      : stall.sort_order
    : stallView.stalls.length + 1

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

  return {
    payload: {
      name_zh: nameZh,
      name_en: el('sNameEn').value.trim(),
      price_range: el('sPrice').value.trim(),
      sort_order: Number(el('sSort').value) || 0,
      ne: ne,
      sw: sw
    },
    size: rectSizeMeters(ne, sw)
  }
}

function updateStallSizeHint() {
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

function onStallMapClick(evt) {
  if (!stallView.drawing) return

  var pos = (evt && (evt.latLng || evt.latLngs)) || null
  if (Array.isArray(pos)) pos = pos[0]

  var lat = latOf(pos)
  var lng = lngOf(pos)
  if (!isFinite(lat) || !isFinite(lng)) return

  if (!stallView.pendingCorner) {
    stallView.pendingCorner = { latitude: lat, longitude: lng }
    setStallStatus('已记住第一个角。再点一下斜对面那个角。', 'ok')
    return
  }

  var first = stallView.pendingCorner
  var second = { latitude: lat, longitude: lng }
  stallView.pendingCorner = null
  stallView.drawing = false

  el('sNeLat').value = String(round6(Math.max(first.latitude, second.latitude)))
  el('sNeLng').value = String(round6(Math.max(first.longitude, second.longitude)))
  el('sSwLat').value = String(round6(Math.min(first.latitude, second.latitude)))
  el('sSwLng').value = String(round6(Math.min(first.longitude, second.longitude)))

  updateStallSizeHint()
  el('sNameZh').focus()
  setStallStatus('框好了。填个摊位名称，然后点保存。', 'ok')
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
