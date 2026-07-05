#!/usr/bin/env python3
"""
KataGo 后端服务（零第三方依赖，仅用标准库）

包住 KataGo 的「分析引擎」(katago analysis)，通过 JSON 行协议通信，
对前端暴露两个 HTTP 接口：
  POST /genmove  —— 返回 AI 该下的一手 + 胜率 + 目差
  POST /analyze  —— 返回当前局面的候选手与胜率（用于「智能提示/形势分析」）

请求体示例：
  { "moves": [["B","Q16"],["W","D4"]], "size":19, "komi":7.5,
    "rules":"chinese", "maxVisits":800 }

启动：
  python3 backend/server.py --katago $(which katago) \
      --model models/kata-network.bin.gz --config backend/analysis.cfg --port 8001
"""
import argparse, json, subprocess, threading, sys, queue, time, os, re, html
import mimetypes, posixpath, urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
POSITION_FILE = os.path.join(HERE, "shared_position.json")
WEBROOT = os.path.dirname(HERE)  # 项目根目录（index.html / css / js 所在），用于伺服静态页


class KataGo:
    """封装一个常驻的 katago analysis 子进程，按 query id 收发。"""

    def __init__(self, katago_path, config_path, model_path):
        self.proc = subprocess.Popen(
            [katago_path, "analysis", "-config", config_path, "-model", model_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self._counter = 0
        self._lock = threading.Lock()
        self._pending = {}  # id -> queue
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                resp = json.loads(line)
            except json.JSONDecodeError:
                continue
            q = self._pending.get(resp.get("id"))
            if q:
                q.put(resp)

    def _read_stderr(self):
        # KataGo 把加载/日志信息写到 stderr，转发到本进程 stderr 便于排错
        for line in self.proc.stderr:
            sys.stderr.write("[katago] " + line)

    def query(self, moves, size, komi, rules, max_visits, want_ownership=False,
              initial_stones=None, initial_player=None, allow_moves=None, avoid_moves=None):
        with self._lock:
            self._counter += 1
            qid = "q%d" % self._counter
        q = queue.Queue()
        self._pending[qid] = q
        req = {
            "id": qid,
            "moves": moves,
            "rules": rules,
            "komi": komi,
            "boardXSize": size,
            "boardYSize": size,
            "maxVisits": max_visits,
            "analyzeTurns": [len(moves)],
            "includeOwnership": want_ownership,
            "includePolicy": False,
        }
        # 从任意布局（上传识别的局面）继续分析时，用 initialStones 摆子
        if initial_stones:
            req["initialStones"] = initial_stones
        if initial_player:
            req["initialPlayer"] = initial_player
        if allow_moves:
            req["allowMoves"] = allow_moves
        # 死活训练：把题目区域外设为双方禁着点，让搜索聚焦局部
        if avoid_moves:
            req["avoidMoves"] = avoid_moves
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        try:
            resp = q.get(timeout=120)
        finally:
            self._pending.pop(qid, None)
        return resp


def format_result(resp, to_move):
    """整理 KataGo 结果。配置 reportAnalysisWinratesAs=BLACK，故 winrate/scoreLead 已是黑方视角。"""
    moveinfos = sorted(resp.get("moveInfos", []), key=lambda m: -m["visits"])
    root = resp.get("rootInfo", {})
    best = moveinfos[0] if moveinfos else None
    candidates = [{
        "move": m["move"],
        "winrate": round(m["winrate"], 4),
        "scoreLead": round(m["scoreLead"], 1),
        "visits": m["visits"],
    } for m in moveinfos[:6]]
    return {
        "bestMove": best["move"] if best else "pass",
        "winrate": round(root.get("winrate", 0.5), 4),
        "scoreLead": round(root.get("scoreLead", 0.0), 1),
        "candidates": candidates,
        "ownership": resp.get("ownership"),
    }


class PositionStore:
    """跨设备共享的「当前布局」：手机上传后存这里，PC 端轮询/刷新取最新。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._data = {"version": 0}
        if os.path.exists(POSITION_FILE):
            try:
                with open(POSITION_FILE, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
            except Exception:
                pass

    def get(self):
        with self._lock:
            return dict(self._data)

    def set(self, size, board, turn, source=""):
        with self._lock:
            self._data = {
                "version": self._data.get("version", 0) + 1,
                "size": int(size),
                "board": board,
                "turn": int(turn),
                "source": source,
                "ts": time.time(),
            }
            try:
                with open(POSITION_FILE, "w", encoding="utf-8") as f:
                    json.dump(self._data, f)
            except Exception as e:
                sys.stderr.write("保存布局失败: %s\n" % e)
            return self._data["version"]


def board_to_stones(board, size):
    """board[y][x] -> KataGo initialStones [["B","Q16"],...]；坐标与前端 vertex() 一致。"""
    letters = "ABCDEFGHJKLMNOPQRST"
    stones = []
    for y in range(size):
        for x in range(size):
            v = board[y][x]
            if v:
                stones.append(["B" if v == 1 else "W", letters[x] + str(size - y)])
    return stones


class Handler(BaseHTTPRequestHandler):
    katago = None    # 由 main 注入（可能为 None：未装 KataGo 时降级）
    positions = None  # PositionStore 实例

    def log_message(self, *a):
        pass  # 静默默认日志

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _api_path(self):
        """取去掉查询串、并剥离可选 /api 前缀后的接口路径。返回 None 表示非 API 请求。"""
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            return path[4:]                       # /api/recognize -> /recognize
        if path in ("/health", "/position", "/recognize", "/genmove", "/analyze", "/tsumego-search"):
            return path                           # 兼容旧的无前缀路径
        return None

    def do_GET(self):
        r = self._api_path()
        if r is None:
            return self._serve_static()           # 非 API 一律按静态文件伺服
        if r == "/health":
            self._send(200, {"ok": True, "katago": self.katago is not None})
        elif r == "/position":
            self._send(200, self.positions.get()) # PC 端轮询 / 刷新：取最新共享布局
        elif r == "/tsumego-search":
            self._handle_tsumego_search()
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or "{}")
        except Exception as e:
            return self._send(400, {"error": "bad json: %s" % e})

        r = self._api_path()
        if r == "/recognize":
            return self._handle_recognize(data)
        if r == "/position":
            return self._handle_set_position(data)
        return self._handle_katago(data, want_ownership=(r == "/analyze"))

    def _serve_static(self):
        """伺服前端静态资源。仅放行 index.html 与 css/ js/ 目录，
        避免把后端源码、models 大文件、日志等通过公网隧道暴露出去。"""
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path in ("/", ""):
            path = "/index.html"
        rel = posixpath.normpath(path).lstrip("/")
        allowed = rel == "index.html" or rel.startswith("css/") or rel.startswith("js/")
        fpath = os.path.join(WEBROOT, rel)
        if not allowed or not os.path.abspath(fpath).startswith(WEBROOT) or not os.path.isfile(fpath):
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(fpath)[0] or "application/octet-stream"
        try:
            with open(fpath, "rb") as f:
                body = f.read()
        except OSError:
            return self._send(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")  # 改了代码即时生效，避免缓存困扰
        self.end_headers()
        self.wfile.write(body)

    def _handle_recognize(self, data):
        if "image" not in data:
            return self._send(400, {"error": "缺少 image 字段"})
        try:
            import recognize  # 延迟导入：未装 opencv 时不影响其它接口
            force = data.get("size")
            result = recognize.recognize(data["image"], force_size=force)
            return self._send(200, {"ok": True, **result})
        except Exception as e:
            import traceback
            traceback.print_exc()  # 完整栈打到后端终端，便于定位
            return self._send(422, {"error": str(e)})

    def _handle_set_position(self, data):
        try:
            size = int(data["size"])
            board = data["board"]
            turn = int(data.get("turn", 1))
        except (KeyError, ValueError, TypeError):
            return self._send(400, {"error": "需要 size / board / turn"})
        version = self.positions.set(size, board, turn, data.get("source", ""))
        return self._send(200, {"ok": True, "version": version})

    def _handle_tsumego_search(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        query = (params.get("q") or [""])[0].strip()
        if not query:
            query = "围棋 死活题 高级"
        if len(query) > 80:
            query = query[:80]
        try:
            results = search_tsumego_web(query)
            return self._send(200, {"ok": True, "query": query, "results": results})
        except Exception as e:
            return self._send(502, {"error": "联网搜索失败：%s" % e})

    def _handle_katago(self, data, want_ownership=False):
        if self.katago is None:
            return self._send(503, {"error": "KataGo 未启用（后端以仅识别/同步模式运行）"})
        moves = data.get("moves", [])
        size = int(data.get("size", 19))
        komi = float(data.get("komi", 7.5))
        rules = data.get("rules", "chinese")
        max_visits = int(data.get("maxVisits", 800))
        # 支持从上传布局继续：initialStones + initialPlayer（落子序列从该局面起算）
        initial_stones = data.get("initialStones")
        initial_player = data.get("initialPlayer")
        allow_moves = data.get("allowMoves")
        avoid_moves = data.get("avoidMoves")
        # 前端可显式要求返回 ownership（如死活训练用它判定局部死活）
        want_ownership = want_ownership or bool(data.get("includeOwnership"))
        base = initial_player if initial_player in ("B", "W") else "B"
        to_move = base if len(moves) % 2 == 0 else ("W" if base == "B" else "B")

        try:
            resp = self.katago.query(moves, size, komi, rules, max_visits, want_ownership,
                                     initial_stones=initial_stones, initial_player=initial_player,
                                     allow_moves=allow_moves, avoid_moves=avoid_moves)
        except queue.Empty:
            return self._send(504, {"error": "katago timeout"})
        if "error" in resp:
            return self._send(500, {"error": resp["error"]})
        self._send(200, format_result(resp, to_move))


def search_tsumego_web(query, limit=8):
    """轻量联网搜索：用 Bing RSS 返回公开网页链接，不抓取或复制题面内容。"""
    terms = query
    if not re.search(r"tsumego", terms, re.I):
        terms = "tsumego problems online " + terms
    url = "https://www.bing.com/search?" + urllib.parse.urlencode({"q": terms, "format": "rss"})
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; KataGoPractice/1.0)",
    })
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read(512 * 1024).decode("utf-8", "replace")

    results = []
    seen = set()
    pattern = re.compile(r"<item>\s*<title>(.*?)</title>\s*<link>(.*?)</link>", re.S)
    for title_xml, href_xml in pattern.findall(raw):
        title = html.unescape(re.sub(r"<.*?>", "", title_xml)).strip()
        href = html.unescape(href_xml).strip()
        if not title or not href.startswith(("http://", "https://")) or href in seen:
            continue
        seen.add(href)
        results.append({"title": title[:120], "url": href})
        if len(results) >= limit:
            break
    if not results:
        encoded = urllib.parse.quote_plus(terms)
        results = [
            {"title": "Tsumego Hero", "url": "https://tsumego.com/"},
            {"title": "goproblems.com", "url": "https://www.goproblems.com/"},
            {"title": "Sensei's Library: Tsumego", "url": "https://senseis.xmp.net/?Tsumego"},
            {"title": "Bing 搜索结果", "url": "https://www.bing.com/search?q=" + encoded},
        ][:limit]
    return results


def main():
    ap = argparse.ArgumentParser()
    # KataGo 相关参数改为可选：缺省时以「仅识别 / 同步」模式运行（/genmove /analyze 返回 503）
    ap.add_argument("--katago")
    ap.add_argument("--model")
    ap.add_argument("--config")
    # 单端口同时伺服静态页 + API，默认 8000；一条 Cloudflare Tunnel 即可全覆盖
    ap.add_argument("--port", type=int, default=8000)
    # 默认绑定所有网卡，使同一局域网内的手机也能访问；如需仅本机可传 --host 127.0.0.1
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    Handler.positions = PositionStore()

    if args.katago and args.model and args.config:
        try:
            sys.stderr.write("启动 KataGo 引擎中（首次加载网络需要数秒）...\n")
            Handler.katago = KataGo(args.katago, args.config, args.model)
            warm = Handler.katago.query([], 19, 7.5, "chinese", 10)  # 预热一手确认可用
            sys.stderr.write("KataGo 就绪 ✅  预热胜率=%.3f\n" % warm.get("rootInfo", {}).get("winrate", 0.5))
        except Exception as e:
            Handler.katago = None
            sys.stderr.write("⚠ KataGo 启动失败（%s），转为仅识别/同步模式\n" % e)
    else:
        sys.stderr.write("ℹ 未提供 KataGo 参数，以仅识别/同步模式运行\n")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write("服务已启动 http://%s:%d  （网页 + API 同端口；接口在 /api/* 下）\n"
                     % (args.host, args.port))
    sys.stderr.write("  本机：http://127.0.0.1:%d/    公网：cloudflared tunnel --url http://localhost:%d\n"
                     % (args.port, args.port))
    srv.serve_forever()


if __name__ == "__main__":
    main()
