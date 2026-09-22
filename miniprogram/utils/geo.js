// 一个纬度约 111320 米；经度要按当前纬度收缩
const METERS_PER_DEGREE = 111320

/**
 * 由东北 / 西南两个对角点算出矩形的 4 个顶点。
 * 数据库里只存 ne 和 sw，4 个顶点一律现算，避免两处坐标不一致。
 */
function rectToPoints(ne, sw) {
  const north = ne.latitude
  const east = ne.longitude
  const south = sw.latitude
  const west = sw.longitude
  return [
    { latitude: north, longitude: west },
    { latitude: north, longitude: east },
    { latitude: south, longitude: east },
    { latitude: south, longitude: west }
  ]
}

function rectCenter(ne, sw) {
  return {
    latitude: (ne.latitude + sw.latitude) / 2,
    longitude: (ne.longitude + sw.longitude) / 2
  }
}

/** 矩形的实际尺寸，用来检查画的框是不是合理大小 */
function rectSizeMeters(ne, sw) {
  const dLat = Math.abs(ne.latitude - sw.latitude)
  const dLng = Math.abs(ne.longitude - sw.longitude)
  const midLat = (ne.latitude + sw.latitude) / 2
  return {
    height: Math.round(dLat * METERS_PER_DEGREE),
    width: Math.round(dLng * METERS_PER_DEGREE * Math.cos((midLat * Math.PI) / 180))
  }
}

/**
 * 点是否落在矩形内。
 * 用途：万一 polygontap 事件没回传能识别区域的 polygonId，
 * 就用点击坐标反查是哪个区域。
 */
function pointInRect(point, ne, sw) {
  return (
    point.latitude <= ne.latitude &&
    point.latitude >= sw.latitude &&
    point.longitude <= ne.longitude &&
    point.longitude >= sw.longitude
  )
}

module.exports = { rectToPoints, rectCenter, rectSizeMeters, pointInRect }
