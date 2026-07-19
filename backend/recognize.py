#!/usr/bin/env python3
"""
从围棋软件截图中识别盘面布局。

专为「数字棋盘」设计（围棋 App / 对弈网站 / SGF 编辑器的正视截图，线条清晰、无透视）。
流程：解码图片 → Hough 检测横竖网格线 → 推断棋盘路数与各交叉点坐标 →
逐交叉点采样中心亮度，按相对阈值判黑 / 白 / 空。

返回 board[y][x]：0 空 / 1 黑 / 2 白（y=0 为图片上方，与前端引擎一致）。
识别难免有误，前端会提供人工校正环节兜底。
"""
import base64
import numpy as np
import cv2

ALLOWED_SIZES = (9, 13, 19)


def _decode(image_b64):
    """把 dataURL 或纯 base64 解成 BGR 图。"""
    if not image_b64 or not isinstance(image_b64, str):
        raise ValueError("未收到图片数据，请重新选择截图")
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    raw = base64.b64decode(image_b64)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片，请确认是 PNG/JPG 截图")
    # 过大的图缩到合理尺寸，加速且不影响网格检测
    h, w = img.shape[:2]
    scale = 1400.0 / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _cluster(coords, tol):
    """把相近坐标聚成一类，返回每类均值（升序）。"""
    if not coords:
        return []
    coords = sorted(coords)
    groups, cur = [], [coords[0]]
    for c in coords[1:]:
        if c - cur[-1] <= tol:
            cur.append(c)
        else:
            groups.append(sum(cur) / len(cur))
            cur = [c]
    groups.append(sum(cur) / len(cur))
    return groups


def _detect_line_coords(gray):
    """用 Hough 检测足够长的横线、竖线，返回其位置（竖线的 x、横线的 y）。"""
    h, w = gray.shape
    edges = cv2.Canny(gray, 40, 120)
    # 阈值取较小边的 0.3 倍，兼顾竖屏截图里偏小的棋盘（线更短）
    min_len = int(min(h, w) * 0.3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=min_len,
                            minLineLength=min_len, maxLineGap=int(min_len * 0.6))
    xs, ys = [], []
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0]:
            if abs(x1 - x2) <= 3:        # 竖线
                xs.append((x1 + x2) / 2.0)
            elif abs(y1 - y2) <= 3:      # 横线
                ys.append((y1 + y2) / 2.0)
    return xs, ys


def _mode_spacing(diffs):
    """网格间距 = 出现最多的相邻间距（等距网格线贡献绝大多数，可滤掉 UI 栏/边框）。"""
    r = np.round(diffs).astype(int)
    vals = np.unique(r)
    best_g, best_c = None, 0
    for v in vals:                       # ±2px 容忍，合并相近间距计数
        c = int(((r >= v - 2) & (r <= v + 2)).sum())
        if c > best_c:
            best_c, best_g = c, v
    return float(best_g) if best_g else None


# 连续板块允许的最大内部空缺（格位数）：满盘棋时最外几路可能连片被遮挡、检不出，
# 需容忍一定空缺；但棋盘与盘外 UI（顶部信息栏、底部聊天区）之间隔得很远，
# 超过此值即视为跨到 UI 区、断开，从而把棋盘从整张截图里切出来。
_MAX_GAP = 5


def _fit_axis(clusters, g):
    """给定间距 g，在一组线位置里拟合等距格，返回 (lo, hi, n, count)。

    1) 相位对齐：找一条让最多检出线落在其上的等距格（anchor+i·g），抗遮挡。
    2) 最大连续板块：把命中的线按格位排序，相邻格位空缺 >_MAX_GAP 即断开，
       取线最多的一段作为棋盘——聊天栏/头像/外框等远离主体的杂线被自动切除。
    count 为板块内命中线数，供在多个候选 g 间打分选优。
    """
    if not clusters or not g:
        return None
    c = np.array(sorted(clusters), dtype=float)
    tol = 0.18 * g
    best, best_c = None, 0
    for anchor in c:
        k = np.round((c - anchor) / g)
        inliers = c[np.abs(c - (anchor + k * g)) <= tol]
        if len(inliers) > best_c:
            best_c, best = len(inliers), inliers
    if best is None or best_c < 5:
        return None
    pos = np.sort(best)
    ks = np.round((pos - pos[0]) / g).astype(int)
    segs, start = [], 0
    for i in range(1, len(ks)):
        if ks[i] - ks[i - 1] > _MAX_GAP:
            segs.append((start, i))
            start = i
    segs.append((start, len(ks)))
    a, b = max(segs, key=lambda s: (s[1] - s[0], ks[s[1] - 1] - ks[s[0]]))
    pos = pos[a:b]
    lo, hi = float(pos[0]), float(pos[-1])
    n = int(round((hi - lo) / g)) + 1
    return lo, hi, n, (b - a)


def _choose_grid(xs_raw, ys_raw, W, H, force_size):
    """选定路数 N 与横竖网格坐标。

    棋盘格子是正方形，横竖两轴的真实间距相同。用相邻间距众数作初值、在 ±15% 内细搜
    公共间距 g，取「两轴最大连续板块命中线最多、且两轴路数最接近」的 g。这样某一轴被
    外框/UI 杂线带偏（间距算小、多算一路、采样点整盘漂移）时，会被另一轴的一致性纠正。
    """
    cx = _cluster(xs_raw, max(3, W * 0.006)) if len(xs_raw) >= 5 else []
    cy = _cluster(ys_raw, max(3, H * 0.006)) if len(ys_raw) >= 5 else []
    if len(cx) < 5 or len(cy) < 5:
        return None
    diffs = np.concatenate([np.diff(np.array(sorted(cx))), np.diff(np.array(sorted(cy)))])
    diffs = diffs[diffs > 2]
    if len(diffs) < 4:
        return None
    g0 = _mode_spacing(diffs)
    if not g0 or g0 < 4:
        return None

    best = None                             # (score, ax, ay)
    for g in np.linspace(g0 * 0.85, g0 * 1.15, 61):
        ax = _fit_axis(cx, g)
        ay = _fit_axis(cy, g)
        if ax is None or ay is None:
            continue
        score = ax[3] + ay[3] - 2 * abs(ax[2] - ay[2])   # 命中线多、两轴路数接近
        if best is None or score > best[0]:
            best = (score, ax, ay)
    if best is None:
        return None
    _, ax, ay = best

    if force_size in ALLOWED_SIZES:
        N = int(force_size)
    else:
        avg = (ax[2] + ay[2]) / 2.0
        N = min(ALLOWED_SIZES, key=lambda s: abs(s - avg))

    # 铺 N 条线：n 与 N 一致时用两端 linspace（无漂移），否则按精确间距外推
    def _lay(axis):
        lo, hi, n, _ = axis
        if N > 1 and n == N:
            return np.linspace(lo, hi, N)
        gp = (hi - lo) / (n - 1) if n > 1 else g0
        return lo + np.arange(N) * gp

    return None, None, N, _lay(ax), _lay(ay)


def _classify(gray, xs, ys):
    """逐交叉点采样，按「子色像素覆盖率」判黑 / 白 / 空。

    用覆盖率而非单纯均值，可避免边线交叉（暗十字仅占小面积）被误判成棋子。
    """
    n = len(xs)
    cell = (xs[-1] - xs[0]) / (n - 1)
    r = max(3, int(cell * 0.33))
    H, W = gray.shape

    patches = [[None] * n for _ in range(n)]
    means = np.full((n, n), 128.0)
    for j, cy in enumerate(ys):
        for i, cx in enumerate(xs):
            y0, y1 = max(0, int(cy - r)), min(H, int(cy + r + 1))
            x0, x1 = max(0, int(cx - r)), min(W, int(cx + r + 1))
            p = gray[y0:y1, x0:x1]
            patches[j][i] = p
            if p.size:
                means[j, i] = float(p.mean())

    med = float(np.median(means))        # 多数交叉点为空，中位数≈棋盘底色亮度
    dmin = float(means.min())             # 最暗交叉点≈黑子亮度（无黑子时≈底色）
    dmax = float(means.max())             # 最亮交叉点≈白子亮度（无白子时≈底色）
    # 阈值取底色与子色的中点，自适应对比度（深/浅棋盘、低对比白子都能分）；
    # 与底色差距过小则判定该色不存在。误判由「覆盖率>0.55」进一步把关。
    dark_thr = (med + dmin) / 2 if (med - dmin) > 20 else -1
    light_thr = (med + dmax) / 2 if (dmax - med) > 20 else 256

    board = [[0] * n for _ in range(n)]
    clear = 0
    for j in range(n):
        for i in range(n):
            p = patches[j][i]
            if p is None or p.size == 0:
                continue
            dark_frac = float((p < dark_thr).mean())
            light_frac = float((p > light_thr).mean())
            if dark_frac > 0.55:
                board[j][i] = 1
            elif light_frac > 0.55:
                board[j][i] = 2
            # 覆盖率明确（接近全是子 或 接近全空）则计为高置信
            if max(dark_frac, light_frac) > 0.7 or (dark_frac < 0.15 and light_frac < 0.15):
                clear += 1
    confidence = round(clear / (n * n), 3)
    return board, confidence


def recognize(image_b64, force_size=None):
    """主入口。force_size 给定则跳过路数检测。返回 dict。"""
    img = _decode(image_b64)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape
    xs_raw, ys_raw = _detect_line_coords(gray)

    grid = _choose_grid(xs_raw, ys_raw, W, H, force_size)
    if grid is None:
        raise ValueError("未能识别出棋盘网格，请上传更清晰、裁切到棋盘的截图")
    _, _, n, xs, ys = grid

    board, confidence = _classify(gray, xs, ys)
    return {"size": n, "board": board, "confidence": confidence}
