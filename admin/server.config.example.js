/**
 * 本地配置模板。复制成 server.config.js 再填。
 *
 * cloudApiUrl：云开发「HTTP 访问服务」里给 admin 云函数配好的完整地址，
 * 形如 https://xxxxxxxx.service.tcloudbase.com/admin
 *
 * 为什么这个文件不进版本库：它是每台机器自己的配置，
 * 换台电脑、换个云环境就变了，没必要跟着代码走。
 */
module.exports = {
  cloudApiUrl: '',
  port: 8080
}
