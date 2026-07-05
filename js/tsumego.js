/* ============================================================
 * 死活训练：经典题库访问 + 题目区域（聚焦/限制范围）计算
 * 题库数据在 js/tsumego-bank.js（由 SGF 自动生成，全部黑先），
 * 坐标为 SGF 两字母格式（左上角 aa，列在前行在后）。
 * ============================================================ */
window.TSUMEGO = (() => {
  const SIZE = 19;
  const SGF_LETTERS = 'abcdefghijklmnopqrs';

  function decodePoints(s) {
    const pts = [];
    for (let i = 0; i + 1 < s.length; i += 2)
      pts.push({ x: SGF_LETTERS.indexOf(s[i]), y: SGF_LETTERS.indexOf(s[i + 1]) });
    return pts;
  }

  function bank() { return window.TSUMEGO_BANK || []; }

  function getCollections() {
    return bank().map(c => ({ id: c.id, name: c.name, level: c.level, count: c.problems.length }));
  }

  function totalCount() {
    return bank().reduce((s, c) => s + c.problems.length, 0);
  }

  /* 题目区域：所有棋子的包围盒 + 余量，贴边吸附，并尽量扩成正方形便于聚焦显示 */
  function computeRegion(stones) {
    let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1;
    for (const p of stones) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (x1 < 0) return { x0: 0, y0: 0, x1: SIZE - 1, y1: SIZE - 1 };
    const pad = 3;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(SIZE - 1, x1 + pad); y1 = Math.min(SIZE - 1, y1 + pad);
    // 离边 2 路以内直接吸附到边（死活题的边界就是棋盘边）
    if (x0 <= 2) x0 = 0; if (y0 <= 2) y0 = 0;
    if (x1 >= SIZE - 3) x1 = SIZE - 1; if (y1 >= SIZE - 3) y1 = SIZE - 1;
    // 扩成不小于 9 路的正方形；优先向远离棋盘边的方向扩
    const target = Math.max(x1 - x0 + 1, y1 - y0 + 1, 9);
    if (target >= SIZE) return { x0: 0, y0: 0, x1: SIZE - 1, y1: SIZE - 1 };
    [x0, x1] = expandAxis(x0, x1, target);
    [y0, y1] = expandAxis(y0, y1, target);
    return { x0, y0, x1, y1 };
  }

  function expandAxis(a, b, target) {
    let need = target - (b - a + 1);
    while (need > 0) {
      if (a === 0) b = Math.min(SIZE - 1, b + need), need = 0;
      else if (b === SIZE - 1) a = Math.max(0, a - need), need = 0;
      else { b++; need--; if (need > 0) { a--; need--; } }
    }
    return [a, b];
  }

  /* 目标启发：被包围（更靠内、靠角）的一方即攻防主体。
   * 题库已统一黑先：黑在内 → 黑先做活；白在内 → 黑先杀白。 */
  function guessGoal(black, white, label) {
    const byLabel = {
      '做活': ['live', '黑先做活'], '杀棋': ['kill', '黑先杀白'],
      '打劫': ['ko', '黑先造劫/劫杀'], '对杀': ['race', '黑先赢对杀'],
      '倒扑': ['kill', '黑先倒扑杀'], '连接': ['connect', '黑先连接'],
      '手筋': ['open', '黑先寻找手筋'],
    };
    if (label && byLabel[label]) return { goal: byLabel[label][0], goalText: byLabel[label][1] };
    const depth = pts => pts.reduce((s, p) => s + Math.min(p.x, SIZE - 1 - p.x) + Math.min(p.y, SIZE - 1 - p.y), 0) / (pts.length || 1);
    if (!black.length || !white.length) return { goal: 'open', goalText: '黑先' };
    return depth(black) < depth(white)
      ? { goal: 'live', goalText: '黑先做活（判断参考）' }
      : { goal: 'kill', goalText: '黑先杀白（判断参考）' };
  }

  function getProblem(cid, index) {
    const c = bank().find(c => c.id === cid);
    if (!c || !c.problems.length) return null;
    const i = ((index % c.problems.length) + c.problems.length) % c.problems.length;
    const [ab, aw, label] = c.problems[i];
    const black = decodePoints(ab);
    const white = decodePoints(aw);
    const region = computeRegion(black.concat(white));
    const { goal, goalText } = guessGoal(black, white, label);
    return {
      collection: c.id, collectionName: c.name, level: c.level,
      index: i, count: c.problems.length, label: label || '',
      size: SIZE, toPlay: 1, black, white, region, goal, goalText,
      title: `${c.name} · 第 ${i + 1} 题${label ? `（${label}）` : ''}`,
    };
  }

  /* 随机抽题：cid 为 'all' 时按题量加权在全库中抽 */
  function randomRef(cid) {
    const b = bank();
    if (cid && cid !== 'all') {
      const c = b.find(c => c.id === cid);
      if (c) return { collection: cid, index: Math.floor(Math.random() * c.problems.length) };
    }
    let n = Math.floor(Math.random() * totalCount());
    for (const c of b) {
      if (n < c.problems.length) return { collection: c.id, index: n };
      n -= c.problems.length;
    }
    return { collection: b[0].id, index: 0 };
  }

  return { getCollections, getProblem, randomRef, totalCount, SIZE };
})();
