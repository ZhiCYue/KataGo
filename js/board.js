/* ============================================================
 * 棋盘渲染与交互（Canvas，高分屏适配）
 * ============================================================ */
class BoardView {
  constructor(canvas, game, onPlay) {
    this.canvas = canvas;
    this.game = game;
    this.onPlay = onPlay;
    this.hover = null;
    this.hintMove = null;
    this.interactive = true;
    this.showCoords = true;
    this.editMode = false;   // 校正模式：点击交叉点循环 空→黑→白
    this.onEdit = null;

    canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    canvas.addEventListener('click', e => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setGame(game) { this.game = game; this.hintMove = null; this.draw(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssSize = this.canvas.clientWidth || 540;
    this.canvas.height = this.canvas.width = cssSize * dpr;
    this.canvas.style.height = cssSize + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.px = cssSize;
    this.margin = cssSize * (this.showCoords ? 0.064 : 0.045);
    this.cell = (this.px - 2 * this.margin) / (this.game.size - 1);
    this.draw();
  }

  toPx(i) { return this.margin + i * this.cell; }

  fromEvent(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const x = Math.round((px - this.margin) / this.cell);
    const y = Math.round((py - this.margin) / this.cell);
    if (!this.game.inBounds(x, y)) return null;
    // 命中范围限制在落点附近，避免边缘误触
    if (Math.hypot(px - this.toPx(x), py - this.toPx(y)) > this.cell * 0.5) return null;
    return { x, y };
  }

  onMouseMove(e) {
    if (this.editMode) return;
    if (!this.interactive) { if (this.hover) { this.hover = null; this.draw(); } return; }
    const p = this.fromEvent(e);
    const same = (this.hover && p && this.hover.x === p.x && this.hover.y === p.y) || (!this.hover && !p);
    if (same) return;
    this.hover = (p && this.game.board[p.y][p.x] === 0) ? p : null;
    this.draw();
  }

  onClick(e) {
    const p = this.fromEvent(e);
    if (this.editMode) {
      // 校正：循环 空(0)→黑(1)→白(2)→空
      if (p) {
        this.game.board[p.y][p.x] = (this.game.board[p.y][p.x] + 1) % 3;
        this.draw();
        if (this.onEdit) this.onEdit();
      }
      return;
    }
    if (!this.interactive) return;
    if (p && this.game.board[p.y][p.x] === 0) this.onPlay(p.x, p.y);
  }

  starPoints() {
    const n = this.game.size;
    let pts = [];
    if (n === 19) pts = [3, 9, 15];
    else if (n === 13) pts = [3, 6, 9];
    else if (n === 9) pts = [2, 4, 6];
    else return [];
    const res = [];
    for (const a of pts) for (const b of pts) res.push([a, b]);
    return res;
  }

  draw() {
    const ctx = this.ctx, n = this.game.size, S = this.px;
    ctx.clearRect(0, 0, S, S);

    // —— 木纹棋盘底 ——
    const grad = ctx.createLinearGradient(0, 0, S, S);
    grad.addColorStop(0, '#e7c184');
    grad.addColorStop(0.5, '#dcab63');
    grad.addColorStop(1, '#d59f54');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    // 细木纹
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#6e4a22';
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      const y = (i / 26) * S + Math.sin(i) * 3;
      ctx.moveTo(0, y); ctx.lineTo(S, y + Math.cos(i * 1.7) * 6);
      ctx.lineWidth = 1 + (i % 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // —— 网格 ——
    ctx.strokeStyle = 'rgba(60,40,18,0.85)';
    ctx.lineWidth = 1;
    const a = this.toPx(0), b = this.toPx(n - 1);
    for (let i = 0; i < n; i++) {
      const p = this.toPx(i);
      ctx.beginPath(); ctx.moveTo(a, p); ctx.lineTo(b, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, a); ctx.lineTo(p, b); ctx.stroke();
    }

    // —— 星位 ——
    ctx.fillStyle = 'rgba(50,32,14,0.9)';
    for (const [sx, sy] of this.starPoints()) {
      ctx.beginPath();
      ctx.arc(this.toPx(sx), this.toPx(sy), this.cell * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }

    // —— 坐标 ——
    if (this.showCoords) {
      ctx.fillStyle = 'rgba(70,48,22,0.75)';
      ctx.font = `${Math.max(9, this.cell * 0.32)}px "Cormorant Garamond", serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const letters = 'ABCDEFGHJKLMNOPQRST';
      for (let i = 0; i < n; i++) {
        ctx.fillText(letters[i], this.toPx(i), this.margin * 0.45);
        ctx.fillText(String(n - i), this.margin * 0.45, this.toPx(i));
      }
    }

    // —— 棋子 ——
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (this.game.board[y][x]) this.drawStone(x, y, this.game.board[y][x], 1);

    // —— 最后一手标记 ——
    const lm = this.game.lastMove;
    if (lm && !lm.pass) {
      ctx.beginPath();
      ctx.arc(this.toPx(lm.x), this.toPx(lm.y), this.cell * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = lm.color === 1 ? '#efe7d6' : '#1a1714';
      ctx.fill();
    }

    // —— 落子预览（半透明）——
    if (this.hover) this.drawStone(this.hover.x, this.hover.y, this.game.turn, 0.4);

    // —— 提示标记（朱砂圈）——
    if (this.hintMove) {
      ctx.beginPath();
      ctx.arc(this.toPx(this.hintMove.x), this.toPx(this.hintMove.y), this.cell * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = '#b8402f';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  drawStone(x, y, color, alpha) {
    const ctx = this.ctx, cx = this.toPx(x), cy = this.toPx(y), r = this.cell * 0.46;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (alpha === 1) {
      ctx.beginPath();
      ctx.arc(cx + r * 0.12, cy + r * 0.14, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30,18,6,0.28)';
      ctx.fill();
    }
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    if (color === 1) { g.addColorStop(0, '#6a6a6a'); g.addColorStop(0.5, '#262626'); g.addColorStop(1, '#050505'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#efe9dc'); g.addColorStop(1, '#cfc6b2'); }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    if (color === 2) { ctx.strokeStyle = 'rgba(120,110,90,0.4)'; ctx.lineWidth = 0.6; ctx.stroke(); }
    ctx.restore();
  }
}
