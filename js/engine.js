/* ============================================================
 * 围棋规则引擎 GoGame
 * 负责：落子合法性、气、提子、禁着点（自杀）、打劫（位置超劫）
 * 棋盘坐标统一为 board[y][x]，0 空 / 1 黑 / 2 白
 * ============================================================ */
class GoGame {
  constructor(size = 19) {
    this.reset(size);
  }

  reset(size = this.size || 19) {
    this.size = size;
    this.board = Array.from({ length: size }, () => new Array(size).fill(0));
    this.turn = 1;                 // 当前轮到谁：1 黑 / 2 白
    this.captures = { 1: 0, 2: 0 };// 各方提子总数
    this.history = [];             // 悔棋用的状态栈
    this.positionHistory = new Set(); // 位置超劫：记录出现过的局面
    this.lastMove = null;          // {x,y,color} 或 {pass:true,color}
    this.passes = 0;               // 连续虚手计数
    this.moveNumber = 0;
    this.gameOver = false;
    this.positionHistory.add(this.hash() + this.turn);
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }

  /* 载入任意布局（来自上传识别的局面）：直接铺子并设定轮走方，清空历史 */
  setupPosition(board, turn = 1) {
    const size = board.length;
    this.reset(size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        this.board[y][x] = board[y][x] ? board[y][x] : 0;
    this.turn = turn === 2 ? 2 : 1;
    this.positionHistory = new Set([this.hash() + this.turn]);
  }

  neighbors(x, y) {
    const r = [];
    if (x > 0) r.push([x - 1, y]);
    if (x < this.size - 1) r.push([x + 1, y]);
    if (y > 0) r.push([x, y - 1]);
    if (y < this.size - 1) r.push([x, y + 1]);
    return r;
  }

  hash() {
    let s = '';
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) s += this.board[y][x];
    return s;
  }

  cloneBoard() { return this.board.map(row => row.slice()); }

  /* 取得 (x,y) 所在的同色棋块及其气 */
  getGroup(x, y) {
    const color = this.board[y][x];
    const stones = [];
    const liberties = new Set();
    if (color === 0) return { stones, liberties };
    const seen = new Set([x + ',' + y]);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      stones.push([cx, cy]);
      for (const [nx, ny] of this.neighbors(cx, cy)) {
        const v = this.board[ny][nx];
        if (v === 0) liberties.add(nx + ',' + ny);
        else if (v === color && !seen.has(nx + ',' + ny)) {
          seen.add(nx + ',' + ny);
          stack.push([nx, ny]);
        }
      }
    }
    return { stones, liberties };
  }

  /* 试下一手（不落子），返回是否合法、提子数、本块气数。结束后棋盘复原。 */
  _tryPlace(x, y, color) {
    if (!this.inBounds(x, y) || this.board[y][x] !== 0) return { legal: false, reason: 'occupied' };
    const opp = color === 1 ? 2 : 1;
    const snapshot = this.cloneBoard();
    this.board[y][x] = color;

    const captured = [];
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[ny][nx] === opp) {
        const g = this.getGroup(nx, ny);
        if (g.liberties.size === 0) {
          for (const [sx, sy] of g.stones) { this.board[sy][sx] = 0; captured.push([sx, sy]); }
        }
      }
    }

    const own = this.getGroup(x, y);
    const ownLiberties = own.liberties.size;
    if (ownLiberties === 0) { this.board = snapshot; return { legal: false, reason: 'suicide' }; }

    const koKey = this.hash() + opp;        // 落子后轮到 opp 的局面
    const isKo = this.positionHistory.has(koKey);
    this.board = snapshot;                   // 复原
    if (isKo) return { legal: false, reason: 'ko' };
    return { legal: true, captured, ownLiberties };
  }

  /* 正式落子 */
  play(x, y) {
    if (this.gameOver) return { legal: false, reason: 'over' };
    const color = this.turn, opp = color === 1 ? 2 : 1;
    const t = this._tryPlace(x, y, color);
    if (!t.legal) return t;

    const frame = {
      board: this.cloneBoard(), turn: this.turn, captures: { ...this.captures },
      lastMove: this.lastMove, passes: this.passes, moveNumber: this.moveNumber, addedKey: null,
    };

    this.board[y][x] = color;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[ny][nx] === opp) {
        const g = this.getGroup(nx, ny);
        if (g.liberties.size === 0) for (const [sx, sy] of g.stones) this.board[sy][sx] = 0;
      }
    }

    const key = this.hash() + opp;
    frame.addedKey = key;
    this.history.push(frame);
    this.captures[color] += t.captured.length;
    this.lastMove = { x, y, color };
    this.turn = opp;
    this.passes = 0;
    this.moveNumber++;
    this.positionHistory.add(key);
    return { legal: true, captured: t.captured };
  }

  /* 虚手（弃权）；连续两次虚手则终局 */
  pass() {
    if (this.gameOver) return;
    const frame = {
      board: this.cloneBoard(), turn: this.turn, captures: { ...this.captures },
      lastMove: this.lastMove, passes: this.passes, moveNumber: this.moveNumber, addedKey: null,
    };
    this.history.push(frame);
    this.lastMove = { pass: true, color: this.turn };
    this.turn = this.turn === 1 ? 2 : 1;
    this.passes++;
    this.moveNumber++;
    if (this.passes >= 2) this.gameOver = true;
  }

  undo() {
    const frame = this.history.pop();
    if (!frame) return false;
    if (frame.addedKey) this.positionHistory.delete(frame.addedKey);
    this.board = frame.board;
    this.turn = frame.turn;
    this.captures = frame.captures;
    this.lastMove = frame.lastMove;
    this.passes = frame.passes;
    this.moveNumber = frame.moveNumber;
    this.gameOver = false;
    return true;
  }

  /* 列出当前一方所有合法点 */
  legalMoves(color = this.turn) {
    const res = [];
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        if (this.board[y][x] !== 0) continue;
        const t = this._tryPlace(x, y, color);
        if (t.legal) res.push({ x, y, captured: t.captured.length, ownLiberties: t.ownLiberties });
      }
    return res;
  }

  /* 数子法粗略估算（假设盘面棋块均存活），白方加贴目 */
  estimateScore(komi = 7.5) {
    const size = this.size;
    let black = 0, white = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (this.board[y][x] === 1) black++;
        else if (this.board[y][x] === 2) white++;
      }
    const visited = Array.from({ length: size }, () => new Array(size).fill(false));
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (this.board[y][x] !== 0 || visited[y][x]) continue;
        const region = [];
        const borders = new Set();
        const stack = [[x, y]];
        visited[y][x] = true;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          region.push([cx, cy]);
          for (const [nx, ny] of this.neighbors(cx, cy)) {
            const v = this.board[ny][nx];
            if (v === 0 && !visited[ny][nx]) { visited[ny][nx] = true; stack.push([nx, ny]); }
            else if (v !== 0) borders.add(v);
          }
        }
        if (borders.size === 1) {
          if (borders.has(1)) black += region.length; else white += region.length;
        }
      }
    white += komi;
    return { black, white, komi };
  }
}
