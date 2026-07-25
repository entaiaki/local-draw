#!/usr/bin/env python
"""Z-Image bridge: load diffusers pipeline, accept prompt via stdin JSON, output image.

Usage (called by natureDrawImage node-server):
  python tools/zimage_bridge.py <model_dir> <output_path>
  stdin: {"prompt": "...", "negative_prompt": "...", "width": 1024, "height": 1024, "steps": 8, "guidance": 0.0}
"""

import json, sys, os, time, torch
from pathlib import Path

# Point HF downloads to mirror
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

MODEL_DIR = sys.argv[1] if len(sys.argv) > 1 else None
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "output.png"

if not MODEL_DIR:
    print("Usage: python zimage_bridge.py <model_dir> <output_path>", file=sys.stderr)
    sys.exit(1)

# Load input
params = json.load(sys.stdin)
prompt = params.get("prompt", "A beautiful landscape")
negative = params.get("negative_prompt", "")
width = int(params.get("width", 1024))
height = int(params.get("height", 1024))
steps = int(params.get("steps", 8))
guidance = float(params.get("guidance", 0.0))
seed = int(params.get("seed", time.time_ns() % 2**32))

print(f"[zimage-bridge] Loading model from {MODEL_DIR}...", file=sys.stderr)
t0 = time.time()

# Determine model type from directory name
model_name = Path(MODEL_DIR).name.lower()
is_turbo = "turbo" in model_name

# Load
try:
    from diffusers import ZImagePipeline

    if is_turbo:
        pipe = ZImagePipeline.from_pretrained(
            MODEL_DIR,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
    else:
        pipe = ZImagePipeline.from_pretrained(
            MODEL_DIR,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
    pipe.to("cuda")
    
    load_time = time.time() - t0
    print(f"[zimage-bridge] Model loaded in {load_time:.1f}s", file=sys.stderr)

    # Generate
    t1 = time.time()
    gen_kwargs = {
        "prompt": prompt,
        "height": height,
        "width": width,
        "num_inference_steps": steps,
        "generator": torch.Generator("cuda").manual_seed(seed),
    }
    
    if is_turbo:
        gen_kwargs["guidance_scale"] = 0.0  # Turbo uses no CFG
    else:
        gen_kwargs["guidance_scale"] = guidance
        gen_kwargs["negative_prompt"] = negative
        gen_kwargs["cfg_normalization"] = True
    
    image = pipe(**gen_kwargs).images[0]
    gen_time = time.time() - t1
    
    # Save
    Path(OUT_PATH).parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT_PATH)
    size_kb = Path(OUT_PATH).stat().st_size // 1024
    
    print(json.dumps({
        "ok": True,
        "output": OUT_PATH,
        "size_kb": size_kb,
        "load_sec": round(load_time, 1),
        "gen_sec": round(gen_time, 1),
        "seed": seed,
    }))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
