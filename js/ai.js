/* ============================================================
 * 启发式围棋 AI（轻量本地版）
 * 难度通过「随机性」与「候选范围」调节。
 * 后续接入 KataGo 后端时，只需替换 chooseMove 的实现。
 * 难度：'beginner' 入门 / 'easy' 初级 / 'medium' 中级
 * ============================================================ */
const GoAI = {
  chooseMove(game, level = 'easy') {
    const moves = game.legalMoves();
    if (moves.length === 0) return null; // 无合法点 → 虚手

    const scored = moves.map(m => ({ ...m, score: this.evaluate(game, m) }));
    scored.sort((a, b) => b.score - a.score);

    // 终盘判断：若最优着分数过低（多为填自己空），干脆虚手
    if (scored[0].score < -20) return null;

    if (level === 'beginner') {
      const pool = scored.slice(0, Math.max(3, Math.floor(scored.length * 0.5)));
      return this.weightedChoice(pool, 1);
    }
    if (level === 'easy') {
      return this.weightedChoice(scored.slice(0, Math.min(8, scored.length)), 2.5);
    }
    // medium：在最优若干着中偏向最佳
    return this.weightedChoice(scored.slice(0, Math.min(4, scored.length)), 5);
  },

  evaluate(game, m) {
    const { x, y, captured, ownLiberties } = m;
    const size = game.size;
    const color = game.turn, opp = color === 1 ? 2 : 1;
    let s = 0;

    s += captured * 12;                                  // 提子收益
    if (ownLiberties === 1 && captured === 0) s -= 8;    // 避免自送一气（自陷征子）
    if (this.isOwnEye(game, x, y, color)) s -= 60;       // 不填自己的眼

    for (const [nx, ny] of game.neighbors(x, y)) {
      const v = game.board[ny][nx];
      if (v === color) {
        const g = game.getGroup(nx, ny);
        if (g.liberties.size === 1) s += 7;              // 救自己被打吃的棋
      } else if (v === opp) {
        const g = game.getGroup(nx, ny);
        if (g.liberties.size === 1) s += 9;              // 打吃对方
        else if (g.liberties.size === 2) s += 2;         // 紧气施压
      }
    }

    // 行（线）偏好：开局重三线、四线
    const dist = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (dist === 0) s -= 4;
    else if (dist === 1) s -= 1;
    else if (dist === 2) s += 3;
    else if (dist === 3) s += 2;

    s += this.proximityBonus(game, x, y, color);
    s += Math.random() * 0.5;                            // 轻微抖动，避免完全雷同
    return s;
  },

  /* 周边有子则加分（贴近战斗），但不奖励紧贴自己单子 */
  proximityBonus(game, x, y, color) {
    let bonus = 0, anyStone = false;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (!game.inBounds(nx, ny)) continue;
        const v = game.board[ny][nx];
        if (v === 0) continue;
        anyStone = true;
        const d = Math.abs(dx) + Math.abs(dy);
        bonus += (3 - Math.min(d, 3)) * 0.6;
      }
    // 空旷开局：偏向星位/小目区域
    if (!anyStone) {
      const size = game.size;
      const star = size >= 13 ? 3 : 2;
      const onStarLine = (v) => v === star || v === size - 1 - star;
      if (onStarLine(x) && onStarLine(y)) bonus += 4;
    }
    return bonus;
  },

  isOwnEye(game, x, y, color) {
    for (const [nx, ny] of game.neighbors(x, y))
      if (game.board[ny][nx] !== color) return false;
    let own = 0, total = 0, edge = false;
    for (const [dx, dy] of [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]]) {
      if (!game.inBounds(dx, dy)) { edge = true; continue; }
      total++;
      if (game.board[dy][dx] === color) own++;
    }
    return edge ? own === total : own >= 3;
  },

  weightedChoice(pool, sharpness) {
    if (pool.length === 1) return pool[0];
    const min = Math.min(...pool.map(p => p.score));
    const weights = pool.map(p => Math.pow((p.score - min) + 1, sharpness));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
    return pool[pool.length - 1];
  },
};
