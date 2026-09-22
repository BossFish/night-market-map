// map 覆盖物的颜色只能写在 JS 里，不能读 WXSS 变量，所以这里单独放一份。
// 颜色格式是 8 位十六进制 #RRGGBBAA，最后两位是透明度。
const theme = {
  brandGreen: '#22C55E',
  brandGreenDark: '#16A34A',

  // 矩形：普通态 / 选中态，只差透明度
  rectFill: '#22C55E4D',
  rectFillActive: '#22C55E99',
  rectStroke: '#15803DFF',
  rectStrokeActive: '#14532DFF'
}

module.exports = theme
