#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 README 用的演示 GIF（终端风格，打字机效果）。

用法：python3 scripts/make-demo-gif.py
输出：assets/demo.gif
依赖：Pillow（python3 -m pip install Pillow）
"""
import os

from PIL import Image, ImageDraw, ImageFont

# ── 画布与配色（GitHub Dark 风格终端）──────────────────────────────────────
W, H = 880, 540
BG = (13, 17, 23)          # #0d1117
PANEL = (22, 27, 34)       # #161b22
TEXT = (230, 237, 243)     # #e6edf3
ACCENT = (88, 166, 255)    # #58a6ff
GREEN = (63, 185, 80)      # #3fb950
YELLOW = (210, 153, 34)    # #d29922
DIM = (139, 148, 158)      # #8b949e
RED = (248, 81, 73)        # #f85149
FPS = 10
CHARS_PER_FRAME = 7
HOLD_FRAMES = 12

FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 0),   # macOS 中文字体（覆盖 CJK+Latin）
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/STHeiti Light.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
]


def load_font(size):
    for path, index in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


FONT = load_font(20)
FONT_BOLD = load_font(24)
FONT_SMALL = load_font(16)

MARGIN = 28
LINE_H = 34
TOP = 46


# ── 场景：每行 (文本, 颜色) ────────────────────────────────────────────────
SCENES = [
    [  # 场景 1：启动
        ("$ dsh web", GREEN),
        ("[project-progress] 插件已加载", ACCENT),
        ("[project-progress] 启动补建完成：处理 2 个活跃会话", ACCENT),
        ("", TEXT),
        ("每个项目自动建记录 - 自动同步进展 - 新会话快速接手", DIM),
    ],
    [  # 场景 2：自动创建项目
        ("$ # 在项目目录开始对话……", GREEN),
        ("[project-progress] 已自动创建项目：", ACCENT),
        ("$DSH_HOME/projects/插件项目-3f9a2b/", YELLOW),
        ("|-- project.json   : 元数据（标题/路径/会话）", TEXT),
        ("|-- log.json       : 回合日志（请求->回复->工具）", TEXT),
        ("|-- digest.txt     : LLM 当前状态摘要", TEXT),
        ("`-- progress.md    : 人类可读进展文档", TEXT),
    ],
    [  # 场景 3：progress.md 内容
        ("$ cat progress.md", GREEN),
        ("# 项目进展：插件项目", YELLOW),
        ("- 会话 3 个 | 回合 12 个", DIM),
        ("", TEXT),
        ("## 当前状态", ACCENT),
        ("正在开发 dsh-project-progress，核心功能已完成，", TEXT),
        ("下一步：发布到 npm 并补 CI。", TEXT),
        ("## 交接笔记", ACCENT),
        ("- 已开源：github.com/zhangqijin890-bot/project-progress", TEXT),
    ],
    [  # 场景 4：/project 命令
        ("$ /project", GREEN),
        ("项目：插件项目", TEXT),
        ("进展文件：~/.dsh/projects/插件项目-3f9a2b/progress.md", TEXT),
        ("最近更新：2026-08-17 02:45", TEXT),
        ("用法：/project [sync|path|backfill]", DIM),
    ],
    [  # 场景 5：新会话自动注入
        ("$ # 上下文满了，开新会话……", GREEN),
        ("[project-progress] 已注入项目进展摘要:", ACCENT),
        ("> 项目「插件项目」进展摘要", TEXT),
        ("> 当前状态：正在开发 dsh-project-progress……", TEXT),
        ("> 直接说\"继续\"，即可无缝接手", TEXT),
    ],
    [  # 场景 6：安装与链接 + 收尾
        ("安装：dsh plugin add @zhangqijin890-bot/dsh-project-progress", GREEN),
        ("GitHub: github.com/zhangqijin890-bot/project-progress", ACCENT),
        ("npm:    npmjs.com/package/@zhangqijin890-bot/dsh-project-progress", ACCENT),
        ("", TEXT),
        ("新会话，快速接手！", YELLOW),
    ],
]


def draw_frame(lines_with_reveal, cursor=False):
    """绘制一帧。lines_with_reveal: [(text, color, reveal_count)]"""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # 标题栏
    d.rectangle([0, 0, W, 34], fill=PANEL)
    d.ellipse([14, 12, 22, 20], fill=RED)
    d.ellipse([28, 12, 36, 20], fill=YELLOW)
    d.ellipse([42, 12, 50, 20], fill=GREEN)
    d.text((66, 7), "dsh-project-progress — 终端演示", font=FONT_SMALL, fill=DIM)
    y = TOP
    for text, color, reveal in lines_with_reveal:
        shown = text[:reveal]
        if shown:
            d.text((MARGIN, y), shown, font=FONT, fill=color)
        if cursor and reveal < len(text):
            x = MARGIN + d.textlength(shown, font=FONT)
            d.text((x, y), "▌", font=FONT, fill=TEXT)
        y += LINE_H
    return img


def build_frames():
    frames = []
    for scene in SCENES:
        total = sum(len(t) for t, _ in scene)
        revealed = [0] * len(scene)
        remaining = total
        # 打字机推进
        while remaining > 0:
            budget = CHARS_PER_FRAME
            for i, (text, _) in enumerate(scene):
                if budget <= 0:
                    break
                need = len(text) - revealed[i]
                take = min(need, budget)
                revealed[i] += take
                budget -= take
            remaining = max(0, remaining - CHARS_PER_FRAME)
            frames.append(draw_frame(
                [(t, c, revealed[i]) for i, (t, c) in enumerate(scene)],
                cursor=True,
            ))
        # 整场景停留
        for _ in range(HOLD_FRAMES):
            frames.append(draw_frame([(t, c, len(t)) for t, c in scene]))
    # 结尾光标闪烁
    last_scene = SCENES[-1]
    for i in range(6):
        frames.append(draw_frame(
            [(t, c, len(t)) for t, c in last_scene],
            cursor=(i % 2 == 0),
        ))
    return frames


def main():
    out_dir = os.path.join(os.path.dirname(__file__), "..", "assets")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "demo.gif")
    frames = build_frames()
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=1000 // FPS,
        loop=0,
        optimize=True,
    )
    print(f"OK: {out}（{len(frames)} 帧，{os.path.getsize(out) / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
