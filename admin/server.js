/**
 * 管理后台的本地小服务器。
 *
 * 为什么需要它：
 *   1. 网页双击打开是 file:// 协议，浏览器会拦截跨域请求；
 *   2. 云函数地址是 https，本地页面直接请求它需要对方配合 CORS，
 *      而云开发的 HTTP 访问服务不一定给得出合适的响应头。
 *
 * 让这个本地服务器当中间人，浏览器只跟 http://127.0.0.1 同源通信，
 * 跨域问题就整个消失了——服务器再以服务端身份去请求云函数，
 * 服务端之间没有同源策略这回事。
 *
 * 只用 Node 内置模块，不需要装任何依赖。
 * 启动：node admin/server.js
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const config = Object.assign(
  { cloudApiUrl: '', port: 8080 },
  safeRequire('./server.config.js')
)

// 允许用环境变量临时覆盖，测试或者临时连别的环境时很方便：
//   $env:ADMIN_CLOUD_API_URL = "https://xxx.service.tcloudbase.com/admin"
if (process.env.ADMIN_CLOUD_API_URL) {
  config.cloudApiUrl = process.env.ADMIN_CLOUD_API_URL
}

// 8080 被占用时可以换一个：
//   $env:ADMIN_PORT = "8099"
if (process.env.ADMIN_PORT) {
  config.port = Number(process.env.ADMIN_PORT) || config.port
}

const ROOT = __dirname
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

function safeRequire(relativePath) {
  try {
    return require(path.join(__dirname, relativePath))
  } catch (err) {
    return {}
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** 把 URL 路径解析成磁盘路径，并挡住 ../ 往上跳目录的写法 */
function resolveStaticPath(pathname) {
  let clean
  try {
    clean = decodeURIComponent(pathname.split('?')[0])
  } catch (err) {
    return null
  }
  if (clean === '/' || clean === '') clean = '/index.html'

  const full = path.normalize(path.join(ROOT, clean))
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null
  return full
}

function serveStatic(pathname, res) {
  const filePath = resolveStaticPath(pathname)
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('路径不合法')
    return
  }

  fs.readFile(filePath, function (err, buffer) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('找不到文件：' + pathname)
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(buffer)
  })
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', function (chunk) {
      data += chunk
      // 管理后台的请求都很小，超过 1MB 一定是哪里不对
      if (data.length > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', function () {
      resolve(data)
    })
    req.on('error', reject)
  })
}

/** 以服务端身份把请求转给云函数 */
function proxyToCloud(payload) {
  return new Promise(function (resolve, reject) {
    let target
    try {
      target = new URL(config.cloudApiUrl)
    } catch (err) {
      reject(new Error('cloudApiUrl 不是合法网址：' + config.cloudApiUrl))
      return
    }

    const body = JSON.stringify(payload)
    const isHttps = target.protocol === 'https:'
    const transport = isHttps ? https : http

    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      function (res) {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', function (chunk) {
          data += chunk
        })
        res.on('end', function () {
          resolve({ statusCode: res.statusCode, body: data })
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function handleApi(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD', msg: '只支持 POST' })
    return
  }

  if (!config.cloudApiUrl) {
    sendJson(res, 200, {
      ok: false,
      code: 'LOCAL_CONFIG_MISSING',
      msg: '还没配置云函数地址。请打开 admin/server.config.js，把 cloudApiUrl 填成云开发「HTTP 访问服务」里配好的地址。'
    })
    return
  }

  let payload
  try {
    payload = JSON.parse((await readBody(req)) || '{}')
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', msg: '请求体不是合法 JSON' })
    return
  }

  try {
    const result = await proxyToCloud(payload)
    let parsed
    try {
      parsed = JSON.parse(result.body)
    } catch (err) {
      // 把原始响应带出来，方便判断是地址配错了还是权限问题
      parsed = {
        ok: false,
        code: 'BAD_RESPONSE',
        msg:
          '云函数返回的不是 JSON（HTTP ' +
          result.statusCode +
          '）：' +
          String(result.body).slice(0, 300)
      }
    }
    sendJson(res, 200, unwrapIntegratedResponse(parsed))
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      code: 'PROXY_ERROR',
      msg: '连不上云函数：' + (err && err.message ? err.message : String(err))
    })
  }
}

/**
 * 云开发的「HTTP 访问服务」有两种响应模式：
 *   默认模式：直接把云函数的返回值当作响应体
 *   集成响应：返回值要写成 { statusCode, headers, body }，body 是字符串
 *
 * 两种都兼容一下，省得还要去控制台确认开了哪种。
 */
function unwrapIntegratedResponse(parsed) {
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.ok === undefined &&
    typeof parsed.body === 'string' &&
    (parsed.statusCode || parsed.headers)
  ) {
    try {
      return JSON.parse(parsed.body)
    } catch (err) {
      return parsed
    }
  }
  return parsed
}

const server = http.createServer(function (req, res) {
  const pathname = (req.url || '/').split('?')[0]
  if (pathname === '/api') {
    handleApi(req, res)
    return
  }
  serveStatic(req.url || '/', res)
})

server.listen(config.port, HOST, function () {
  // 这里刻意只用 ASCII：Windows 控制台默认是 GBK 编码，
  // 直接输出中文会变成乱码，反而看不出在说什么。
  console.log('')
  console.log('  Admin server is running.')
  console.log('  Open in browser:  http://localhost:' + config.port + '   or   http://' + HOST + ':' + config.port)
  console.log('  Cloud API:        ' + (config.cloudApiUrl || '(not configured - see admin/server.config.js)'))
  console.log('  Map key domains:  add BOTH "localhost" and "' + HOST + '" to the key in Tencent LBS')
  console.log('')
  console.log('  Press Ctrl+C to stop.')
  console.log('')
})

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Port ' + config.port + ' is already in use.')
    console.error('Close the previous server window, or change "port" in admin/server.config.js.')
  } else {
    console.error('Failed to start server:', err)
  }
  process.exit(1)
})
