/* ============================================================
 * 应用主控：连接规则引擎、AI（本地启发式 / KataGo 后端）、棋盘视图与界面
 * ============================================================ */
const LETTERS = 'ABCDEFGHJKLMNOPQRST';

const state = {
  game: null,
  view: null,
  mode: 'game',           // 'game' 对局 | 'tsumego' 死活练习
  boardSize: 19,
  aiSide: 2,              // AI 执方：0 不托管 / 1 黑 / 2 白（默认 AI 执白，人执黑）
  engine: 'local',        // 'local' 本地启发式 | 'katago' 神经网络
  level: 'medium',        // 本地难度
  kataVisits: 200,        // KataGo 算力（越大越强）
  gameCustomVisits: 400,  // 对局「自定义思考量」滑杆值
  komi: 7.5,
  thinking: false,
  epoch: 0,               // 局面代数：换题/新局时 +1，用于丢弃迟到的 AI 回包
  trial: null,            // 推演模式快照：{ moveNumber, movesLen, aiSide, judgeText }；null 表示未在推演
  moves: [],              // 当前局面之后下出的着手 [["B","Q16"],...]
  setupStones: [],        // 起始布局（来自上传识别）发给 KataGo 的 initialStones
  initialPlayer: 'B',     // 起始布局轮到谁走（moves 从该方起算）
  // 接口与页面同源、同端口，挂在 /api 下：本机 / 局域网 / Cloudflare 隧道都用同一相对地址
  backendUrl: '/api',
  // 跨设备同步
  clientId: Math.random().toString(36).slice(2),
  lastPosVersion: 0,
  // 上传校正
  editing: false,
  editGame: null,
  editTurn: 1,
  pendingImage: null,     // 待识别的图片 dataURL（切换路数时复用）
  // 死活练习
  tsumego: { collection: 'cho-3', index: 0, problem: null },
  tsumegoStrength: 'advanced',   // 'advanced' | 'pro' | 'custom'
  tsumegoCustomVisits: 220,      // 自定义档的思考量（visits）
  puzzleSolved: false,
};

const $ = id => document.getElementById(id);
const vertex = (x, y) => LETTERS[x] + (state.boardSize - y);
function fromVertex(v) {
  if (v === 'pass') return null;
  return { x: LETTERS.indexOf(v[0].toUpperCase()), y: state.boardSize - parseInt(v.slice(1), 10) };
}
function pointFromVertex(v, size = state.boardSize) {
  if (!v || v === 'pass') return null;
  return { x: LETTERS.indexOf(v[0].toUpperCase()), y: size - parseInt(v.slice(1), 10) };
}

/* —— 轮走判定 —— */
function aiControlsTurn() { return state.aiSide !== 0 && state.game.turn === state.aiSide; }
function humanTurnNow() {
  if (state.mode === 'tsumego') {
    const p = currentProblem();
    // 推演中黑白都可手动摆；正常训练只有黑（用户）先手可落子
    return !state.editing && !state.thinking && !state.game.gameOver && p &&
           (state.trial ? true : state.game.turn === 1);
  }
  return !state.editing && !state.thinking && !state.game.gameOver && !aiControlsTurn();
}
function maybeAI() {
  if (state.mode !== 'game') return;
  if (!state.game.gameOver && aiControlsTurn()) scheduleAI();
}

/* —— 落子封装：同步维护发给 KataGo 的着手序列 —— */
function pushPlay(x, y) {
  const c = state.game.turn;
  const r = state.game.play(x, y);
  if (r.legal) state.moves.push([c === 1 ? 'B' : 'W', vertex(x, y)]);
  return r;
}
function pushPass() {
  const c = state.game.turn;
  state.game.pass();
  state.moves.push([c === 1 ? 'B' : 'W', 'pass']);
}

function newGame() {
  state.mode = 'game';
  state.epoch++;
  exitTrialSilently();
  state.puzzleSolved = false;
  state.game = new GoGame(state.boardSize);
  state.moves = [];
  state.setupStones = [];
  state.initialPlayer = 'B';
  if (state.view) { state.view.viewport = null; state.view.setGame(state.game); }
  else { state.view = new BoardView($('board'), state.game, handleHumanPlay); state.view.onEdit = onEditChange; }
  state.thinking = false;
  hideSeal();
  $('result').classList.remove('show');
  updateWinrate(0.5, 0);
  updateModeUI();
  updateStatus();
  maybeAI(); // 若 AI 执黑则先行
}

function handleHumanPlay(x, y) {
  if (!humanTurnNow()) return;
  if (state.mode === 'tsumego') { handleProblemPlay(x, y); return; }
  const res = pushPlay(x, y);
  if (!res.legal) { flash(reasonText(res.reason)); return; }
  state.view.hintMove = null;
  afterMove();
  maybeAI();
}

function scheduleAI() {
  if (state.game.gameOver) return;
  const ep = state.epoch;   // 回包时局面已换（新局/换题）则丢弃
  state.thinking = true;
  state.view.interactive = false;
  updateStatus();

  if (state.engine === 'katago') {
    kataQuery('/genmove', state.kataVisits)
      .then(r => {
        if (state.epoch !== ep) return;
        const mv = fromVertex(r.bestMove);
        if (mv) pushPlay(mv.x, mv.y); else pushPass();
        updateWinrate(r.winrate, r.scoreLead);
      })
      .catch(err => {
        if (state.epoch !== ep) return;
        console.warn(err);
        flash('KataGo 后端未连接，本手改用本地 AI');
        localAIMove('medium');
      })
      .finally(() => {
        if (state.epoch !== ep) return;
        state.thinking = false; state.view.interactive = true; afterMove(); maybeAI();
      });
  } else {
    setTimeout(() => {
      if (state.epoch !== ep) return;
      localAIMove(state.level);
      state.thinking = false;
      state.view.interactive = true;
      afterMove();
      maybeAI();
    }, 360 + Math.random() * 240);
  }
}

function localAIMove(level) {
  const mv = GoAI.chooseMove(state.game, level);
  if (mv) pushPlay(mv.x, mv.y); else pushPass();
}

function afterMove() {
  state.view.draw();
  updateStatus();
  if (state.game.gameOver) endGame('双方虚手，对局结束');
}

function doPass() {
  if (!humanTurnNow()) return;
  pushPass();
  afterMove();
  maybeAI();
}

function doUndo() {
  if (state.mode === 'tsumego') { resetProblem(); return; }
  if (state.thinking || state.editing) return;
  if (state.trial && state.game.moveNumber <= state.trial.moveNumber) { flash('已在推演起点'); return; }
  let n = 0;
  if (state.game.undo()) n++;
  // 若悔棋后仍轮到 AI 方，再退一手回到自己
  if (!state.game.gameOver && aiControlsTurn() && state.game.undo()) n++;
  for (let i = 0; i < n; i++) state.moves.pop();
  if (n) {
    state.view.hintMove = null;
    state.view.draw();
    updateStatus();
    $('result').classList.remove('show');
  }
}

function doHint() {
  if (!humanTurnNow()) return;
  if (state.mode === 'tsumego') { showProblemHint(); return; }
  if (state.engine === 'katago') {
    const ep = state.epoch;
    flash('分析中…');
    kataQuery('/analyze', Math.max(state.kataVisits, 300))
      .then(r => {
        if (state.epoch !== ep) return;
        const mv = fromVertex(r.bestMove);
        if (mv) { state.view.hintMove = mv; state.view.draw(); }
        updateWinrate(r.winrate, r.scoreLead);
        const tops = r.candidates.slice(0, 3).map(c => c.move).join('  ');
        flash(`建议：${r.bestMove}　候选：${tops}`);
      })
      .catch(() => flash('后端未连接，无法分析'));
  } else {
    const mv = GoAI.chooseMove(state.game, 'medium');
    if (mv) { state.view.hintMove = mv; state.view.draw(); flash(`建议：${vertex(mv.x, mv.y)}`); }
    else flash('建议虚手（pass）');
  }
}

function doResign() {
  if (state.game.gameOver || state.editing) return;
  if (state.trial) { flash('推演中——先点「推演」返回实战再认输'); return; }
  // 认输方：不托管时为当前走子方，否则为人类执的一方
  const loser = state.aiSide === 0 ? state.game.turn : (state.aiSide === 1 ? 2 : 1);
  state.game.gameOver = true;
  endGame(`${loser === 1 ? '黑' : '白'}方认输 · ${loser === 1 ? '白' : '黑'}胜`, true);
}

/* ============================================================
 * 推演模式：对局中切入，黑白都手动摆（AI 暂停）；
 * 再次切换时回滚到切入前的局面并恢复 AI 执方
 * ============================================================ */
function setTrialButtons(on) {
  document.querySelectorAll('.btn-trial').forEach(b => b.classList.toggle('on', on));
}

function toggleTrial() {
  if (state.editing || state.game.gameOver) return;
  if (state.mode === 'tsumego' && !currentProblem()) return;
  if (!state.trial) {
    state.epoch++;                     // 丢弃在途的 AI 回包，避免它落进推演局面
    state.thinking = false;
    state.view.interactive = true;
    state.trial = { moveNumber: state.game.moveNumber, movesLen: state.moves.length,
                    aiSide: state.aiSide, judgeText: $('problemJudge') ? $('problemJudge').textContent : '' };
    state.aiSide = 0;
    setTrialButtons(true);
    flash(state.mode === 'tsumego'
      ? '推演开始：黑白都由你摆（仍限题目区域），再点「推演」返回'
      : '推演开始：黑白都由你落子，再点「推演」回到当前局面');
  } else {
    const t = state.trial;
    state.epoch++;
    while (state.game.moveNumber > t.moveNumber && state.game.undo());
    state.moves.length = Math.min(state.moves.length, t.movesLen);
    state.aiSide = t.aiSide;
    state.trial = null;
    setTrialButtons(false);
    setActive('[data-aiside]', document.querySelector(`[data-aiside="${state.aiSide}"]`));
    state.view.hintMove = null;
    state.view.draw();
    if (state.mode === 'tsumego' && $('problemJudge')) $('problemJudge').textContent = t.judgeText || '';
    flash('已回到推演前的局面');
    // 死活题：若返回时正轮白棋（推演切入时 KataGo 还没应手），让它接着应
    if (state.mode === 'tsumego' && state.game.turn === 2) scheduleProblemReply();
    else maybeAI();                    // 对局：若轮到 AI 方，接着下
  }
  updateStatus();
}

function exitTrialSilently() {
  // 换模式/新局/换题时直接丢弃推演状态（局面随后会被重建，无需回滚）
  if (!state.trial) return;
  state.aiSide = state.trial.aiSide;
  state.trial = null;
  setTrialButtons(false);
  setActive('[data-aiside]', document.querySelector(`[data-aiside="${state.aiSide}"]`));
}

/* ============================================================
 * 死活练习
 * ============================================================ */
function currentProblem() {
  return state.tsumego.problem;
}

function buildProblemBoard(problem) {
  const board = Array.from({ length: problem.size }, () => new Array(problem.size).fill(0));
  for (const p of problem.black) board[p.y][p.x] = 1;
  for (const p of problem.white) board[p.y][p.x] = 2;
  return board;
}

function setMode(mode) {
  if (state.editing) exitEditMode();
  exitTrialSilently();
  state.mode = mode;
  state.thinking = false;
  state.puzzleSolved = false;
  $('result').classList.remove('show');
  updateModeUI();
  if (mode === 'tsumego') {
    if (state.tsumego.problem) loadProblem(state.tsumego.collection, state.tsumego.index);
    else randomProblem();
  } else newGame();
}

function updateModeUI() {
  document.body.dataset.mode = state.mode;   // CSS 据此显隐 .game-only / .tsumego-only
  // 注意选择器须限定在标签按钮上：body 自身也带 data-mode 属性
  document.querySelectorAll('.mode-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === state.mode));
}

function populateTsumegoControls() {
  const sel = $('tsumegoCollection');
  if (!sel || !window.TSUMEGO) return;
  const opts = [`<option value="all">全部合集（共 ${TSUMEGO.totalCount()} 题）</option>`];
  for (const c of TSUMEGO.getCollections())
    opts.push(`<option value="${c.id}">${c.name}（${c.count} 题）</option>`);
  sel.innerHTML = opts.join('');
  sel.value = state.tsumego.collection === 'all' ? 'all' : state.tsumego.collection;
}

function loadProblem(cid, index) {
  const problem = TSUMEGO.getProblem(cid, index);
  if (!problem) return;
  state.mode = 'tsumego';
  state.epoch++;
  exitTrialSilently();
  state.tsumego.collection = cid;
  state.tsumego.index = problem.index;
  state.tsumego.problem = problem;
  state.puzzleSolved = false;
  state.boardSize = problem.size;
  state.moves = [];
  state.initialPlayer = 'B';
  state.game = new GoGame(problem.size);
  const board = buildProblemBoard(problem);
  state.game.setupPosition(board, 1);
  state.setupStones = boardToStones(board, problem.size);
  state.thinking = false;
  if (!state.view) { state.view = new BoardView($('board'), state.game, handleHumanPlay); state.view.onEdit = onEditChange; }
  state.view.editMode = false;
  state.view.interactive = true;
  state.view.viewport = problem.region;
  state.view.setGame(state.game);   // setGame 会按视口重新布局并聚焦题区
  hideSeal();
  $('result').classList.remove('show');
  $('problemTitle').textContent = problem.title;
  $('problemGoal').textContent = `${problem.goalText} · ${problem.level}`;
  $('problemJudge').textContent = '';
  $('problemNote').textContent = 'KataGo 执白应对，双方着手都限制在题目区域内。';
  // 候选点/讲解是本题专属，换题清掉；形势热力图是「粘性」开关，保留用户的开/关状态，
  // 若开着则为新局面重新拉一次归属数据（仅再次点「形势」才会关闭）。
  clearHintOverlay();
  setHeatButton(state.view.showHeat);
  refreshHeatIfOn();
  const input = $('problemIndexInput');
  if (input) { input.value = problem.index + 1; input.max = problem.count; }
  $('problemCount').textContent = `/ ${problem.count}`;
  const sel = $('tsumegoCollection');
  if (sel && sel.value !== 'all') sel.value = problem.collection;
  updateModeUI();
  updateStatus();
  flash(`${problem.goalText}：你执黑先手，KataGo 执白应对`);
}

function resetProblem() {
  if (state.mode !== 'tsumego' || !state.tsumego.problem) return;
  loadProblem(state.tsumego.collection, state.tsumego.index);
}

function randomProblem() {
  const sel = $('tsumegoCollection');
  const cid = sel ? sel.value : state.tsumego.collection;
  const ref = TSUMEGO.randomRef(cid);
  loadProblem(ref.collection, ref.index);
}

function stepProblem(delta) {
  const t = state.tsumego;
  if (!t.problem) { randomProblem(); return; }
  loadProblem(t.problem.collection, t.index + delta);
}

function jumpProblem() {
  const t = state.tsumego;
  const n = parseInt($('problemIndexInput').value, 10);
  if (!Number.isFinite(n)) return;
  loadProblem(t.problem ? t.problem.collection : t.collection, n - 1);
}

function tsumegoVisits(kind = 'reply') {
  if (state.tsumegoStrength === 'custom') {
    const v = state.tsumegoCustomVisits;
    return kind === 'hint' ? Math.max(v, 200) : v;   // 提示保底 200，太浅的建议没参考价值
  }
  if (state.tsumegoStrength === 'pro') return kind === 'hint' ? 1000 : 900;
  return kind === 'hint' ? 450 : 220;
}

/* 把题目区域之外的所有点设为双方禁着（搜索全程生效），让 KataGo 聚焦局部攻防 */
function tsumegoQueryOptions() {
  const problem = currentProblem();
  const opts = { includeOwnership: true };
  if (!problem) return opts;
  const r = problem.region, n = problem.size;
  const outside = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) outside.push(vertex(x, y));
  if (outside.length) {
    opts.avoidMoves = [
      { player: 'B', moves: outside, untilDepth: 64 },
      { player: 'W', moves: outside, untilDepth: 64 },
    ];
  }
  return opts;
}

function inProblemRegion(x, y) {
  const p = currentProblem();
  if (!p) return true;
  const r = p.region;
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function handleProblemPlay(x, y) {
  const problem = currentProblem();
  if (!problem) return;
  if (!inProblemRegion(x, y)) { flash('请在题目区域内落子'); return; }
  const res = pushPlay(x, y);
  if (!res.legal) { flash(reasonText(res.reason)); return; }
  hideSeal();
  clearHintOverlay();   // 候选点/讲解随局面改变而失效
  state.view.draw();
  updateStatus();
  if (state.trial) { scheduleTrialJudge(); return; }   // 推演中：不触发 KataGo 应手，只判死活
  scheduleProblemReply();
}

function scheduleProblemReply() {
  const problem = currentProblem();
  if (!problem || state.game.gameOver) return;
  const ep = state.epoch;   // 回包时已换题/重做则丢弃，避免旧应手落到新题面
  state.thinking = true;
  state.view.interactive = false;
  updateStatus();
  kataQuery('/genmove', tsumegoVisits('reply'), tsumegoQueryOptions())
    .then(r => {
      if (state.epoch !== ep) return;
      const mv = fromVertex(r.bestMove);
      const tenuki = mv && isTenukiMove(mv);   // 须在落子前用当前盘面判断
      if (mv) pushPlay(mv.x, mv.y); else pushPass();
      updateWinrate(r.winrate, r.scoreLead);
      const st = judgeProblem(r.ownership) || {};
      applyOwnershipViz(r.ownership);
      flash(composeReplyMessage(r.bestMove, mv, tenuki, st));
    })
    .catch(err => {
      if (state.epoch !== ep) return;
      console.warn(err);
      if (state.game.turn !== 1 && state.game.undo()) state.moves.pop();
      flash('KataGo 后端未连接：请先运行 backend/start.sh 并安装/配置 KataGo');
    })
    .finally(() => {
      if (state.epoch !== ep) return;
      state.thinking = false;
      state.view.interactive = true;
      state.view.draw();
      updateStatus();
    });
}

/* 白棋应手是否为脱先/弃子：落点与盘上任何棋子的棋盘距离都超过 2 路即视为放弃局部 */
function isTenukiMove(mv) {
  const b = state.game.board, n = state.game.size;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (b[y][x] && Math.max(Math.abs(x - mv.x), Math.abs(y - mv.y)) <= 2) return false;
  return true;
}

/* 组装白方应手的播报文案：普通应手 / 虚手 / 弃子转身，结合死活判定给出明确含义 */
function composeReplyMessage(bestMove, mv, tenuki, st) {
  let msg;
  if (!mv) {
    msg = st.whiteDead ? '白棋虚手认输——已无法做活' : '白棋虚手（无手可下）';
  } else if (tenuki) {
    msg = st.whiteDead
      ? `白棋弃子（改下 ${bestMove}）——这块已被你杀死`
      : `白棋脱先（${bestMove}）——它认为你上一手不影响死活`;
  } else {
    msg = `KataGo 应手：${bestMove}`;
  }
  if (st.solvedNow) msg += '　🎉 正解！';
  return msg;
}

/* 收到 ownership 后更新棋盘热力图；若已开启「形势」叠加则立即重绘 */
function applyOwnershipViz(ownership) {
  if (!state.view || !Array.isArray(ownership)) return;
  state.view.heatmap = ownership;
  if (state.view.showHeat) state.view.draw();
}

/* 纯计算：依据 KataGo ownership（黑视角，按行自左上排列）判断题区内双方棋块死活，
 * 返回状态标志与「局部判定：…」文案，无任何副作用（成败/盖印由调用方处理）。 */
function analyzeOwnership(ownership) {
  const problem = currentProblem();
  if (!problem || !Array.isArray(ownership)) return null;
  const n = problem.size, r = problem.region;
  let bSum = 0, bCnt = 0, wSum = 0, wCnt = 0;
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const s = state.game.board[y][x];
      const own = ownership[y * n + x];
      if (s === 1) { bSum += own; bCnt++; }
      else if (s === 2) { wSum += own; wCnt++; }
    }
  const bMean = bCnt ? bSum / bCnt : 0;   // >0 归黑
  const wMean = wCnt ? wSum / wCnt : 0;
  const whiteDead = wCnt > 0 && wMean > 0.55;
  const whiteAlive = wCnt > 0 && wMean < -0.45;
  const blackDead = bCnt > 0 && bMean < -0.55;
  const blackAlive = bCnt > 0 && bMean > 0.45;
  const parts = [];
  if (whiteDead) parts.push('白棋已净死');
  else if (whiteAlive) parts.push('白棋已安定');
  if (blackDead) parts.push('黑棋已阵亡');
  else if (blackAlive) parts.push('黑棋已安定');
  const verdict = parts.length ? `局部判定：${parts.join('，')}` : '局部判定：胜负未定';
  return { whiteDead, whiteAlive, blackDead, blackAlive, verdict };
}

/* 正式判定：在死活状态基础上结合题目目标给出成败、盖印并更新判定栏 */
function judgeProblem(ownership) {
  const problem = currentProblem();
  const st = analyzeOwnership(ownership);
  if (!problem || !st) return null;
  let verdict = st.verdict;
  const solved = (problem.goal === 'kill' && st.whiteDead) ||
                 (problem.goal === 'live' && st.blackAlive && !st.blackDead);
  const failed = (problem.goal === 'kill' && st.whiteAlive) ||
                 (problem.goal === 'live' && st.blackDead);
  const solvedNow = solved && !state.puzzleSolved;
  if (solvedNow) {
    state.puzzleSolved = true;
    verdict += ' — 🎉 目标达成！';
    showSeal('ok');
  } else if (failed) {
    verdict += ' — 目标落空，点「重做」再试';
    showSeal('fail');
  }
  $('problemJudge').textContent = verdict;
  return { ...st, solved, failed, solvedNow };
}

/* 推演模式的死活判定：请求 ownership 显示「已做活/已身亡」，
 * 但不计成败、不盖印、不改 puzzleSolved（推演只是试摆，不影响本题战绩）。 */
let trialJudgeToken = 0;
function scheduleTrialJudge() {
  if (!currentProblem() || !state.trial) return;
  const ep = state.epoch;
  const token = ++trialJudgeToken;   // 连续试摆时只保留最新一次判定，丢弃过期回包
  $('problemJudge').textContent = '局部判定：推演分析中…';
  kataQuery('/analyze', tsumegoVisits('reply'), tsumegoQueryOptions())
    .then(r => {
      if (state.epoch !== ep || token !== trialJudgeToken || !state.trial) return;
      const st = analyzeOwnership(r.ownership);
      if (!st) return;
      updateWinrate(r.winrate, r.scoreLead);
      applyOwnershipViz(r.ownership);
      $('problemJudge').textContent = st.verdict + '（推演）';
    })
    .catch(() => {
      if (state.epoch === ep && token === trialJudgeToken && state.trial)
        $('problemJudge').textContent = '局部判定：推演判定需 KataGo 后端';
    });
}

function showProblemHint() {
  if (state.mode !== 'tsumego' || state.thinking || !humanTurnNow()) return;
  const ep = state.epoch;
  const ex = $('problemExplain');
  if (ex) { ex.innerHTML = 'KataGo 分析中…'; ex.classList.add('show'); }
  flash('KataGo 分析中…');
  kataQuery('/analyze', tsumegoVisits('hint'), tsumegoQueryOptions())
    .then(r => {
      if (state.epoch !== ep) return;
      // 前三候选点标到棋盘（①首选／②③次选）
      const cands = (r.candidates || []).slice(0, 3)
        .map(c => { const p = pointFromVertex(c.move); return p ? { ...p, move: c.move } : null; })
        .filter(Boolean);
      state.view.candidates = cands.length ? cands : null;
      state.view.hintMove = cands[0] || null;
      state.view.showHeat = true;          // 提示同时点亮形势热力图
      setHeatButton(true);
      applyOwnershipViz(r.ownership);
      state.view.draw();
      updateWinrate(r.winrate, r.scoreLead);
      if (ex) ex.innerHTML = buildHintExplain(r);
      const tops = cands.map(c => c.move).join('  ');
      flash(`KataGo 建议：${r.bestMove}${tops ? `　候选：${tops}` : ''}`);
    })
    .catch(() => {
      if (ex) ex.innerHTML = 'KataGo 后端未连接，无法分析提示';
      flash('KataGo 后端未连接，无法分析提示');
    });
}

/* 规则化讲解：目标 + 急所推荐（据候选胜率差判断唯一性）+ 当前死活 + 原理提示 */
function buildHintExplain(r) {
  const p = currentProblem();
  if (!p) return '';
  const cands = r.candidates || [];
  const best = cands[0];
  const lines = [`<b>目标</b>：${p.goalText}`];
  if (best) {
    const gap = cands[1] ? best.winrate - cands[1].winrate : 1;
    const crit = gap > 0.12 ? '这是本题<b>急所</b>，几乎是唯一的一手'
      : gap > 0.04 ? '首选此点，另有其他可行下法'
        : '此处有多个价值接近的选择，可自行权衡';
    lines.push(`<b>推荐</b> <span class="hl">${best.move}</span>（黑胜率 ${Math.round(best.winrate * 100)}%）——${crit}。`);
    if (cands[1]) lines.push(`次选：${cands.slice(1, 3).map(c => c.move).join('、')}`);
  }
  const st = analyzeOwnership(r.ownership);
  if (st) lines.push(st.verdict.replace('局部判定：', '<b>当前形势</b>：'));
  lines.push(p.goal === 'kill' ? '<b>思路</b>：点在白棋做眼的要害，使它只能成一只眼。'
    : p.goal === 'live' ? '<b>思路</b>：抢占扩大眼位／做第二只眼的要点。'
      : '<b>思路</b>：先找双方都想抢的那个要点——敌之要点即我之要点。');
  return lines.join('<br>');
}

/* 形势热力图开关：开启时若尚无归属数据，拉一次分析补齐 */
function toggleHeat() {
  if (state.mode !== 'tsumego' || !currentProblem()) return;
  const on = !state.view.showHeat;
  state.view.showHeat = on;
  setHeatButton(on);
  if (on && !state.view.heatmap && !state.thinking) {
    const ep = state.epoch;
    flash('KataGo 分析形势中…');
    kataQuery('/analyze', tsumegoVisits('hint'), tsumegoQueryOptions())
      .then(r => { if (state.epoch === ep) applyOwnershipViz(r.ownership); })
      .catch(() => flash('KataGo 后端未连接，无法显示形势'));
  }
  state.view.draw();
}

function setHeatButton(on) {
  const b = $('btnHeat');
  if (b) { b.classList.toggle('on', on); b.textContent = on ? '形势 ✓' : '形势热力图'; }
}

/* 形势热力图开着时，为当前局面（含刚换的题）重新拉一次归属数据填充 */
function refreshHeatIfOn() {
  if (!state.view || !state.view.showHeat || !currentProblem() || state.thinking) return;
  const ep = state.epoch;
  kataQuery('/analyze', tsumegoVisits('reply'), tsumegoQueryOptions())
    .then(r => { if (state.epoch === ep) applyOwnershipViz(r.ownership); })
    .catch(() => {});
}

/* 清除提示相关的临时叠加（候选点、讲解），换手后调用；热力图保留由 showHeat 控制 */
function clearHintOverlay() {
  if (state.view) { state.view.candidates = null; state.view.hintMove = null; }
  const ex = $('problemExplain');
  if (ex) { ex.innerHTML = ''; ex.classList.remove('show'); }
}

/* —— KataGo 后端请求 —— */
async function kataQuery(path, maxVisits, extra = {}) {
  const res = await fetch(state.backendUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      moves: state.moves, size: state.boardSize,
      komi: state.komi, rules: 'chinese', maxVisits,
      initialStones: state.setupStones, initialPlayer: state.initialPlayer,
      ...extra,
    }),
  });
  if (!res.ok) throw new Error('backend ' + res.status);
  return res.json();
}

function endGame(msg, skipScore) {
  state.view.interactive = false;
  let detail = msg;
  if (!skipScore) {
    const s = state.game.estimateScore(state.komi);
    const diff = s.black - s.white;
    const who = diff > 0 ? '黑' : '白';
    detail = `${msg}<br><span class="score">黑 ${s.black} &nbsp;·&nbsp; 白 ${s.white.toFixed(1)}（含贴目 ${s.komi}）</span><br>` +
             `<strong>${who}方领先 ${Math.abs(diff).toFixed(1)} 目</strong><br><em>（粗略估算，假设盘上棋块均存活）</em>`;
  }
  $('resultText').innerHTML = detail;
  $('result').classList.add('show');
  updateStatus();
}

/* —— 印章（正解 / 再思）—— */
function showSeal(kind) {
  const s = $('seal');
  s.textContent = kind === 'ok' ? '正解' : '再思';
  s.className = 'seal';
  void s.offsetWidth;               // 重置动画，使连续盖章也能重播
  s.className = `seal show ${kind}`;
  clearTimeout(showSeal._t);
  if (kind === 'fail') showSeal._t = setTimeout(hideSeal, 1800);
}
function hideSeal() {
  clearTimeout(showSeal._t);
  $('seal').className = 'seal';
}

/* —— 界面更新 —— */
function updateStatus() {
  const g = state.game;
  $('turnIndicator').classList.toggle('thinking', state.thinking);
  $('moveNum').textContent = g.moveNumber;
  $('capBlack').textContent = g.captures[1];
  $('capWhite').textContent = g.captures[2];
  const turnEl = $('turnIndicator');
  if (state.mode === 'tsumego') {
    const p = currentProblem();
    if (!p) return;
    const dot = `<span class="stone-dot ${g.turn === 1 ? 'black' : 'white'}"></span>`;
    if (state.trial) {
      turnEl.innerHTML = `${dot}<span class="turn-label">${g.turn === 1 ? '黑' : '白'}方 · 推演中（点「推演」返回）</span>`;
      return;
    }
    if (state.puzzleSolved) {
      turnEl.innerHTML = '<span class="turn-label">死活题完成 · 目标达成 🎉</span>';
      return;
    }
    const who = state.thinking ? 'KataGo（白）应手中…' : '你执黑先手';
    turnEl.innerHTML = `${dot}<span class="turn-label">${g.turn === 1 ? '黑' : '白'}方 · ${who}</span>`;
    return;
  }
  if (g.gameOver) { turnEl.innerHTML = '<span class="turn-label">对局结束</span>'; return; }
  const dot = `<span class="stone-dot ${g.turn === 1 ? 'black' : 'white'}"></span>`;
  if (state.trial) {
    turnEl.innerHTML = `${dot}<span class="turn-label">${g.turn === 1 ? '黑' : '白'}方 · 推演中（点「推演」返回实战）</span>`;
    return;
  }
  const who = !aiControlsTurn() ? '该你落子'
    : (state.thinking ? (state.engine === 'katago' ? 'KataGo 计算中…' : 'AI 思考中…') : 'AI 行棋');
  turnEl.innerHTML = `${dot}<span class="turn-label">${g.turn === 1 ? '黑' : '白'}方 · ${who}</span>`;
}

function updateWinrate(wrBlack, scoreLead) {
  const pct = Math.round(wrBlack * 100);
  $('wrFill').style.width = pct + '%';
  $('wrBlack').textContent = pct + '%';
  $('wrWhite').textContent = (100 - pct) + '%';
  const lead = scoreLead > 0 ? `黑 +${scoreLead}` : (scoreLead < 0 ? `白 +${(-scoreLead)}` : '均势');
  $('wrLead').textContent = (state.engine === 'katago' || state.mode === 'tsumego') ? `目差 ${lead}` : '（本地 AI 无胜率估计）';
}

function flash(text) {
  const el = $('message');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function reasonText(r) {
  return { suicide: '禁着点：此处无气', ko: '打劫：不可立即回提', occupied: '该点已有子' }[r] || '不可落子';
}

/* ============================================================
 * 上传截图 → 识别 → 人工校正 → 应用并同步
 * ============================================================ */
function handleUpload(file) {
  if (!file) { flash('未选择图片'); return; }
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '')) {
    flash('请选择图片文件（PNG/JPG）'); return;
  }
  const reader = new FileReader();
  reader.onerror = () => flash('读取图片失败，请重试');
  reader.onload = () => {
    if (!reader.result) { flash('读取图片失败，请重试'); return; }
    state.pendingImage = reader.result;
    recognizeImage();
  };
  reader.readAsDataURL(file);
}

function recognizeImage(forceSize) {
  if (!state.pendingImage) { flash('请先点「上传截图」选择图片'); return; }
  flash('识别中…');
  fetch(state.backendUrl + '/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: state.pendingImage, size: forceSize }),
  })
    .then(r => r.json().then(j => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) throw new Error(j.error || '识别失败');
      enterEditMode(j.size, j.board, guessTurn(j.board));
      flash(`识别完成（置信度 ${(j.confidence * 100).toFixed(0)}%），请核对后应用`);
    })
    .catch(e => flash('识别失败：' + e.message));
}

/* 依黑白子数猜测轮走方：黑先，黑白相等→轮黑，黑多一子→轮白 */
function guessTurn(board) {
  let b = 0, w = 0;
  for (const row of board) for (const v of row) { if (v === 1) b++; else if (v === 2) w++; }
  return b > w ? 2 : 1;
}

function enterEditMode(size, board, turn) {
  state.editing = true;
  state.boardSize = size;
  state.editTurn = turn;
  state.editGame = new GoGame(size);
  state.editGame.setupPosition(board, turn);
  state.view.setGame(state.editGame);
  state.view.editMode = true;
  state.view.resize();
  // 同步校正面板控件状态
  setActive('[data-editsize]', document.querySelector(`[data-editsize="${size}"]`));
  setActive('[data-editturn]', document.querySelector(`[data-editturn="${turn}"]`));
  $('editPanel').classList.add('show');
  onEditChange();
}

function onEditChange() {
  if (!state.editGame) return;
  let b = 0, w = 0;
  for (const row of state.editGame.board) for (const v of row) { if (v === 1) b++; else if (v === 2) w++; }
  $('editCount').textContent = `黑 ${b} · 白 ${w}`;
}

function exitEditMode() {
  state.editing = false;
  state.editGame = null;
  state.view.editMode = false;
  $('editPanel').classList.remove('show');
  state.view.setGame(state.game);
  state.view.resize();
}

function confirmEdit() {
  const board = state.editGame.board.map(r => r.slice());
  const size = state.boardSize;
  const turn = state.editTurn;
  exitEditMode();
  applyImportedPosition(size, board, turn);
  // 同步到后端，供其它设备（PC）拉取
  fetch(state.backendUrl + '/position', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size, board, turn, source: state.clientId }),
  })
    .then(r => r.json())
    .then(j => { if (j.version) state.lastPosVersion = j.version; flash('已应用并同步到 PC'); })
    .catch(() => flash('已应用（同步失败，后端未连接）'));
}

/* 把任意布局载入为当前对局 */
function applyImportedPosition(size, board, turn) {
  state.epoch++;
  state.boardSize = size;
  state.game = new GoGame(size);
  state.game.setupPosition(board, turn);
  state.moves = [];
  state.setupStones = boardToStones(board, size);
  state.initialPlayer = turn === 2 ? 'W' : 'B';
  state.thinking = false;
  setActive('[data-size]', document.querySelector(`[data-size="${size}"]`));
  state.view.setGame(state.game);
  state.view.interactive = true;
  state.view.resize();
  $('result').classList.remove('show');
  updateWinrate(0.5, 0);
  updateStatus();
  maybeAI(); // 若轮到 AI 托管的一方，自动接管落子
}

function boardToStones(board, size) {
  const stones = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (board[y][x]) stones.push([board[y][x] === 1 ? 'B' : 'W', LETTERS[x] + (size - y)]);
  return stones;
}

/* —— PC 端轮询：自动同步手机上传的最新布局 —— */
function pollPosition(applyEvenIfOwn) {
  if (state.mode !== 'game') return;
  fetch(state.backendUrl + '/position')
    .then(r => r.json())
    .then(j => {
      if (!j || !j.version || j.version <= state.lastPosVersion) return;
      if (state.editing) return;                         // 正在校正时不打断
      if (j.source === state.clientId && !applyEvenIfOwn) { state.lastPosVersion = j.version; return; }
      state.lastPosVersion = j.version;
      applyImportedPosition(j.size, j.board, j.turn || 1);
      flash('已同步手机上传的最新布局');
    })
    .catch(() => {});
}

/* —— 控件绑定 —— */
function bindControls() {
  populateTsumegoControls();
  document.querySelectorAll('.mode-tabs button').forEach(btn =>
    btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  document.querySelectorAll('[data-size]').forEach(btn =>
    btn.addEventListener('click', () => { setActive('[data-size]', btn); state.boardSize = +btn.dataset.size; newGame(); }));
  document.querySelectorAll('[data-aiside]').forEach(btn =>
    btn.addEventListener('click', () => {
      if (state.trial) { flash('推演中不能切换 AI 执方，先点「推演」返回'); return; }
      setActive('[data-aiside]', btn);
      state.aiSide = +btn.dataset.aiside;
      updateStatus();
      maybeAI(); // 切换后若已轮到 AI 方，立即接管
    }));
  // 对局对手强度：本地两档 / KataGo 两档预设 / KataGo 自定义思考量（滑杆，记住数值）
  state.gameCustomVisits = parseInt(localStorage.getItem('gameVisits'), 10) || state.gameCustomVisits;
  $('gameVisitsRange').value = state.gameCustomVisits;
  $('gameVisitsVal').textContent = state.gameCustomVisits;
  document.querySelectorAll('[data-engine]').forEach(btn =>
    btn.addEventListener('click', () => {
      setActive('[data-engine]', btn);
      state.engine = btn.dataset.engine;
      if (btn.dataset.level) state.level = btn.dataset.level;
      if (btn.dataset.visits) state.kataVisits = +btn.dataset.visits;
      if (btn.dataset.custom) state.kataVisits = state.gameCustomVisits;
      $('gameCustom').classList.toggle('show', !!btn.dataset.custom);
      updateWinrate(0.5, 0);
      if (state.engine === 'katago') {
        flash(`KataGo 思考量：${state.kataVisits} visits`);
        checkBackend();
      }
    }));
  $('gameVisitsRange').addEventListener('input', () => {
    state.gameCustomVisits = +$('gameVisitsRange').value;
    $('gameVisitsVal').textContent = state.gameCustomVisits;
    localStorage.setItem('gameVisits', String(state.gameCustomVisits));
    if ($('gameCustom').classList.contains('show')) state.kataVisits = state.gameCustomVisits;
  });
  // 死活强度：高阶 / 职业 / 自定义（滑杆控制 visits，记住上次选择）
  const applyStrengthUI = () => {
    $('tsumegoCustom').classList.toggle('show', state.tsumegoStrength === 'custom');
    $('visitsRange').value = state.tsumegoCustomVisits;
    $('visitsVal').textContent = state.tsumegoCustomVisits;
    setActive('[data-tsumego-strength]', document.querySelector(`[data-tsumego-strength="${state.tsumegoStrength}"]`));
  };
  state.tsumegoStrength = localStorage.getItem('tsumegoStrength') || state.tsumegoStrength;
  state.tsumegoCustomVisits = parseInt(localStorage.getItem('tsumegoVisits'), 10) || state.tsumegoCustomVisits;
  applyStrengthUI();
  document.querySelectorAll('[data-tsumego-strength]').forEach(btn =>
    btn.addEventListener('click', () => {
      state.tsumegoStrength = btn.dataset.tsumegoStrength;
      localStorage.setItem('tsumegoStrength', state.tsumegoStrength);
      applyStrengthUI();
      flash(`死活强度：${btn.textContent}（应手 ${tsumegoVisits('reply')} visits）`);
    }));
  $('visitsRange').addEventListener('input', () => {
    state.tsumegoCustomVisits = +$('visitsRange').value;
    $('visitsVal').textContent = state.tsumegoCustomVisits;
    localStorage.setItem('tsumegoVisits', String(state.tsumegoCustomVisits));
  });
  $('btnNew').addEventListener('click', newGame);
  $('btnPass').addEventListener('click', doPass);
  $('btnUndo').addEventListener('click', doUndo);
  $('btnHint').addEventListener('click', doHint);
  $('btnTrial').addEventListener('click', toggleTrial);
  $('btnTrialTsumego').addEventListener('click', toggleTrial);
  $('btnResign').addEventListener('click', doResign);
  $('btnProblemHint').addEventListener('click', showProblemHint);
  { const hb = $('btnHeat'); if (hb) hb.addEventListener('click', toggleHeat); }
  $('btnProblemReset').addEventListener('click', resetProblem);
  $('btnProblemRandom').addEventListener('click', randomProblem);
  $('btnProblemPrev').addEventListener('click', () => stepProblem(-1));
  $('btnProblemNext').addEventListener('click', () => stepProblem(1));
  $('btnProblemGo').addEventListener('click', jumpProblem);
  $('problemIndexInput').addEventListener('keydown', e => { if (e.key === 'Enter') jumpProblem(); });
  $('tsumegoCollection').addEventListener('change', () => {
    if (state.mode === 'tsumego') randomProblem();
  });
  // 上传与校正
  $('fileInput').addEventListener('change', e => { handleUpload(e.target.files[0]); e.target.value = ''; });
  $('btnUpload').addEventListener('click', () => $('fileInput').click());
  $('btnEditApply').addEventListener('click', confirmEdit);
  $('btnEditCancel').addEventListener('click', exitEditMode);
  document.querySelectorAll('[data-editsize]').forEach(btn =>
    btn.addEventListener('click', () => { setActive('[data-editsize]', btn); recognizeImage(+btn.dataset.editsize); }));
  document.querySelectorAll('[data-editturn]').forEach(btn =>
    btn.addEventListener('click', () => { setActive('[data-editturn]', btn); state.editTurn = +btn.dataset.editturn; }));
}

function setActive(selector, btn) {
  document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function checkBackend() {
  fetch(state.backendUrl + '/health')
    .then(r => r.ok ? flash('KataGo 后端已连接 ✅') : flash('后端无响应'))
    .catch(() => flash('⚠ KataGo 后端未启动，请先运行 backend/start.sh'));
}

window.addEventListener('DOMContentLoaded', () => {
  bindControls();
  newGame();
  pollPosition(true);                  // 刷新即同步最新布局（含本机此前上传的）
  setInterval(() => pollPosition(false), 3000);
});
