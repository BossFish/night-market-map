const i18n = require('./i18n/index')
const config = require('./config')

App({
  globalData: {
    lang: 'zh'
  },

  onLaunch() {
    this.initCloud()
    this.initLang()
  },

  initCloud() {
    if (!wx.cloud) {
      console.error('[cloud] 当前基础库不支持云开发，请把调试基础库调到 2.2.3 以上')
      return
    }
    const options = { traceUser: true }
    // config.js 里的环境 ID 留空时，使用小程序默认的云开发环境。
    // 如果以后建了第二个环境，就必须把 ID 填上，否则会连错。
    if (config.cloudEnvId) options.env = config.cloudEnvId
    wx.cloud.init(options)
  },

  initLang() {
    // 现阶段的语言逻辑只做「读缓存 + 兜底中文」。
    // 阶段12 会在这里补系统语言检测和正式的语言切换入口。
    const saved = wx.getStorageSync('lang')
    if (saved === 'zh' || saved === 'en') {
      this.globalData.lang = saved
    }
    i18n.setLang(this.globalData.lang)
  },

  setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return
    this.globalData.lang = lang
    i18n.setLang(lang)
    wx.setStorageSync('lang', lang)
  }
})
