/* ============================================================
 * 应用主控：连接规则引擎、AI（本地启发式 / KataGo 后端）、棋盘视图与界面
 * ============================================================ */
const LETTERS = 'ABCDEFGHJKLMNOPQRST';

const state = {
  game: null,
  view: null,
  boardSize: 19,
  aiSide: 2,              // AI 执方：0 不托管 / 1 黑 / 2 白（默认 AI 执白，人执黑）
  engine: 'local',        // 'local' 本地启发式 | 'katago' 神经网络
  level: 'medium',        // 本地难度
  kataVisits: 200,        // KataGo 算力（越大越强）
  komi: 7.5,
  thinking: false,
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
};

const $ = id => document.getElementById(id);
const vertex = (x, y) => LETTERS[x] + (state.boardSize - y);
function fromVertex(v) {
  if (v === 'pass') return null;
  return { x: LETTERS.indexOf(v[0].toUpperCase()), y: state.boardSize - parseInt(v.slice(1), 10) };
}

/* —— 轮走判定 —— */
function aiControlsTurn() { return state.aiSide !== 0 && state.game.turn === state.aiSide; }
function humanTurnNow() {
  return !state.editing && !state.thinking && !state.game.gameOver && !aiControlsTurn();
}
function maybeAI() { if (!state.game.gameOver && aiControlsTurn()) scheduleAI(); }

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
  state.game = new GoGame(state.boardSize);
  state.moves = [];
  state.setupStones = [];
  state.initialPlayer = 'B';
  if (state.view) state.view.setGame(state.game);
  else { state.view = new BoardView($('board'), state.game, handleHumanPlay); state.view.onEdit = onEditChange; }
  state.thinking = false;
  $('result').classList.remove('show');
  updateWinrate(0.5, 0);
  updateStatus();
  maybeAI(); // 若 AI 执黑则先行
}

function handleHumanPlay(x, y) {
  if (!humanTurnNow()) return;
  const res = pushPlay(x, y);
  if (!res.legal) { flash(reasonText(res.reason)); return; }
  state.view.hintMove = null;
  afterMove();
  maybeAI();
}

function scheduleAI() {
  if (state.game.gameOver) return;
  state.thinking = true;
  state.view.interactive = false;
  updateStatus();

  if (state.engine === 'katago') {
    kataQuery('/genmove', state.kataVisits)
      .then(r => {
        const mv = fromVertex(r.bestMove);
        if (mv) pushPlay(mv.x, mv.y); else pushPass();
        updateWinrate(r.winrate, r.scoreLead);
      })
      .catch(err => {
        console.warn(err);
        flash('KataGo 后端未连接，本手改用本地 AI');
        localAIMove('medium');
      })
      .finally(() => { state.thinking = false; state.view.interactive = true; afterMove(); maybeAI(); });
  } else {
    setTimeout(() => {
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
  if (state.thinking || state.editing) return;
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
  if (state.engine === 'katago') {
    flash('分析中…');
    kataQuery('/analyze', Math.max(state.kataVisits, 300))
      .then(r => {
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
  // 认输方：不托管时为当前走子方，否则为人类执的一方
  const loser = state.aiSide === 0 ? state.game.turn : (state.aiSide === 1 ? 2 : 1);
  state.game.gameOver = true;
  endGame(`${loser === 1 ? '黑' : '白'}方认输 · ${loser === 1 ? '白' : '黑'}胜`, true);
}

/* —— KataGo 后端请求 —— */
async function kataQuery(path, maxVisits) {
  const res = await fetch(state.backendUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      moves: state.moves, size: state.boardSize,
      komi: state.komi, rules: 'chinese', maxVisits,
      initialStones: state.setupStones, initialPlayer: state.initialPlayer,
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

/* —— 界面更新 —— */
function updateStatus() {
  const g = state.game;
  $('moveNum').textContent = g.moveNumber;
  $('capBlack').textContent = g.captures[1];
  $('capWhite').textContent = g.captures[2];
  const turnEl = $('turnIndicator');
  if (g.gameOver) { turnEl.innerHTML = '<span class="turn-label">对局结束</span>'; return; }
  const dot = `<span class="stone-dot ${g.turn === 1 ? 'black' : 'white'}"></span>`;
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
  $('wrLead').textContent = state.engine === 'katago' ? `目差 ${lead}` : '（本地 AI 无胜率估计）';
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
  document.querySelectorAll('[data-size]').forEach(btn =>
    btn.addEventListener('click', () => { setActive('[data-size]', btn); state.boardSize = +btn.dataset.size; newGame(); }));
  document.querySelectorAll('[data-aiside]').forEach(btn =>
    btn.addEventListener('click', () => {
      setActive('[data-aiside]', btn);
      state.aiSide = +btn.dataset.aiside;
      updateStatus();
      maybeAI(); // 切换后若已轮到 AI 方，立即接管
    }));
  document.querySelectorAll('[data-engine]').forEach(btn =>
    btn.addEventListener('click', () => {
      setActive('[data-engine]', btn);
      state.engine = btn.dataset.engine;
      if (btn.dataset.level) state.level = btn.dataset.level;
      if (btn.dataset.visits) state.kataVisits = +btn.dataset.visits;
      updateWinrate(0.5, 0);
      if (state.engine === 'katago') checkBackend();
    }));
  $('btnNew').addEventListener('click', newGame);
  $('btnPass').addEventListener('click', doPass);
  $('btnUndo').addEventListener('click', doUndo);
  $('btnHint').addEventListener('click', doHint);
  $('btnResign').addEventListener('click', doResign);

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
