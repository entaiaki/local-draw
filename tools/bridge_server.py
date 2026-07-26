"""Unified bridge server: diffusers pipelines over HTTP.
Run with ComfyUI's embedded python, env-isolated:
  env -u PYTHONPATH -u VIRTUAL_ENV <cu>/python/python.exe tools/bridge_server.py
"""
import json, os, sys, time, threading
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # 模型已全下载, 禁联网

import torch
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

DIFFUSERS = r"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\models\diffusers"
OUT_DIR = r"E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\output"

# 模型注册表: alias -> (subdir, pipeline类型, 默认步数, 默认guidance)
MODELS = {
    "zimage-turbo": ("Z-Image-Turbo", "zimage", 9, 0.0),
    "zimage-base":  ("Z-Image-Base",  "zimage", 30, 4.0),
    "glm-image":    ("GLM-Image",     "glm",    30, 1.5),
    "flux2-klein":  ("FLUX.2-Klein-4B", "flux2", 4, 1.0),
}

_pipes = {}          # alias -> loaded pipeline
_lock = threading.Lock()

def _load(alias):
    if alias in _pipes:
        return _pipes[alias]
    with _lock:
        if alias in _pipes:
            return _pipes[alias]
        subdir, kind, _, _ = MODELS[alias]
        path = os.path.join(DIFFUSERS, subdir)
        if not os.path.isdir(path):
            raise FileNotFoundError(f"model dir missing: {path}")
        t0 = time.time()
        if kind == "zimage":
            from diffusers import ZImagePipeline as P
        elif kind == "glm":
            from diffusers import GlmImagePipeline as P
        elif kind == "flux2":
            from diffusers import Flux2Pipeline as P
        pipe = P.from_pretrained(path, torch_dtype=torch.bfloat16)
        pipe.to("cuda")
        _pipes[alias] = pipe
        print(f"[bridge] loaded {alias} in {time.time()-t0:.1f}s", flush=True)
        return pipe

class GenReq(BaseModel):
    model: str
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    steps: int = 0          # 0=用模型默认
    guidance: float = -1    # -1=用模型默认
    seed: int = -1

app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True, "loaded": list(_pipes.keys())}

@app.get("/models")
def models():
    out = []
    for alias, (subdir, kind, steps, cfg) in MODELS.items():
        out.append({"alias": alias, "kind": kind, "steps": steps, "cfg": cfg,
                    "dir_exists": os.path.isdir(os.path.join(DIFFUSERS, subdir)),
                    "loaded": alias in _pipes})
    return out

@app.post("/generate")
def generate(req: GenReq):
    if req.model not in MODELS:
        return {"ok": False, "error": f"unknown model: {req.model}"}
    _, kind, def_steps, def_cfg = MODELS[req.model]
    steps = req.steps if req.steps > 0 else def_steps
    cfg = req.guidance if req.guidance >= 0 else def_cfg
    seed = req.seed if req.seed >= 0 else int(time.time_ns() % 2**32)

    try:
        t0 = time.time()
        pipe = _load(req.model)
        load_sec = time.time() - t0

        kwargs = {
            "prompt": req.prompt,
            "height": req.height,
            "width": req.width,
            "num_inference_steps": steps,
            "generator": torch.Generator("cuda").manual_seed(seed),
        }
        if kind == "zimage":
            kwargs["guidance_scale"] = cfg
            if cfg > 0 and req.negative_prompt:
                kwargs["negative_prompt"] = req.negative_prompt
        elif kind == "glm":
            kwargs["guidance_scale"] = cfg
        elif kind == "flux2":
            kwargs["guidance_scale"] = cfg

        t1 = time.time()
        image = pipe(**kwargs).images[0]
        gen_sec = time.time() - t1

        os.makedirs(OUT_DIR, exist_ok=True)
        fname = f"bridge_{req.model}_{int(time.time()*1000)}.png"
        fpath = os.path.join(OUT_DIR, fname)
        image.save(fpath)
        return {"ok": True, "filename": fname, "seed": seed,
                "load_sec": round(load_sec, 1), "gen_sec": round(gen_sec, 1),
                "size_kb": os.path.getsize(fpath) // 1024}
    except Exception as e:
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="warning")
