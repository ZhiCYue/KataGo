/* ============================================================
 * 棋盘渲染与交互（Canvas，高分屏适配）
 * 支持视口（viewport）：死活训练时只显示题目所在的局部区域
 * ============================================================ */
class BoardView {
  constructor(canvas, game, onPlay) {
    this.canvas = canvas;
    this.game = game;
    this.onPlay = onPlay;
    this.hover = null;
    this.hintMove = null;
    this.candidates = null;  // 死活提示：[{x,y,move}] 前几个候选点，带序号显示
    this.heatmap = null;     // KataGo ownership（黑视角，长度 size*size）
    this.showHeat = false;   // 是否叠加形势热力图
    this.interactive = true;
    this.showCoords = true;
    this.editMode = false;   // 校正模式：点击交叉点循环 空→黑→白
    this.editBrush = 'cycle'; // 画笔：'cycle' 循环 / 1 放黑 / 2 放白 / 0 擦除
    this.onEdit = null;
    this.viewport = null;    // {x0,y0,x1,y1} 只渲染该区域；null 为整盘

    canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    canvas.addEventListener('click', e => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
    // resize 事件触发时布局未必已稳定（如媒体查询切换），用 ResizeObserver 兜底
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (this.canvas.clientWidth && this.canvas.clientWidth !== this.px) this.resize();
      }).observe(canvas);
    }
    this.resize();
  }

  setGame(game) { this.game = game; this.hintMove = null; this.candidates = null; this.heatmap = null; this.resize(); }

  setViewport(vp) { this.viewport = vp || null; this.resize(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssSize = this.canvas.clientWidth || 540;
    this.canvas.height = this.canvas.width = cssSize * dpr;
    this.canvas.style.height = cssSize + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.px = cssSize;
    const n = this.game.size;
    // 校正模式始终显示整盘；视口越界（换局面后）也回退整盘
    let vp = (!this.editMode && this.viewport) || { x0: 0, y0: 0, x1: n - 1, y1: n - 1 };
    if (vp.x1 >= n || vp.y1 >= n) vp = { x0: 0, y0: 0, x1: n - 1, y1: n - 1 };
    this.vp = vp;
    const cols = vp.x1 - vp.x0 + 1, rows = vp.y1 - vp.y0 + 1;
    this.margin = cssSize * (this.showCoords ? 0.064 : 0.045);
    this.cell = (this.px - 2 * this.margin) / (Math.max(cols, rows) - 1);
    this.ox = (this.px - this.cell * (cols - 1)) / 2;
    this.oy = (this.px - this.cell * (rows - 1)) / 2;
    this.draw();
  }

  pxX(x) { return this.ox + (x - this.vp.x0) * this.cell; }
  pxY(y) { return this.oy + (y - this.vp.y0) * this.cell; }

  fromEvent(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const x = this.vp.x0 + Math.round((px - this.ox) / this.cell);
    const y = this.vp.y0 + Math.round((py - this.oy) / this.cell);
    if (!this.game.inBounds(x, y)) return null;
    if (x < this.vp.x0 || x > this.vp.x1 || y < this.vp.y0 || y > this.vp.y1) return null;
    // 命中范围限制在落点附近，避免边缘误触
    if (Math.hypot(px - this.pxX(x), py - this.pxY(y)) > this.cell * 0.5) return null;
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
      // 摆子/校正：'cycle' 循环 空(0)→黑(1)→白(2)→空；指定画笔则直接放子，再点同色即擦除
      if (p) {
        const cur = this.game.board[p.y][p.x];
        if (this.editBrush === 'cycle' || this.editBrush == null) {
          this.game.board[p.y][p.x] = (cur + 1) % 3;
        } else {
          const b = +this.editBrush;
          this.game.board[p.y][p.x] = cur === b ? 0 : b;
        }
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

  inView(x, y) {
    return x >= this.vp.x0 && x <= this.vp.x1 && y >= this.vp.y0 && y <= this.vp.y1;
  }

  draw() {
    const ctx = this.ctx, S = this.px, vp = this.vp;

    // —— 木纹棋盘底 ——
    ctx.clearRect(0, 0, S, S);
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
    // 视口边不是真实棋盘边时，网格线向外多画一段，示意棋盘在此方向延续
    const n = this.game.size;
    const bleed = this.cell * 0.6;
    const xa = vp.x0 === 0 ? this.pxX(0) : this.pxX(vp.x0) - bleed;
    const xb = vp.x1 === n - 1 ? this.pxX(n - 1) : this.pxX(vp.x1) + bleed;
    const ya = vp.y0 === 0 ? this.pxY(0) : this.pxY(vp.y0) - bleed;
    const yb = vp.y1 === n - 1 ? this.pxY(n - 1) : this.pxY(vp.y1) + bleed;
    ctx.strokeStyle = 'rgba(60,40,18,0.85)';
    ctx.lineWidth = 1;
    for (let y = vp.y0; y <= vp.y1; y++) {
      const p = this.pxY(y);
      ctx.beginPath(); ctx.moveTo(xa, p); ctx.lineTo(xb, p); ctx.stroke();
    }
    for (let x = vp.x0; x <= vp.x1; x++) {
      const p = this.pxX(x);
      ctx.beginPath(); ctx.moveTo(p, ya); ctx.lineTo(p, yb); ctx.stroke();
    }
    // 真实棋盘边加粗
    ctx.lineWidth = 2;
    if (vp.x0 === 0) { ctx.beginPath(); ctx.moveTo(this.pxX(0), ya); ctx.lineTo(this.pxX(0), yb); ctx.stroke(); }
    if (vp.x1 === n - 1) { ctx.beginPath(); ctx.moveTo(this.pxX(n - 1), ya); ctx.lineTo(this.pxX(n - 1), yb); ctx.stroke(); }
    if (vp.y0 === 0) { ctx.beginPath(); ctx.moveTo(xa, this.pxY(0)); ctx.lineTo(xb, this.pxY(0)); ctx.stroke(); }
    if (vp.y1 === n - 1) { ctx.beginPath(); ctx.moveTo(xa, this.pxY(n - 1)); ctx.lineTo(xb, this.pxY(n - 1)); ctx.stroke(); }
    ctx.lineWidth = 1;

    // —— 星位 ——
    ctx.fillStyle = 'rgba(50,32,14,0.9)';
    for (const [sx, sy] of this.starPoints()) {
      if (!this.inView(sx, sy)) continue;
      ctx.beginPath();
      ctx.arc(this.pxX(sx), this.pxY(sy), this.cell * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }

    // —— 形势热力图（在棋子之下）：ownership>0 归黑（青黛），<0 归白（朱），越纯越浓 ——
    if (this.showHeat && this.heatmap) {
      for (let y = vp.y0; y <= vp.y1; y++)
        for (let x = vp.x0; x <= vp.x1; x++) {
          const o = this.heatmap[y * n + x];
          if (o == null) continue;
          const a = Math.abs(o) * 0.6;
          if (a < 0.07) continue;
          ctx.fillStyle = o > 0 ? `rgba(24,52,74,${a})` : `rgba(158,52,38,${a})`;
          const s = this.cell * 0.9;
          ctx.fillRect(this.pxX(x) - s / 2, this.pxY(y) - s / 2, s, s);
        }
    }

    // —— 坐标 ——
    if (this.showCoords) {
      ctx.fillStyle = 'rgba(70,48,22,0.75)';
      ctx.font = `${Math.max(9, Math.min(this.cell * 0.32, 15))}px "Cormorant Garamond", serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const letters = 'ABCDEFGHJKLMNOPQRST';
      const ty = Math.max(9, this.oy - this.cell * 0.62);
      const tx = Math.max(9, this.ox - this.cell * 0.62);
      for (let x = vp.x0; x <= vp.x1; x++) ctx.fillText(letters[x], this.pxX(x), ty);
      for (let y = vp.y0; y <= vp.y1; y++) ctx.fillText(String(n - y), tx, this.pxY(y));
    }

    // —— 棋子 ——
    for (let y = vp.y0; y <= vp.y1; y++)
      for (let x = vp.x0; x <= vp.x1; x++)
        if (this.game.board[y][x]) this.drawStone(x, y, this.game.board[y][x], 1);

    // —— 最后一手标记 ——
    const lm = this.game.lastMove;
    if (lm && !lm.pass && this.inView(lm.x, lm.y)) {
      ctx.beginPath();
      ctx.arc(this.pxX(lm.x), this.pxY(lm.y), this.cell * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = lm.color === 1 ? '#efe7d6' : '#1a1714';
      ctx.fill();
    }

    // —— 落子预览（半透明）——
    if (this.hover) this.drawStone(this.hover.x, this.hover.y, this.game.turn, 0.4);

    // —— 死活候选点：①首选（朱砂粗圈）②③次选（细圈），圈内标序号 ——
    if (this.candidates && this.candidates.length) {
      this.candidates.forEach((c, i) => {
        if (!this.inView(c.x, c.y)) return;
        const first = i === 0;
        const cx = this.pxX(c.x), cy = this.pxY(c.y);
        ctx.beginPath();
        ctx.arc(cx, cy, this.cell * (first ? 0.42 : 0.34), 0, Math.PI * 2);
        ctx.strokeStyle = first ? '#b8402f' : 'rgba(184,64,47,0.55)';
        ctx.lineWidth = first ? 2.6 : 1.8;
        ctx.stroke();
        // 空点上标序号；点上已有棋子则不压字，仅留圈
        if (this.game.board[c.y][c.x] === 0) {
          ctx.fillStyle = first ? '#b8402f' : 'rgba(184,64,47,0.75)';
          ctx.font = `bold ${this.cell * 0.4}px "Cormorant Garamond", serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), cx, cy + this.cell * 0.02);
        }
      });
    } else if (this.hintMove && this.inView(this.hintMove.x, this.hintMove.y)) {
      // —— 对局提示标记（朱砂圈）——
      ctx.beginPath();
      ctx.arc(this.pxX(this.hintMove.x), this.pxY(this.hintMove.y), this.cell * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = '#b8402f';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  drawStone(x, y, color, alpha) {
    const ctx = this.ctx, cx = this.pxX(x), cy = this.pxY(y), r = this.cell * 0.46;
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
