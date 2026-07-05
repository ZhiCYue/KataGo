#!/usr/bin/env python3
"""生成前端死活题库 js/tsumego-bank.js（零第三方依赖，仅标准库）。

来源：tasuki 经典死活题合集（https://tsumego.tasuki.org/），
SGF 版由 Seon82/tasuki2sgf 整理（题面公版/公开整理，不含解答）。

用法：
  python3 tools/build_tsumego_bank.py            # 自动下载 SGF 到 /tmp 并生成
  python3 tools/build_tsumego_bank.py --sgf-dir 目录   # 使用已下载的 SGF

规范化规则：
  - 全部统一为「黑先」：原题 PL[W] 时黑白互换。
  - 坐标保留 SGF 两字母格式（'a'..'s'，列在前行在后，左上角为 aa），
    前端按每 2 字符切分解码。
  - 每题输出 [ab, aw, label]，label 为可选卷/类型标记（无则省略）。
"""
import argparse, json, os, re, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "js", "tsumego-bank.js")
RAW_BASE = "https://raw.githubusercontent.com/Seon82/tasuki2sgf/master/generated"

COLLECTIONS = [
    ("cho-1", "赵治勋《死活大百科》初级", "约 20k–8k · 入门基本形"),
    ("cho-2", "赵治勋《死活大百科》中级", "约 10k–4k · 常型强化"),
    ("cho-3", "赵治勋《死活大百科》高级", "约 3k–业余高段 · 高级常型"),
    ("lee-chang-ho", "李昌镐《精讲死活》", "共六卷，逐卷加深 · 业余中高段"),
    ("gokyoshumyo", "《棋经众妙》", "古典名著（1822）· 分七类"),
    ("xxqj", "《玄玄棋经》", "古典名著（1349）· 业余高段"),
    ("hatsuyoron", "《发阳论》", "古典最难题集（1713）· 极高难度"),
]

# 棋经众妙分类：题号 "1-1" 的首位是类别
GOKYO_SECTIONS = {"1": "做活", "2": "杀棋", "3": "打劫", "4": "对杀", "5": "倒扑", "6": "连接", "7": "手筋"}

# 题面节点：C[标题] PL[先手方] AB/AW 摆子，可能带 LB 等附加标记（忽略）
PROB_RE = re.compile(r"\(;C\[([^\]]*)\]PL\[([BW])\]([^()]*)\)")
STONES_RE = re.compile(r"A([BW])((?:\[[a-z]{2}\])+)")


def fetch_sgfs(dest):
    for cid, _, _ in COLLECTIONS:
        path = os.path.join(dest, f"{cid}.sgf")
        if os.path.exists(path):
            continue
        url = f"{RAW_BASE}/{cid}.sgf"
        print(f"下载 {url}")
        with urllib.request.urlopen(url, timeout=30) as resp, open(path, "wb") as f:
            f.write(resp.read())


def parse_collection(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    problems = []
    for m in PROB_RE.finditer(text):
        title, pl, stones_raw = m.group(1), m.group(2), m.group(3)
        ab, aw = [], []
        for sm in STONES_RE.finditer(stones_raw):
            pts = re.findall(r"\[([a-z]{2})\]", sm.group(2))
            (ab if sm.group(1) == "B" else aw).extend(pts)
        if pl == "W":  # 统一黑先：黑白互换
            ab, aw = aw, ab
        ab, aw = sorted(set(ab)), sorted(set(aw))
        assert not (set(ab) & set(aw)), f"黑白重叠: {title}"
        for p in ab + aw:
            assert "a" <= p[0] <= "s" and "a" <= p[1] <= "s", f"坐标越界: {title} {p}"
        problems.append((title, "".join(ab), "".join(aw)))
    return problems


def label_for(cid, title):
    if cid == "lee-chang-ho":
        m = re.match(r"volume (\d+)", title)
        return f"第{m.group(1)}卷" if m else ""
    if cid == "gokyoshumyo":
        m = re.search(r"problem (\d+)-", title)
        return GOKYO_SECTIONS.get(m.group(1), "") if m else ""
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sgf-dir", help="已下载 SGF 的目录（缺省自动下载到临时目录）")
    args = ap.parse_args()

    sgf_dir = args.sgf_dir or os.path.join(tempfile.gettempdir(), "tsumego-sgf")
    os.makedirs(sgf_dir, exist_ok=True)
    if not args.sgf_dir:
        fetch_sgfs(sgf_dir)

    bank = []
    total = 0
    for cid, name, level in COLLECTIONS:
        problems = parse_collection(os.path.join(sgf_dir, f"{cid}.sgf"))
        if not problems:
            sys.exit(f"{cid} 未解析出任何题目，SGF 可能损坏")
        entries = []
        for title, ab, aw in problems:
            label = label_for(cid, title)
            entries.append([ab, aw, label] if label else [ab, aw])
        bank.append({"id": cid, "name": name, "level": level, "problems": entries})
        total += len(entries)
        print(f"{cid}: {len(entries)} 题")

    payload = json.dumps(bank, ensure_ascii=False, separators=(",", ":"))
    js = (
        "/* 经典死活题库（自动生成，勿手改）。来源：tasuki tsumego collections（SGF 由 Seon82/tasuki2sgf 整理）。\n"
        " * 已统一规范为黑先（原白先题黑白互换）；坐标为 SGF 两字母格式，左上角为 aa。\n"
        " * 重新生成：python3 tools/build_tsumego_bank.py */\n"
        f"window.TSUMEGO_BANK = {payload};\n"
    )
    out = os.path.normpath(OUT)
    with open(out, "w", encoding="utf-8") as f:
        f.write(js)
    print(f"共 {total} 题 → {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
