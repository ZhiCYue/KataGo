# 弈枰 · 围棋人机对弈

浏览器版围棋，支持本地启发式 AI 与 **KataGo 神经网络**（职业级）对弈，含实时胜率 / 形势分析。
本项目为后续微信小程序的规则与 AI 逻辑原型（个人主体先做网页版，规避小程序游戏类目资质问题）。

界面为**移动优先**设计（主要使用场景是手机上练死活题）：顶栏切换「对局 / 死活」两种模式，
棋盘满宽显示，常用操作集中在底部黑漆行动坞（拇指可达，适配 iPhone 安全区）；
死活题答对时棋盘上会盖一枚朱砂「正解」印，失败则是墨印「再思」。桌面端 ≥920px 自动切回双栏布局。

## 目录结构

```
index.html            入口页面
css/style.css         界面样式（水墨与木风格）
js/engine.js          围棋规则引擎（气 / 提子 / 禁着点 / 打劫）
js/ai.js              本地启发式 AI（弱，约业余级，无需后端）
js/board.js           Canvas 棋盘渲染与交互（含上传布局的「校正模式」）
js/main.js            主控：引擎 / AI / KataGo 后端 / 上传同步 / 界面
js/tsumego.js         死活训练：题库访问、题目区域（聚焦/限手）计算
js/tsumego-bank.js    经典死活题库数据（约 4300 题，由 SGF 自动生成，勿手改）
backend/server.py     后端（KataGo + 截图识别 + 跨设备布局同步）
backend/recognize.py  截图棋盘识别（OpenCV：Hough 找网格 + 覆盖率判子）
backend/start.sh      后端一键启动脚本
tools/build_tsumego_bank.py  下载经典死活 SGF 并生成 js/tsumego-bank.js
models/               KataGo 神经网络权重（.bin.gz）
```

## 手机访问（局域网，无需内网穿透）

手机与电脑连同一 WiFi 即可：

1. 电脑上启动服务（见下）。服务默认绑定 `0.0.0.0`，手机可达。
2. 查电脑局域网 IP（macOS：`ipconfig getifaddr en0`），手机浏览器打开 `http://<电脑IP>:8000/`。
3. 网页与 API 同源同端口，识别 / 同步 / KataGo 均可用。

> 连不上多半是 macOS 防火墙拦截，到「系统设置 → 网络 → 防火墙」放行 python 的传入连接。

## 公网访问（Cloudflare Tunnel）

网页与 API 已合并到**同一端口**、接口挂在 `/api/*` 下，所以一条隧道即可：

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8000
```

它会输出一个 `https://xxx.trycloudflare.com` 公网地址，手机用流量/异地都能访问，前端的同源 `/api` 请求自动随之走通。原理：cloudflared 主动向 Cloudflare 建一条出站隧道，外部流量经 Cloudflare 边缘回推到本机，无需公网 IP / 端口转发。

> 进程停止隧道即失效；快速模式的随机域名每次重启会变（要固定域名需用「命名隧道」+ 自有域名）。

### 访问令牌（挂公网必备）

`start.sh` 首次启动会生成随机令牌存入 `backend/.token`（已 gitignore），之后所有请求（网页 + API）都需携带：

- 访问链接后加 `?key=令牌`（见启动日志打印的完整链接）；**浏览器验证一次后种 Cookie（90 天），之后无需再带**。
- API 调用也可用 `X-Access-Key: 令牌` 请求头。
- 无令牌访问：网页返回 403 提示页，API 返回 401，KataGo 算力不会被陌生人白嫖。
- 仅本机/局域网调试想关掉校验：`NO_TOKEN=1 bash backend/start.sh`；换令牌：删除 `backend/.token` 重启。

## 上传截图识别 + 跨设备同步

- 点右侧「📷 上传截图识别棋盘」，选/拍一张**数字棋盘截图**（围棋 App / 对弈网站，正视、线条清晰）。
- 后端用 OpenCV 识别盘面，进入**校正模式**：在棋盘上点交叉点循环切换 空→黑→白，并可选路数与轮走方。
- 点「应用并同步」：本机立即载入该布局，同时上传后端。
- **其它设备（如 PC）刷新或保持页面打开，会自动拉取并载入最新布局**（每 3 秒轮询）。
- 「AI 执方」可切换由 AI 托管黑方 / 白方 / 不托管；切到 AI 的一方时它会自动接管落子。

> 识别与同步无需 KataGo；仅缺 KataGo 时后端以「仅识别/同步」模式运行（`/genmove`、`/analyze` 返回 503）。

## 运行

**一个服务、一个端口**搞定网页 + API（接口在 `/api/*` 下），不再需要单独的 `http.server`。

```bash
brew install katago                          # 一次性安装（仅对弈/分析需要）
python3.11 -m pip install opencv-python numpy # 截图识别依赖（装到 brew 的 python3.11）
# 网络权重已放在 models/kata-network.bin.gz
bash backend/start.sh                         # 监听 0.0.0.0:8000，伺服网页 + API
# 浏览器打开 http://127.0.0.1:8000/
```

「入门 / 进阶 · 本地」难度无需 KataGo 即可对弈；选「高段 / 职业 · KataGo」用神经网络。

> `start.sh` 会自动挑一个装了 numpy/cv2 的 python 运行（系统自带的 `/usr/bin/python3` 没有这些包）。
> 没装 KataGo 也能用上传识别 + 同步：`python3.11 backend/server.py --port 8000`（KataGo 接口返回 503）。
> 静态伺服只放行 `index.html` / `css` / `js`，后端源码与 models 不会通过公网暴露。

## 死活训练（经典题库 + KataGo 陪练）

右侧「模式」切到「死活」进入训练。题库为 7 部经典合集共约 **4341 题**（`js/tsumego-bank.js`）：

| 合集 | 题数 | 难度 |
|------|------|------|
| 赵治勋《死活大百科》初级 | 900 | 约 20k–8k |
| 赵治勋《死活大百科》中级 | 861 | 约 10k–4k |
| 赵治勋《死活大百科》高级 | 792 | 约 3k–业余高段 |
| 李昌镐《精讲死活》 | 738 | 六卷逐卷加深 |
| 《棋经众妙》（1822） | 520 | 分做活/杀棋/打劫/对杀/倒扑/连接/手筋七类 |
| 《玄玄棋经》（1349） | 347 | 业余高段 |
| 《发阳论》（1713） | 183 | 极高难度 |

训练方式与体验：

- **统一黑先**：原题白先的已自动黑白互换，你永远执黑先手，KataGo 执白应对（做活/最强抵抗）。
- **聚焦局部**：棋盘只显示题目区域（自动按棋子包围盒 + 余量计算，贴边吸附）；被裁开的方向网格线外溢示意棋盘延续，真实棋盘边加粗。
- **AI 限手**：通过 KataGo `avoidMoves` 把题区外的点设为双方禁着（搜索全程生效），AI 不会脱先他投，你也只能在题区内落子——真正的局部死活攻防。
- **死活判定**：每步 AI 应手后用 ownership 判断题区内双方棋块死活（净死/安定/未定），达成目标（杀白或做活）自动提示 🎉。
- **选题**：下拉选合集（或全部合集），「🎲 随机一题」加权随机抽题，也可上一题/下一题/输入题号跳转。
- 死活强度分「高阶 / 职业」两档：高阶应手约 220 visits、提示约 450 visits；职业应手约 900 visits、提示约 1000 visits。
- KataGo 应手需要后端以 KataGo 模式启动；仅静态打开页面时可以看题面，但无法获得智能应手。
- 搜索框通过后端 `/api/tsumego-search` 返回公开网页链接；仅展示标题与 URL，不抓取或复制网页题面。

> 题库来源：[tasuki tsumego collections](https://tsumego.tasuki.org/)（SGF 由 [Seon82/tasuki2sgf](https://github.com/Seon82/tasuki2sgf) 整理），题面为公版/公开整理内容、不含解答。重新生成题库：`python3 tools/build_tsumego_bank.py`。

## 难度说明

| 档位 | 引擎 | 说明 |
|------|------|------|
| 入门 · 本地 | 启发式 | 随机性大，适合新手 |
| 进阶 · 本地 | 启发式 | 会打吃 / 逃吃，约业余级 |
| 高段 · KataGo | 神经网络 | 120 visits，强 |
| 职业 · KataGo | 神经网络 | 1200 visits，职业以上 |

KataGo 强度通过 `maxVisits`（搜索量）调节，数值越大越强、越慢。

## 接口（后端，均挂在 `/api/*` 下；兼容无前缀旧路径）

- `POST /api/genmove`  —— 返回 AI 落子 + 胜率（黑方视角）+ 目差
- `POST /api/analyze`  —— 返回候选着手与形势（用于智能提示）
- `POST /api/recognize` —— 识别截图棋盘，返回 `{size, board, confidence}`；请求体 `{ "image":"data:image/png;base64,...", "size":可选强制路数 }`
- `GET/POST /api/position` —— 跨设备共享布局：POST 存最新（`{size,board,turn,source}`），GET 取最新（带递增 `version`）
- `GET  /api/tsumego-search?q=关键词` —— 联网搜索公开死活题资源链接（需后端机器可访问外网）
- `GET  /api/health`   —— 健康检查（含 `katago` 是否就绪）

对弈请求体支持从任意布局继续：`{ "moves":[...], "initialStones":[["B","Q16"]], "initialPlayer":"W", "size":19, "komi":7.5, "rules":"chinese", "maxVisits":800 }`
另支持：`"avoidMoves":[{"player":"B","moves":[...],"untilDepth":64},...]` 限制搜索范围（死活训练用），`"includeOwnership":true` 让 `/genmove` 也返回归属图（死活判定用）。

## 后续规划

- [ ] 形势热力图（KataGo ownership 已返回，前端待渲染）
- [ ] 复盘 / SGF 记谱与导出
- [ ] 让子棋、计时
- [ ] 迁移到微信小程序（需企业主体确认游戏类目资质）
