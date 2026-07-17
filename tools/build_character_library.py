"""build_character_library.py — 从 LoRA 元数据构建角色库 + 画风库"""
import json, os, struct, re

LORA_DIR = r"E:\AI\sd-webui-aki\sd-webui-aki-v4.11.1-cu128\models\Lora"
OUT_CHARS = r"E:\AI\natureDrawImage\web\characters.json"
OUT_STYLES = r"E:\AI\natureDrawImage\web\styles"
TAGS_DIR = r"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\user\default\workflows\tags"
os.makedirs(OUT_STYLES, exist_ok=True)
os.makedirs(TAGS_DIR, exist_ok=True)


def read_safetensors_meta(path):
    """读取 safetensors 头部元数据"""
    try:
        with open(path, 'rb') as f:
            n = struct.unpack('<Q', f.read(8))[0]
            if n > 2_000_000:
                return {}  # too big, skip metadata only reads
            header = json.loads(f.read(n))
            return header.get('__metadata__', {})
    except:
        return {}


def extract_tags_from_metadata(meta):
    """从 ss_tag_frequency 提取训练标签，按频次排序"""
    tf = meta.get('ss_tag_frequency', '{}')
    try:
        tag_data = json.loads(tf)
    except:
        return []
    all_tags = []
    for ds_name, tags in tag_data.items():
        all_tags.extend(tags.keys())
    # 过滤常用 quality/general tags 保留角色/特征标签
    skip = {'masterpiece','best quality','highres','absurdres','ultra_detailed',
            'high quality','newest','very aesthetic','1girl','1boy','solo',
            'looking at viewer','from behind','from side','close-up','cowboy shot',
            'upper body','upper body, upper body','upper body, upper body, upper body',
            'multiple girls','nude','nipples','pussy','breasts','medium breasts',
            'large breasts','small breasts','huge breasts','areolae'}
    chars = [t for t in all_tags 
             if t not in skip 
             and not any(t.startswith(p) for p in ['score_', 'censored', 'source_', 'rating_'])
             and len(t) > 2]
    return chars[:30]  # top 30 most specific tags


# ── 判断 LoRA 类型 ──
NSFW_HARD = {'cum','dildo','penetrat','penet','bukkake','futanari','gangbang',
             'blowjob','handjob','cuck','ntr','creampie','pov','anal','sex',
             'dick','nipple','pussy','vagina','tits','boob','breast','squirt',
             'masturb','orgasm','ballsack','ball_','vaginal'}
POSES = {'pose','squat','arch','bent','doggy','missionary','cowgirl','spoon',
         'frog','lotus','kneel','facedown','bent over','spread','legs up',
         'arms up','handstand','acrobat','choke','bondage','stuck','tied up'}


def classify_lora(filename, tags):
    """判断 LoRA 是角色类、姿势类、NSFW类"""
    name_lower = filename.lower()
    tag_text = ' '.join(tags).lower()
    # NSFW 姿势/行为类
    if any(k in name_lower or k in tag_text for k in NSFW_HARD):
        return 'nsfw_hard'
    # 纯姿势类
    if any(k in name_lower or k in tag_text for k in POSES):
        return 'pose'
    # 画风/概念类
    style_kw = ['style','画风','concept','touch','effect','watercolor','oil painting',
                'sketch','lineart','cyberpunk','ink','pixel','chibi','semi-realistic']
    if any(k in name_lower for k in style_kw):
        return 'style'
    # 默认为角色
    return 'character'


def extract_character_name(filename, tags):
    """从文件名和 tags 提取核心角色名"""
    name_no_ext = re.sub(r'\.safetensors$', '', filename)
    # 移除训练平台后缀
    name_clean = re.sub(r'_[a-z]+\d\.\d$|_v\d.*$|-\d+$|\d{6,}$', '', name_no_ext)
    # 从 tags 找第一个带下划线的英文人名
    for t in tags:
        if re.match(r'^[a-z][a-z ]+ [a-z][a-z ]+$', t) and ' ' in t:
            return t.title()
    # 从文件名取中文部分
    cn_match = re.search(r'[\u4e00-\u9fff]{2,}', name_clean)
    if cn_match:
        return cn_match.group()
    # 退回用清理后的文件名
    name_clean = re.sub(r'[-_]', ' ', name_clean).strip()[:40]
    return name_clean if name_clean else filename[:30]


def generate_style_tags():
    """预定义画风 tags（2x.nz 同款结构）"""
    styles = {
        "赛博朋克": "cyberpunk, neon lights, dark city, rainy, glowing signs, blade runner aesthetic",
        "古风": "traditional Chinese style, hanfu, ancient China, ink wash painting, classical",
        "水彩风": "watercolor, soft colors, paper texture, artistic, gentle strokes",
        "厚涂风": "thick paint style, impasto, oil painting texture, dramatic lighting",
        "线稿": "lineart, sketch, monochrome, black and white, clean lines",
        "像素风": "pixel art, 8-bit, retro game, blocky, chibi pixel",
        "Q版": "chibi, super deformed, cute, big head, small body, kawaii",
        "半写实": "semi-realistic, detailed, realistic shading, balanced style",
        "赛璐璐": "cell shade, anime style, flat colors, clean lines, toon shading",
        "暗黑风": "dark fantasy, gothic, gloomy, horror atmosphere, shadowy",
        "和风": "japanese style, kimono, ukiyo-e, traditional japanese, samurai aesthetic",
        "蒸汽波": "vaporwave, synthwave, retro 80s, neon, pastel, outrun aesthetic",
    }
    for name, tags in styles.items():
        path = os.path.join(TAGS_DIR, f"{name}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(tags)
        # 也写入 styles/ 供 /api/styles 使用
        style_path = os.path.join(OUT_STYLES, f"{name}.txt")
        with open(style_path, "w", encoding="utf-8") as f:
            f.write(tags)
    print(f"  ✅ {len(styles)} style tags created")
    return styles


def main():
    print("Scanning LoRAs...")
    loras = []
    for fname in sorted(os.listdir(LORA_DIR)):
        if not fname.endswith('.safetensors'):
            continue
        path = os.path.join(LORA_DIR, fname)
        meta = read_safetensors_meta(path)
        tags = extract_tags_from_metadata(meta)
        cat = classify_lora(fname, tags)
        
        if cat != 'character':
            continue  # skip nsfw/pose/style loras for now
        
        char_name = extract_character_name(fname, tags)
        base_model = meta.get('ss_base_model_version', meta.get('ss_sd_model_name', 'sdxl'))
        
        loras.append({
            "name": char_name,
            "lora_file": fname,
            "trigger_tags": tags[:8],  # top 8 tags as triggers
            "model_base": base_model,
            "model_target": "illustrious" if 'illustrious' in base_model.lower() or 'il' in fname.lower().split('_') 
                            else "pony" if 'pony' in fname.lower() or 'pony' in base_model.lower() 
                            else "sdxl",
        })
        print(f"  {char_name:25} ← {fname[:40]:40} tags:{','.join(tags[:3])}")

    # ── 去重角色名 ──
    seen_names = {}
    deduped = []
    for l in loras:
        name = l["name"]
        if name in seen_names:
            seen_names[name].append(l)
        else:
            seen_names[name] = [l]
    
    # 对每个角色保留最佳匹配
    characters = []
    for name, entries in seen_names.items():
        # 优先 pony 系 LoRA
        best = next((e for e in entries if e['model_target'] == 'pony'), None) or entries[0]
        # 同角色多 LoRA 标注
        alternatives = [e['lora_file'] for e in entries[1:3]]
        characters.append({
            "name": name,
            "lora_file": best["lora_file"],
            "trigger_tags": best["trigger_tags"],
            "model_target": best["model_target"],
            "alternatives": alternatives if alternatives else None,
        })

    # ── 写入 characters.json ──
    char_data = {"characters": characters, "total": len(characters)}
    with open(OUT_CHARS, "w", encoding="utf-8") as f:
        json.dump(char_data, f, indent=2, ensure_ascii=False)
    print(f"\n✅ {len(characters)} characters → {OUT_CHARS}")

    # ── 画风 tags ──
    styles = generate_style_tags()
    print(f"  {len(styles)} style presets → {TAGS_DIR}/ & {OUT_STYLES}/")
    print("=== Phase 2 complete ===")


if __name__ == "__main__":
    main()
