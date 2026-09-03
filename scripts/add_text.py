#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把文案文字叠加到图片上：位置随机（6个方位）+ 字体颜色随机
用法: python add_text.py <图片> <文案或@文件> <输出图> [mode]
mode: full=完整文案(默认) | title=一句话标题 | none=无文字
"""
import sys
import os
import json
import random
import re
from PIL import Image, ImageDraw, ImageFont

POSITIONS = [
    'top-left',   # 左上
    'top-right',  # 右上
    'bottom-left',  # 左下
    'bottom-right',  # 右下
    'top-center',  # 中上
    'bottom-center',  # 中下
]

FONT_PATH = r'C:\Windows\Fonts\msyh.ttc'

# 字体池：随机选用（常规, 粗体）——风格差异明显
FONT_POOL = [
    (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc'),        # 微软雅黑
    (r'C:\Windows\Fonts\Deng.ttf', r'C:\Windows\Fonts\Dengb.ttf'),          # 等线
    (r'C:\Windows\Fonts\simhei.ttf', None),                                  # 黑体
    (r'C:\Windows\Fonts\simsun.ttc', None),                                  # 宋体
    (r'C:\Windows\Fonts\simkai.ttf', None),                                  # 楷体
    (r'C:\Windows\Fonts\simfang.ttf', None),                                 # 仿宋
    (r'C:\Windows\Fonts\NotoSansSC-VF.ttf', None),                           # 思源黑体
    (r'C:\Windows\Fonts\NotoSerifSC-VF.ttf', None),                          # 思源宋体
]

def load_text(arg):
    if arg.startswith('@'):
        with open(arg[1:], 'r', encoding='utf-8') as f:
            return f.read()
    return arg

# 一句话标题规则：命中关键词返回工程类标题（均不涉及招聘/引流）
TITLE_RULES = [
    ('固化地坪', '车间固化地坪工程'),
    ('地坪', '地面固化工程'),
    ('冷库', '冷库建设工程'),
    ('推拉棚', '仓库推拉棚工程'),
    ('遮阳棚', '膜结构遮阳棚工程'),
    ('膜结构', '膜结构工程'),
    ('聚氨酯', '冷库保温工程'),
    ('废气', '车间废气处理工程'),
    ('vocs', '车间废气处理工程'),
    ('无尘车间', '无尘车间工程'),
    ('污水', '污水处理工程'),
    ('印刷', '印刷车间环保工程'),
    ('保鲜', '农产品保鲜冷库工程'),
]

# 合规黑名单：标题中不允许出现的词（疑似招聘/引流）
BANNED = ['招', '聘', '微信', '加我', '联系', '免费', '赚钱', '兼职', '咨询', '报价', '来电', '电话']

def make_title(text):
    low = text.lower()
    for kw, title in TITLE_RULES:
        if kw in low:
            return title
    # 兜底：取第一句前 12 字
    first = re.split(r'[。！？!?]', text)[0].strip()
    if len(first) > 12:
        first = first[:12]
    if any(b in first for b in BANNED):
        return '工程改造需求'
    return first if first else '工程改造需求'

def wrap_text(draw, text, font, max_width):
    lines = []
    for para in text.split('\n'):
        if not para:
            lines.append('')
            continue
        cur = ''
        for ch in para:
            if draw.textlength(cur + ch, font=font) > max_width:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        if cur:
            lines.append(cur)
    return lines

def main():
    if len(sys.argv) < 4:
        print('usage: python add_text.py <image> <text|@file> <output> [full|title|none]')
        sys.exit(1)
    img_path = sys.argv[1]
    text = load_text(sys.argv[2])
    out_path = sys.argv[3]
    mode = sys.argv[4] if len(sys.argv) > 4 else 'full'

    img = Image.open(img_path).convert('RGBA')
    W, H = img.size

    if mode == 'none':
        img.convert('RGB').save(out_path, quality=95)
        print(json.dumps({'mode': 'none', 'out': out_path}, ensure_ascii=False))
        return

    if mode == 'title':
        text = make_title(text)

    if mode == 'title':
        font_size = max(48, int(W * 0.1))
    else:
        font_size = max(32, int(W * 0.07))
    font_regular, font_bold_path = random.choice(FONT_POOL)
    try:
        font_bold = ImageFont.truetype(font_bold_path or font_regular, font_size)
    except Exception:
        font_bold = ImageFont.truetype(font_regular, font_size)
    font = font_bold

    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    max_text_w = int(W * 0.6)
    margin_x = int(W / 5)      # 左右距边至少 1/5 宽
    margin_y = int(H / 5)      # 上下距边至少 1/5 高
    line_gap = int(font_size * 0.28)

    lines = wrap_text(draw, text, font_bold, max_text_w)
    line_h = font_size + line_gap
    text_h = line_h * len(lines) - line_gap
    text_w = max(draw.textlength(l, font=font_bold) for l in lines)

    pos = random.choice(POSITIONS)
    if pos == 'top-left':
        x, y = margin_x, margin_y
    elif pos == 'top-right':
        x, y = W - margin_x - text_w, margin_y
    elif pos == 'bottom-left':
        x, y = margin_x, H - margin_y - text_h
    elif pos == 'bottom-right':
        x, y = W - margin_x - text_w, H - margin_y - text_h
    elif pos == 'top-center':
        x, y = (W - text_w) / 2, margin_y
    else:  # bottom-center
        x, y = (W - text_w) / 2, H - margin_y - text_h
    x = max(margin_x, min(x, W - margin_x - text_w))
    y = max(margin_y, min(y, H - margin_y - text_h))

    # 高可见度颜色池（亮色，避免深紫/深棕等暗色看不清）
    COLOR_POOL = [
        (255, 255, 255),   # 白
        (255, 235, 0),     # 亮黄
        (0, 230, 230),     # 亮青
        (0, 235, 120),     # 亮绿
        (255, 160, 0),     # 亮橙
        (255, 90, 90),     # 亮红
        (255, 110, 210),   # 亮粉
        (90, 180, 255),    # 亮蓝
        (255, 255, 150),   # 淡黄
        (150, 255, 200),   # 淡绿
    ]
    color = random.choice(COLOR_POOL)
    # 轻微抖动避免纯色过于生硬
    color = tuple(max(0, min(255, c + random.randint(-18, 18))) for c in color)

    # 黑色描边 + 纯文字（无背景条）
    for i, line in enumerate(lines):
        ly = y + i * line_h
        stroke_w = max(1, font_size // 16)
        draw.text((x, ly), line, font=font_bold, fill=color,
                  stroke_width=stroke_w, stroke_fill=(0, 0, 0, 220))

    img = Image.alpha_composite(img, overlay)
    img.convert('RGB').save(out_path, quality=92)
    font_name = os.path.splitext(os.path.basename(font_regular))[0]
    print(json.dumps({'mode': mode, 'position': pos, 'color': color, 'font': font_name, 'lines': len(lines), 'title': text if mode == 'title' else None, 'out': out_path}, ensure_ascii=False))

if __name__ == '__main__':
    main()
