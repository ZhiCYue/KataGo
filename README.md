# 弈枰 · 围棋人机对弈

浏览器版围棋，支持本地启发式 AI 与 **KataGo 神经网络**（职业级）对弈，含实时胜率 / 形势分析。
本项目为后续微信小程序的规则与 AI 逻辑原型（个人主体先做网页版，规避小程序游戏类目资质问题）。

## 目录结构

```
index.html            入口页面
css/style.css         界面样式（水墨与木风格）
js/engine.js          围棋规则引擎（气 / 提子 / 禁着点 / 打劫）
js/ai.js              本地启发式 AI（弱，约业余级，无需后端）
js/board.js           Canvas 棋盘渲染与交互（含上传布局的「校正模式」）
js/main.js            主控：引擎 / AI / KataGo 后端 / 上传同步 / 界面
backend/server.py     后端（KataGo + 截图识别 + 跨设备布局同步）
backend/recognize.py  截图棋盘识别（OpenCV：Hough 找网格 + 覆盖率判子）
backend/start.sh      后端一键启动脚本
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
- `GET  /api/health`   —— 健康检查（含 `katago` 是否就绪）

对弈请求体支持从任意布局继续：`{ "moves":[...], "initialStones":[["B","Q16"]], "initialPlayer":"W", "size":19, "komi":7.5, "rules":"chinese", "maxVisits":800 }`

## 后续规划

- [ ] 形势热力图（KataGo ownership 已返回，前端待渲染）
- [ ] 复盘 / SGF 记谱与导出
- [ ] 让子棋、计时
- [ ] 迁移到微信小程序（需企业主体确认游戏类目资质）
