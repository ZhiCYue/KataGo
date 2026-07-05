#!/usr/bin/env bash
# 启动后端服务。会自动定位 python（需带 numpy/cv2）、katago、网络权重与分析配置。
set -e
cd "$(dirname "$0")/.."

# 截图识别依赖 numpy/cv2，须挑一个装了它们的 python 解释器
# （脚本里别名不生效，/usr/bin/python3 往往没有这些包）
PY=""
for cand in python3.11 python3.12 python3.13 python3.10 /opt/homebrew/bin/python3 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import numpy, cv2' >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [ -z "$PY" ]; then
  echo "未找到带 numpy/cv2 的 python，请先：pip install opencv-python numpy"
  echo "（注意要装到你启动用的那个 python 里，可用 'python3.11 -m pip install opencv-python numpy'）"
  exit 1
fi
echo "Python : $("$PY" -c 'import sys;print(sys.executable)')"

KATAGO="$(command -v katago || true)"
[ -z "$KATAGO" ] && { echo "未找到 katago，请先 brew install katago"; exit 1; }

MODEL="models/kata-network.bin.gz"
[ -f "$MODEL" ] || { echo "未找到网络权重 $MODEL"; exit 1; }

CONFIG="backend/analysis.cfg"
if [ ! -f "$CONFIG" ]; then
  # 从 KataGo 自带示例复制一份分析配置，避免手写出错
  EXAMPLE="$(find "$(brew --prefix katago 2>/dev/null)" -name 'analysis_example.cfg' 2>/dev/null | head -1)"
  [ -z "$EXAMPLE" ] && EXAMPLE="$(find /opt/homebrew -name 'analysis_example.cfg' 2>/dev/null | head -1)"
  [ -z "$EXAMPLE" ] && { echo "未找到 analysis_example.cfg，请手动提供 $CONFIG"; exit 1; }
  cp "$EXAMPLE" "$CONFIG"
  echo "已复制分析配置：$EXAMPLE -> $CONFIG"
fi

PORT="${1:-8000}"   # 单端口同时伺服网页 + API（接口在 /api/* 下）

# 访问令牌：首次生成后存 backend/.token（已 gitignore），之后复用。
# 挂公网隧道必须带令牌访问；设 NO_TOKEN=1 可关闭校验（仅限本机/局域网调试）。
TOKEN=""
if [ "${NO_TOKEN:-0}" != "1" ]; then
  TOKEN_FILE="backend/.token"
  if [ ! -s "$TOKEN_FILE" ]; then
    (openssl rand -hex 8 2>/dev/null || date +%s | shasum | head -c 16) > "$TOKEN_FILE"
  fi
  TOKEN="$(cat "$TOKEN_FILE")"
fi

echo "KataGo : $KATAGO"
echo "网络   : $MODEL"
echo "配置   : $CONFIG"
echo "端口   : $PORT"
if [ -n "$TOKEN" ]; then
  echo "令牌   : $TOKEN"
  echo "打开   : http://127.0.0.1:$PORT/?key=$TOKEN"
else
  echo "打开   : http://127.0.0.1:$PORT/  （未启用令牌）"
fi
exec "$PY" backend/server.py --katago "$KATAGO" --model "$MODEL" --config "$CONFIG" --port "$PORT" ${TOKEN:+--token "$TOKEN"}
