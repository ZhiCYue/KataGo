# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

浏览器版围棋（「弈枰」），前端纯静态 + Python 后端包住 KataGo。是后续微信小程序的规则与 AI 逻辑原型（个人主体先做网页版）。**界面为移动优先设计**，主场景是手机上练死活题；桌面端 ≥920px 切双栏。项目内注释、文案、README 均为中文，新增文案请沿用中文。

## 运行与开发

```bash
bash backend/start.sh          # 单端口(8000)同时伺服网页 + API(/api/*)；自动定位 python/katago/权重/配置
# 浏览器打开启动日志里带 ?key= 的链接
```

- **无构建步骤、无测试框架、无 lint**：前端是原生 HTML/CSS/JS（无打包器、无 npm），改完刷新即可。
- `start.sh` 会挑一个装了 `numpy`/`cv2` 的 python（系统 `/usr/bin/python3` 通常没有）。缺依赖时：`python3.11 -m pip install opencv-python numpy`。
- 没装 KataGo 也能跑（仅识别/同步模式，KataGo 接口返回 503）：`python3.11 backend/server.py --port 8000`。
- 关闭访问令牌校验（仅本机/局域网调试）：`NO_TOKEN=1 bash backend/start.sh`。换令牌：删 `backend/.token` 重启。
- 重新生成死活题库：`python3 tools/build_tsumego_bank.py`（会覆盖 `js/tsumego-bank.js`）。

## 架构要点

前端由 `js/main.js` 作为主控，串起规则引擎、AI、棋盘视图、后端与界面。理解全貌需要跨文件阅读，以下是不易从单文件看出的关键设计：

### 全局状态与文件职责
- **`js/main.js`（主控）**：全局单例 `state` 对象持有一切运行时状态（`game` 引擎实例、`view` 棋盘、`mode`、`aiSide`、`engine`、`moves` 着手序列、`trial` 推演快照等）。所有交互回调、KataGo 请求、界面更新都在这里。
- **`js/engine.js`（`GoGame`）**：纯规则引擎。棋盘 `board[y][x]`，`0` 空 / `1` 黑 / `2` 白。负责气、提子、禁着点（自杀）、**位置超劫**（`positionHistory` 记录出现过的局面哈希）。`setupPosition()` 用于载入上传识别的任意布局。
- **`js/board.js`（`BoardView`）**：Canvas 渲染与点击交互，含上传布局的「校正模式」与死活的 `viewport` 局部聚焦裁剪。
- **`js/ai.js`**：本地启发式 AI（弱，约业余级，无需后端）。
- **`js/tsumego.js`（`window.TSUMEGO`）**：死活题库访问层。`getProblem()` 解码 SGF 坐标、`computeRegion()` 算聚焦区域、`guessGoal()` 推断目标（做活/杀白等）。
- **`js/tsumego-bank.js`**：约 4300 题数据，**由 SGF 自动生成，勿手改**（改数据请改 `tools/build_tsumego_bank.py` 重新生成）。全部题目已统一为**黑先**。

### 两种模式：对局 / 死活
`state.mode` 在 `'game'` 与 `'tsumego'` 间切换，共用同一引擎与视图但走子逻辑不同：
- **对局**：`aiSide`（0/1/2）决定 AI 托管哪方，`aiControlsTurn()` 触发 `scheduleAI()`。
- **死活**：用户永远执黑先手，KataGo 执白应对。通过 `tsumegoQueryOptions()` 生成 KataGo 的 `avoidMoves`，把题目区域外的点设为双方禁着（搜索全程生效），实现「局部限手」。每步 AI 应手后 `judgeProblem(ownership)` 用归属图判断题区内棋块死活（净死/安定/未定）——注意黑白死活是**分别独立判定**的两条结论。死活状态的纯计算在 `analyzeOwnership()`（无副作用），`judgeProblem()` 在其上加成败/盖印，推演判定 `scheduleTrialJudge()` 复用它但不计战绩。
- **死活提示与可视化**：`showProblemHint()` 拉 `/analyze`，把前三候选点写入 `view.candidates`（棋盘标①②③）、`applyOwnershipViz()` 存 `view.heatmap` 并在 `view.showHeat` 时叠加形势热力图、`buildHintExplain()` 生成规则化讲解填入 `#problemExplain`。热力图与候选点渲染都在 `board.js` 的 `draw()`；换手 `clearHintOverlay()` 清候选/讲解。形势热力图开关（`view.showHeat`）是**粘性**的：跨重做/换题保持，`loadProblem` 不重置它，只在开着时 `refreshHeatIfOn()` 为新局面重新拉归属；仅再次点「形势」才关闭。

### epoch：丢弃迟到的异步回包
`state.epoch` 是「局面代数」，换题/新局/重做时 `+1`。每个 KataGo 请求发出前记下 `ep = state.epoch`，回包时若 `state.epoch !== ep` 则直接丢弃。**任何新增的异步 KataGo 交互都必须遵守这个模式**，否则旧应手会落到新题面上。

### 推演模式（trial）
死活中盘可切入手动推演：`toggleTrial()` 存快照 `{moveNumber, movesLen, aiSide}`，推演时黑白都可手动摆且不触发 KataGo；返回时回滚到快照局面（`doUndo` 到 `trial.moveNumber` 即停）。切模式/新局会 `exitTrialSilently()` 静默还原 `aiSide`。

### 后端（`backend/server.py`）
单文件 `http.server`，**网页与 API 同源同端口**，接口挂在 `/api/*`（兼容无前缀旧路径）。
- **`KataGo` 类**：常驻 `katago analysis` 子进程，JSON 行协议按 query id 收发。未装 KataGo 时 `Handler.katago = None`，对弈/分析接口降级返回 503。
- **访问令牌**：`_authorized()` 校验 `?key=`（验证后种 90 天 Cookie）或 `X-Access-Key` 头。挂公网必备，防陌生人白嫖算力。
- **静态伺服**：只放行 `index.html`/`css`/`js`，后端源码与 `models/` 不通过公网暴露。
- **`recognize.py`**：OpenCV 截图棋盘识别（Hough 找网格 + 覆盖率判子）。
- **`PositionStore`**：跨设备布局同步，前端每 3 秒轮询 `GET /api/position`（带递增 `version`）。

### 坐标系约定（易踩坑）
- 引擎内部：`board[y][x]`，`0/1/2`。
- GTP/KataGo 顶点：字母列（跳过 I）+ 数字行，如 `Q16`。`vertex()`/`fromVertex()` 互转，`LETTERS = 'ABCDEFGHJKLMNOPQRST'`。
- SGF（题库）：两字母小写，列在前行在后，左上角 `aa`。`tsumego.js` 内 `decodePoints()` 解码。

## 公网访问
一条 Cloudflare Tunnel 即可（网页 + API 同端口）：`cloudflared tunnel --url http://localhost:8000`。
