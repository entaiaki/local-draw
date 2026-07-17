"""build_workflow_library.py — 构建 ComfyUI 工作流库"""
import json, os, shutil

COMFYUI = r"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4"
WF_DIR = os.path.join(COMFYUI, "user", "default", "workflows")
WEB_DIR = r"E:\AI\natureDrawImage\web"

# ── 映射：模式 → checkpoint ──
MODE_MAP = {
    "WAI":     "ntrmix20XIII2.MJam.safetensors",           # Illustrious 系
    "ANIMA":   "animagineXl40Opt.Mt5n.safetensors",         # Animagine
    "Pony":    "prefectPonyV6Fp16.w74H.safetensors",        # Pony
    "Real":    "pornmasterRealismILV4.KmWG.safetensors",    # 写实
}

# ── 默认负面提示词 ──
NEGATIVE_DEFAULT = "worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text, signature, jpeg artifacts, ugly, deformed, disfigured, mutation, mutated, extra limbs, malformed limbs, fused fingers, too many fingers, long neck, poorly drawn hands, poorly drawn face, out of frame"
NEGATIVE_PONY = "score_6_up, score_5_up, score_4_up, source_pony, worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text, signature, jpeg artifacts, ugly, deformed, disfigured, mutation, mutated, extra limbs, malformed limbs, fused fingers, too many fingers, long neck, poorly drawn hands, poorly drawn face, out of frame"
NEGATIVE_ILLUSTRIOUS = "worst quality, low quality, blurry, bad anatomy, bad hands, watermark, text, signature, jpeg artifacts, ugly, deformed, disfigured, mutation, mutated, extra limbs, malformed limbs, fused fingers, too many fingers, long neck, poorly drawn hands, poorly drawn face, out of frame, lowres, bad composition"

# ── 分辨率预设 ──
RESOLUTIONS = {
    "横屏 16:9": {"width": 1344, "height": 768},
    "竖屏 9:16": {"width": 768,  "height": 1344},
    "横屏 3:2":  {"width": 1216, "height": 832},
    "竖屏 2:3":  {"width": 832,  "height": 1216},
    "方图 1:1":  {"width": 1024, "height": 1024},
}


def make_sdxl_workflow(checkpoint, negative=NEGATIVE_DEFAULT, title_prefix=""):
    """
    SDXL txt2img API 格式工作流 — ComfyUI v0.22.3 兼容。
    节点结构：CheckpointLoader → 2×CLIPTextEncode → KSampler → VAEDecode → SaveImage
    """
    wf = {}

    wf["1"] = {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}}
    wf["2"] = {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}}
    wf["3"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "masterpiece, best quality", "clip": ["1", 1]}}
    wf["4"] = {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["1", 1]}}
    wf["5"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0],
            "latent_image": ["2", 0],
            "seed": 42, "steps": 25, "cfg": 7,
            "sampler_name": "euler", "scheduler": "normal", "denoise": 1,
        },
    }
    wf["6"] = {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}}
    wf["7"] = {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "ComfyUI"}}
    return wf


def make_lora_workflow(checkpoint, lora_name, negative=NEGATIVE_DEFAULT, title_prefix=""):
    """SDXL txt2img + LoraLoader"""
    wf = {}

    # 1. CheckpointLoaderSimple
    wf["1"] = {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": checkpoint},
    }

    # 1b. LoraLoader
    wf["8"] = {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": lora_name,
            "strength_model": 0.8,
            "strength_clip": 0.8,
        },
    }

    # 2. EmptyLatentImage
    wf["2"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
    }

    # 3. CLIPTextEncode (positive)
    wf["3"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "masterpiece, best quality", "clip": ["8", 1]},
        "_meta": {"title": f"positive_{title_prefix}"},
    }

    # 4. CLIPTextEncode (negative)
    wf["4"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": negative, "clip": ["8", 1]},
        "_meta": {"title": f"negative_{title_prefix}"},
    }

    # 5. KSampler（从 LoraLoader 输出取 model）
    wf["5"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["8", 0],
            "positive": ["3", 0],
            "negative": ["4", 0],
            "latent": ["2", 0],
            "seed": 42,
            "steps": 25,
            "cfg": 7,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1,
        },
    }

    # 6. VAEDecode
    wf["6"] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": ["5", 0], "vae": ["1", 2]},
    }

    # 7. SaveImage
    wf["7"] = {
        "class_type": "SaveImage",
        "inputs": {"images": ["6", 0], "filename_prefix": "ComfyUI"},
    }

    return wf


def main():
    os.makedirs(WF_DIR, exist_ok=True)
    for mode, ckpt in MODE_MAP.items():
        neg = NEGATIVE_PONY if mode == "Pony" else (NEGATIVE_ILLUSTRIOUS if mode == "WAI" else NEGATIVE_DEFAULT)
        base_dir = os.path.join(WF_DIR, mode, "通用")
        os.makedirs(base_dir, exist_ok=True)

        # 无 Lora 基础工作流
        wf = make_sdxl_workflow(ckpt, neg, title_prefix=mode)
        wf_path = os.path.join(base_dir, "无Lora.json")
        with open(wf_path, "w", encoding="utf-8") as f:
            json.dump(wf, f, indent=2, ensure_ascii=False)
        print(f"  ✅ {mode}/通用/无Lora.json")

    # ── Flux 工作流：从 my_workflows 复制到 user/default/workflows/Flux ──
    flux_src = os.path.join(COMFYUI, "my_workflows", "flux_kontext_txt2img_api_workflow.json")
    flux_dst_dir = os.path.join(WF_DIR, "Flux")
    os.makedirs(flux_dst_dir, exist_ok=True)
    if os.path.exists(flux_src):
        shutil.copy2(flux_src, os.path.join(flux_dst_dir, "默认文生图.json"))
        print(f"  ✅ Flux/默认文生图.json (from my_workflows)")
    else:
        print(f"  ⚠️ flux_kontext 不存在: {flux_src}")

    # ── resolutions.json ──
    res_path = os.path.join(WEB_DIR, "resolutions.json")
    with open(res_path, "w", encoding="utf-8") as f:
        json.dump(RESOLUTIONS, f, indent=2, ensure_ascii=False)
    print(f"  ✅ resolutions.json")

    # ── styles 目录（空，画风库后续通过脚本生成） ──
    styles_dir = os.path.join(WEB_DIR, "styles")
    os.makedirs(styles_dir, exist_ok=True)
    print(f"  ✅ styles/ 目录就绪")

    # ── config 层面：本地点数设为 0（免积分） ──
    points_path = os.path.join(WEB_DIR, "points_config.json")
    points = {
        "text_to_image": 0, "image_to_image": 0, "llm_translate": 0,
        "text_to_image_anima": 0, "text_to_image_real": 0,
        "text_to_image_ernie": 0, "image_to_image_qwen": 0,
        "text_to_video": 0, "tts_generate": 0, "signup_bonus": 99999,
        "llm_token_per_point": 99999
    }
    with open(points_path, "w", encoding="utf-8") as f:
        json.dump(points, f, indent=2)
    print(f"  ✅ points_config.json (免积分)")

    print("\n=== 完成 ===")


if __name__ == "__main__":
    main()
