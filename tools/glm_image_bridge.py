#!/usr/bin/env python
"""GLM-Image bridge: load diffusers pipeline, accept prompt, output image.

Usage (called by natureDrawImage node-server):
  python tools/glm_image_bridge.py <model_dir> <output_path>
  stdin: {"prompt": "...", "width": 1024, "height": 1024}
"""

import json, sys, os, time, torch
from pathlib import Path

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

MODEL_DIR = sys.argv[1]
OUT_PATH = sys.argv[2]

params = json.load(sys.stdin)
prompt = params.get("prompt", "A beautiful landscape")
width = int(params.get("width", 1024))
height = int(params.get("height", 1024))
seed = int(params.get("seed", time.time_ns() % 2**32))
num_images = int(params.get("num_images", 1))

print(f"[glm-image-bridge] Loading from {MODEL_DIR}...", file=sys.stderr)
t0 = time.time()

try:
    from diffusers import GlmImagePipeline

    pipe = GlmImagePipeline.from_pretrained(
        MODEL_DIR,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    pipe.to("cuda")
    load_time = time.time() - t0
    print(f"[glm-image-bridge] Loaded in {load_time:.1f}s", file=sys.stderr)

    t1 = time.time()
    gen = torch.Generator("cuda").manual_seed(seed)
    images = pipe(
        prompt=[prompt] * num_images if num_images > 1 else prompt,
        height=height,
        width=width,
        generator=gen,
    ).images

    gen_time = time.time() - t1

    out_paths = []
    Path(OUT_PATH).parent.mkdir(parents=True, exist_ok=True)
    for i, img in enumerate(images):
        if num_images > 1:
            p = OUT_PATH.replace(".png", f"_{i}.png")
        else:
            p = OUT_PATH
        img.save(p)
        out_paths.append(p)

    total_kb = sum(Path(p).stat().st_size for p in out_paths) // 1024
    print(json.dumps({
        "ok": True,
        "outputs": out_paths,
        "total_kb": total_kb,
        "load_sec": round(load_time, 1),
        "gen_sec": round(gen_time, 1),
        "seed": seed,
    }))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
