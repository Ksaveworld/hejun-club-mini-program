// Draw only public invitation text. Identity, contacts and credentials never enter the canvas.
function drawInvite(canvas, kind, code) {
  if (!/^[A-Z0-9]{6}$/.test(code) || !['card', 'poster'].includes(kind)) throw new Error('推荐信息不正确，请刷新。');
  const width = 600, height = kind === 'card' ? 480 : 900;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#164c3d'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#d5ba77'; ctx.lineWidth = 2; ctx.strokeRect(24, 24, width - 48, height - 48);
  function text(value, size, y, color = '#f8efce', family = 'sans-serif') {
    ctx.fillStyle = color; ctx.font = size + 'px ' + family; ctx.textAlign = 'left'; ctx.fillText(value, 52, y);
  }
  text('跨境企业家俱乐部', 34, 105, '#f8efce', 'serif');
  text('会员权益 · 入会说明', 24, 155);
  ctx.strokeStyle = '#65836d'; ctx.beginPath(); ctx.moveTo(52, 190); ctx.lineTo(548, 190); ctx.stroke();
  if (kind === 'card') {
    text('邀你了解俱乐部', 30, 252);
    text('推荐码  ' + code, 22, 306);
    text('点击小程序卡片，查看会员介绍', 22, 371);
    text('开发内测 · 暂未开放支付', 18, 424, '#ced4bc');
  } else {
    text('连接跨境视野', 36, 272, '#f8efce', 'serif');
    text('了解服务与会员权益', 26, 328);
    text('你的邀请来源', 22, 442, '#ced4bc');
    text(code, 60, 522, '#f8efce', 'monospace');
    text('请通过配套小程序卡片进入', 25, 628);
    text('推荐来源会随卡片自动带入', 22, 674, '#ced4bc');
    text('此图片不含扫码入口', 20, 741, '#ced4bc');
    text('开发内测 · 暂未开放支付', 20, 803, '#ced4bc');
    text('推荐关系不代表已取得奖励资格', 17, 841, '#ced4bc');
  }
  return { width, height };
}
module.exports = { drawInvite };
