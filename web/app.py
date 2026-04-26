"""
ComfyUI 网页版控制台

启动: uvicorn web.app:app --host 0.0.0.0 --port 8080 --reload
"""

# ========== IP / 端口配置 ==========
COMFYUI_HOST = "127.0.0.1"
COMFYUI_PORT = 8000
LMS_HOST = "127.0.0.1"
LMS_PORT = 1234

WEB_HOST = "127.0.0.1"
WEB_PORT = 8080

# ComfyUI 输出目录（只读浏览）
OUTPUT_DIR_STR = r"C:\Users\acofo\Documents\ComfyUI\output"
# ===================================

import asyncio
import json
import random
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

COMFYUI_API = f"http://{COMFYUI_HOST}:{COMFYUI_PORT}"
LMS_API = f"http://{LMS_HOST}:{LMS_PORT}"
COMFYUI_WS = f"ws://{COMFYUI_HOST}:{COMFYUI_PORT}"

CLIENT_ID = uuid.uuid4().hex

STATE_FILE = Path(__file__).parent / "state.json"
OUTPUT_DIR = Path(OUTPUT_DIR_STR)
STATIC_DIR = Path(__file__).parent / "static"
THUMB_DIR = Path(__file__).parent / "thumbnails"
THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

app = FastAPI(title="ComfyUI Web")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------- state ----------------

def load_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: Dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------- ComfyUI helpers ----------------

async def list_workflows() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{COMFYUI_API}/api/userdata",
            params={"dir": "workflows", "recurse": "true", "split": "false", "full_info": "true"},
            headers={"Comfy-User": ""},
        )
        r.raise_for_status()
        return r.json()


async def get_workflow(path: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{COMFYUI_API}/api/userdata/workflows%2F{path}",
            headers={"Comfy-User": ""},
        )
        r.raise_for_status()
        return r.json()


async def submit_prompt(prompt: Dict[str, Any]) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{COMFYUI_API}/api/prompt",
            json={"client_id": CLIENT_ID, "prompt": prompt},
            headers={"Comfy-User": ""},
        )
        r.raise_for_status()
        return r.json()["prompt_id"]


async def interrupt_prompt() -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{COMFYUI_API}/api/interrupt", headers={"Comfy-User": ""})


async def get_history(prompt_id: str) -> Optional[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{COMFYUI_API}/api/history/{prompt_id}", headers={"Comfy-User": ""})
        r.raise_for_status()
        d = r.json()
        return d.get(prompt_id)


async def download_image(filename: str, subfolder: str, img_type: str) -> Tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(
            f"{COMFYUI_API}/api/view",
            params={"filename": filename, "subfolder": subfolder, "type": img_type},
            headers={"Comfy-User": ""},
        )
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "image/png")


# ---------------- workflow → prompt API ----------------

def summarize_workflow(data: Dict[str, Any]) -> Dict[str, Any]:
    nodes = data.get("nodes", [])
    types: Dict[str, int] = {}
    for node in nodes:
        t = node.get("type", "?")
        types[t] = types.get(t, 0) + 1
    return {
        "node_count": len(nodes),
        "link_count": len(data.get("links", [])),
        "group_count": len(data.get("groups", [])),
        "types": types,
    }


def workflow_to_prompt_api(workflow: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Tuple[str, str]]]:
    """与 dev/comfyui.py workflow_to_prompt_api 同步实现。"""
    prompt: Dict[str, Any] = {}
    positive_ref: Optional[Tuple[str, str]] = None

    top_nodes = workflow.get("nodes", [])
    top_links = workflow.get("links", [])
    subgraphs = {sg["id"]: sg for sg in workflow.get("definitions", {}).get("subgraphs", [])}

    subgraph_internal_outputs: Dict[str, Dict[int, Tuple[int, int]]] = {}
    for sg_id, sg in subgraphs.items():
        out_node_id = sg.get("outputNode", {}).get("id", -20)
        out_map: Dict[int, Tuple[int, int]] = {}
        for link in sg.get("links", []):
            if isinstance(link, dict) and link.get("target_id") == out_node_id:
                slot = link.get("target_slot", 0)
                out_map[slot] = (link.get("origin_id"), link.get("origin_slot", 0))
        subgraph_internal_outputs[sg_id] = out_map

    link_map: Dict[int, Tuple[str, int]] = {}
    top_node_by_id = {n["id"]: n for n in top_nodes}

    for link in top_links:
        if isinstance(link, list) and len(link) >= 6:
            lid, oid, oslot = link[0], link[1], link[2]
        elif isinstance(link, dict):
            lid, oid, oslot = link["id"], link["origin_id"], link.get("origin_slot", 0)
        else:
            continue

        src_node = top_node_by_id.get(oid)
        if src_node and src_node.get("type") in subgraphs:
            sg_id = src_node["type"]
            internal = subgraph_internal_outputs.get(sg_id, {}).get(oslot)
            if internal:
                int_nid, int_slot = internal
                link_map[lid] = (f"{sg_id}:{int_nid}", int_slot)
            else:
                link_map[lid] = (str(oid), oslot)
        else:
            link_map[lid] = (str(oid), oslot)

    def build_subgraph_link_map(sg, instance_node):
        sg_id = sg["id"]
        m: Dict[int, Tuple[str, int]] = {}
        ext_inputs: Dict[str, Tuple[str, int]] = {}
        for inp in instance_node.get("inputs", []) or []:
            link_id = inp.get("link")
            if link_id is not None and link_id in link_map:
                ext_inputs[inp.get("name")] = link_map[link_id]
        sg_inputs_list = sg.get("inputs", [])
        for link in sg.get("links", []):
            if not isinstance(link, dict):
                continue
            lid = link["id"]
            oid = link["origin_id"]
            oslot = link.get("origin_slot", 0)
            if oid < 0:
                if oslot < len(sg_inputs_list):
                    ext_name = sg_inputs_list[oslot]["name"]
                    if ext_name in ext_inputs:
                        m[lid] = ext_inputs[ext_name]
            else:
                m[lid] = (f"{sg_id}:{oid}", oslot)
        return m

    SEED_WIDGETS = {"seed", "noise_seed"}

    def extract_inputs(node, lmap):
        result: Dict[str, Any] = {}
        widgets = node.get("widgets_values", []) or []
        widget_idx = 0
        for inp in node.get("inputs", []) or []:
            name = inp.get("name")
            if not name:
                continue
            link_id = inp.get("link")
            is_widget = inp.get("widget") is not None
            ref = lmap.get(link_id) if link_id is not None else None
            if ref is not None:
                result[name] = [ref[0], ref[1]]
                if is_widget:
                    widget_idx += 1
                    if name in SEED_WIDGETS and widget_idx < len(widgets):
                        val = widgets[widget_idx]
                        if isinstance(val, str) and val in ("fixed", "increment", "decrement", "randomize"):
                            widget_idx += 1
            elif is_widget:
                if widget_idx < len(widgets):
                    result[name] = widgets[widget_idx]
                    widget_idx += 1
                if name in SEED_WIDGETS and widget_idx < len(widgets):
                    val = widgets[widget_idx]
                    if isinstance(val, str) and val in ("fixed", "increment", "decrement", "randomize"):
                        widget_idx += 1
        return result

    NON_EXEC = {"MarkdownNote", "Note", "Reroute", "PrimitiveNode"}

    for node in top_nodes:
        ntype = node.get("type", "")
        nid = str(node.get("id"))
        if ntype in NON_EXEC:
            continue
        if ntype in subgraphs:
            sg = subgraphs[ntype]
            sg_id = sg["id"]
            sg_lmap = build_subgraph_link_map(sg, node)
            proxy = node.get("properties", {}).get("proxyWidgets", []) or []
            instance_widgets = node.get("widgets_values", []) or []
            sg_widget_override: Dict[Tuple[int, str], Any] = {}
            for i, pair in enumerate(proxy):
                if i < len(instance_widgets) and isinstance(pair, list) and len(pair) == 2:
                    sg_widget_override[(int(pair[0]), pair[1])] = instance_widgets[i]
            for sub_node in sg.get("nodes", []):
                sub_type = sub_node.get("type", "")
                if sub_type in NON_EXEC:
                    continue
                sub_nid = f"{sg_id}:{sub_node['id']}"
                sub_inputs = extract_inputs(sub_node, sg_lmap)
                for inp in sub_node.get("inputs", []) or []:
                    name = inp.get("name")
                    if inp.get("widget") is not None:
                        key = (sub_node["id"], name)
                        if key in sg_widget_override:
                            sub_inputs[name] = sg_widget_override[key]
                prompt[sub_nid] = {
                    "inputs": sub_inputs,
                    "class_type": sub_type,
                    "_meta": {"title": sub_node.get("title", sub_type)},
                }
                title = sub_node.get("title", "")
                if sub_type == "CLIPTextEncode":
                    t_low = title.lower()
                    if "positive" in t_low or "[pos]" in t_low or "[prompt]" in t_low:
                        positive_ref = (sub_nid, "text")
            continue
        prompt[nid] = {
            "inputs": extract_inputs(node, link_map),
            "class_type": ntype,
            "_meta": {"title": node.get("title", ntype)},
        }

    if positive_ref is None:
        for node in top_nodes:
            if node.get("type") == "CLIPTextEncode":
                title = node.get("title", "")
                t_low = title.lower()
                if "positive" in t_low or "[pos]" in t_low or "[prompt]" in t_low:
                    positive_ref = (str(node["id"]), "text")
                    break

    if positive_ref is None:
        for nid, ndata in prompt.items():
            if ndata.get("class_type") in ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"):
                pos = ndata.get("inputs", {}).get("positive")
                if isinstance(pos, list) and len(pos) >= 1:
                    src_id = str(pos[0])
                    src = prompt.get(src_id)
                    if src and src.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL"):
                        positive_ref = (src_id, "text")
                        break

    return prompt, positive_ref


# ---------------- LLM ----------------

async def translate_prompt(
    prompt: str,
    original_prompt: Optional[str] = None,
    on_chunk: Optional[Any] = None,
) -> str:
    if original_prompt:
        system = (
            "你是 SD/Pony/Illustrious prompt 改写专家。用户提供原始tag和新描述，"
            "你输出最终英文逗号分隔tag。保持未要求改变的部分。只输出最终prompt，不解释，不输出中文。"
        )
        user = f"原始 prompt：\n{original_prompt}\n\n用户的新描述：\n{prompt}\n\n请生成最终的 prompt："
    else:
        system = (
            "将自然语言转换为 SD/Pony/Illustrious 英文 tag prompt。"
            "逗号分隔，顺序：主体>外观>动作>场景>光线>构图>质量词。只输出最终prompt，不解释，不输出中文。"
        )
        user = prompt

    body = {
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.7,
        "max_tokens": 999999,
        "stream": True,
    }

    chunks: List[str] = []
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", f"{LMS_API}/v1/chat/completions", json=body) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta", {}) or {}
                piece = delta.get("content") or ""
                if not piece:
                    continue
                chunks.append(piece)
                if on_chunk is not None:
                    try:
                        await on_chunk(piece)
                    except Exception:
                        pass
    return "".join(chunks).strip()


# ---------------- routes ----------------

@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def find_thumbnail(wf_path: str) -> Optional[Path]:
    """按工作流路径在 web/thumbnails/ 下查找同名图片。

    支持：
    - 完整 path（保留子目录），如 workflows/foo/bar.json → thumbnails/foo/bar.png
    - 仅 basename，去掉 .json 后缀
    """
    if not wf_path:
        return None
    stem = wf_path[:-5] if wf_path.lower().endswith(".json") else wf_path
    base = Path(stem)
    candidates = []
    for ext in THUMB_EXTS:
        candidates.append(THUMB_DIR / (str(base) + ext))
        candidates.append(THUMB_DIR / (base.name + ext))
    for c in candidates:
        try:
            cr = c.resolve()
            if cr.is_file() and str(cr).startswith(str(THUMB_DIR.resolve())):
                return cr
        except Exception:
            continue
    return None


@app.get("/api/workflows")
async def api_list():
    try:
        wfs = await list_workflows()
        for w in wfs:
            w["thumbnail"] = bool(find_thumbnail(w.get("path", "")))
        return {"workflows": wfs}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/thumbnail")
async def api_thumbnail(path: str):
    p = find_thumbnail(path)
    if not p:
        raise HTTPException(404, "no thumbnail")
    ext = p.suffix.lower().lstrip(".")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, f"image/{ext}")
    return FileResponse(str(p), media_type=media)


# ============== ComfyUI output 浏览（只读） ==============

OUTPUT_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def _resolve_output_path(rel: str) -> Path:
    """安全解析 OUTPUT_DIR 下的相对路径，防止路径穿越。"""
    if not rel:
        raise HTTPException(400, "path required")
    # 拒绝绝对路径与回溯
    rel_norm = rel.replace("\\", "/").lstrip("/")
    if ".." in rel_norm.split("/"):
        raise HTTPException(400, "invalid path")
    base = OUTPUT_DIR.resolve()
    candidate = (OUTPUT_DIR / rel_norm).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        raise HTTPException(400, "path escapes output dir")
    return candidate


@app.get("/api/output/list")
async def api_output_list(limit: int = 500, offset: int = 0):
    """递归列出 OUTPUT_DIR 下所有图片，按 mtime 倒序，分页。"""
    if not OUTPUT_DIR.exists():
        return {"items": [], "total": 0, "output_dir": str(OUTPUT_DIR), "exists": False}
    base = OUTPUT_DIR.resolve()
    items: List[Tuple[float, str, int]] = []
    for p in OUTPUT_DIR.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in OUTPUT_IMAGE_EXTS:
            continue
        try:
            rel = p.resolve().relative_to(base).as_posix()
        except Exception:
            continue
        try:
            st = p.stat()
        except Exception:
            continue
        items.append((st.st_mtime, rel, st.st_size))
    items.sort(key=lambda x: -x[0])
    total = len(items)
    sliced = items[offset:offset + max(0, min(limit, 2000))]
    return {
        "output_dir": str(OUTPUT_DIR),
        "exists": True,
        "total": total,
        "items": [
            {"path": rel, "mtime": mt, "size": sz} for (mt, rel, sz) in sliced
        ],
    }


@app.get("/api/output/file")
async def api_output_file(path: str):
    p = _resolve_output_path(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    if p.suffix.lower() not in OUTPUT_IMAGE_EXTS:
        raise HTTPException(400, "not an image")
    ext = p.suffix.lower().lstrip(".")
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, f"image/{ext}")
    return FileResponse(str(p), media_type=media)


def _extract_positive_from_prompt_json(prompt_json: Dict[str, Any]) -> str:
    """从 ComfyUI prompt API JSON 中追正向 CLIPTextEncode 文本。"""
    if not isinstance(prompt_json, dict):
        return ""
    # 1) 找 KSampler 系节点的 positive 引用 → 源 CLIPTextEncode
    sampler_types = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"}
    for nid, ndata in prompt_json.items():
        if not isinstance(ndata, dict):
            continue
        if ndata.get("class_type") in sampler_types:
            pos = (ndata.get("inputs") or {}).get("positive")
            if isinstance(pos, list) and len(pos) >= 1:
                src = prompt_json.get(str(pos[0]))
                if isinstance(src, dict) and src.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL"):
                    t = (src.get("inputs") or {}).get("text", "")
                    if isinstance(t, str) and t.strip():
                        return t.strip()
    # 2) 兜底：标题包含 positive/[pos]/[prompt] 的 CLIPTextEncode
    for nid, ndata in prompt_json.items():
        if not isinstance(ndata, dict):
            continue
        if ndata.get("class_type") == "CLIPTextEncode":
            title = ((ndata.get("_meta") or {}).get("title") or "").lower()
            if "positive" in title or "[pos]" in title or "[prompt]" in title:
                t = (ndata.get("inputs") or {}).get("text", "")
                if isinstance(t, str) and t.strip():
                    return t.strip()
    return ""


@app.get("/api/output/meta")
async def api_output_meta(path: str):
    """读取图片元数据（目前主要支持 PNG），返回正向 prompt（若可识别）。"""
    p = _resolve_output_path(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    if p.suffix.lower() != ".png":
        return {"path": path, "positive": "", "supported": False}
    try:
        from PIL import Image  # 延迟导入
        im = Image.open(p)
        info = im.info or {}
    except Exception as e:
        return {"path": path, "positive": "", "error": str(e)}

    positive = ""
    raw_prompt = info.get("prompt")
    if isinstance(raw_prompt, str):
        try:
            pj = json.loads(raw_prompt)
            positive = _extract_positive_from_prompt_json(pj)
        except Exception:
            pass
    # A1111 webui 风格兜底
    if not positive:
        params = info.get("parameters")
        if isinstance(params, str) and params.strip():
            # A1111: 第一段直到 "Negative prompt:" 之前
            head = params.split("Negative prompt:", 1)[0].strip()
            head = head.split("Steps:", 1)[0].strip()
            positive = head
    return {"path": path, "positive": positive, "supported": True}


@app.post("/api/workflows/select")
async def api_select(payload: Dict[str, str]):
    """已废弃：选择由前端 localStorage 维护。
    保留接口仅为向后兼容，仅校验工作流可加载并返回摘要，不写任何状态。
    """
    path = payload.get("path", "")
    if not path:
        raise HTTPException(400, "path required")
    try:
        data = await get_workflow(path)
    except Exception as e:
        raise HTTPException(500, f"加载失败: {e}")
    return {"ok": True, "path": path, "summary": summarize_workflow(data)}


RES_NODE_TYPES = {
    "EmptyLatentImage", "EmptySD3LatentImage", "EmptyLatentImageAdvanced",
    "ModelSamplingFlux", "EmptyHunyuanLatentVideo",
}


def find_resolution_nodes(prompt_dict: Dict[str, Any]) -> List[str]:
    """返回所有持有 width/height 输入的节点 id。"""
    out = []
    for nid, ndata in prompt_dict.items():
        inp = ndata.get("inputs", {}) or {}
        if "width" in inp and "height" in inp and isinstance(inp["width"], (int, float)) and isinstance(inp["height"], (int, float)):
            out.append(nid)
    return out


def detect_default_resolution(prompt_dict: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    nids = find_resolution_nodes(prompt_dict)
    if not nids:
        return None
    # 优先选 EmptyLatent 系
    for nid in nids:
        if prompt_dict[nid].get("class_type") in RES_NODE_TYPES:
            inp = prompt_dict[nid]["inputs"]
            return int(inp["width"]), int(inp["height"])
    inp = prompt_dict[nids[0]]["inputs"]
    return int(inp["width"]), int(inp["height"])


def apply_resolution(prompt_dict: Dict[str, Any], width: int, height: int) -> int:
    """把所有 width/height 节点都改写。返回修改的节点数。"""
    n = 0
    for nid in find_resolution_nodes(prompt_dict):
        prompt_dict[nid]["inputs"]["width"] = width
        prompt_dict[nid]["inputs"]["height"] = height
        n += 1
    return n


@app.get("/api/workflows/current")
async def api_current(path: Optional[str] = None):
    """返回指定工作流的摘要 + 默认分辨率。前端传 path（来自浏览器 localStorage）。
    不存在 path 参数时返回空，后端不再持有"当前工作流"状态。
    """
    if not path:
        return {"path": None}
    has_thumb = bool(find_thumbnail(path))
    try:
        data = await get_workflow(path)
    except Exception as e:
        return {"path": path, "error": str(e), "thumbnail": has_thumb}
    pd, positive_ref = workflow_to_prompt_api(data)
    res = detect_default_resolution(pd)
    builtin_prompt = ""
    if positive_ref:
        nid, inp = positive_ref
        v = pd.get(nid, {}).get("inputs", {}).get(inp, "")
        if isinstance(v, str):
            builtin_prompt = v.strip()
    return {
        "path": path,
        "summary": summarize_workflow(data),
        "thumbnail": has_thumb,
        "default_width": res[0] if res else None,
        "default_height": res[1] if res else None,
        "builtin_prompt": builtin_prompt,
    }


@app.get("/api/image")
async def api_image(filename: str, subfolder: str = "", type: str = "output"):
    try:
        content, ct = await download_image(filename, subfolder, type)
        return Response(content=content, media_type=ct)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/translate")
async def api_translate(payload: Dict[str, Any]):
    prompt = payload.get("prompt", "")
    if not prompt:
        raise HTTPException(400, "prompt required")
    try:
        out = await translate_prompt(
            prompt,
            original_prompt=payload.get("original_prompt") or None,
        )
        return {"text": out}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/interrupt")
async def api_interrupt():
    try:
        await interrupt_prompt()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, str(e))


class RunRequest(BaseModel):
    workflow_path: str = ""
    direct_prompt: str = ""
    nl_prompt: str = ""
    rewrite: bool = False
    override: bool = False
    width: Optional[int] = None
    height: Optional[int] = None


# 单一并发锁
_run_lock = asyncio.Lock()
# 广播：所有打开 /ws/status 的客户端
_status_subscribers: "set[WebSocket]" = set()
# 当前活跃任务快照：None 表示空闲
_active_status: Optional[Dict[str, Any]] = None
# 当前任务的事件回放缓冲（新连入的客户端可重建 UI）
# 元素: 原始 send 给前端的 dict
_event_log: List[Dict[str, Any]] = []


def _idle_snapshot() -> Dict[str, Any]:
    return {"busy": False}


async def _broadcast(msg: Dict[str, Any]) -> None:
    dead = []
    for sub in list(_status_subscribers):
        try:
            await sub.send_json(msg)
        except Exception:
            dead.append(sub)
    for d in dead:
        _status_subscribers.discard(d)


async def emit(ws: Optional[WebSocket], msg: Dict[str, Any]) -> None:
    """发送一条业务事件：发起者 ws + 所有订阅者 + 写入回放日志。"""
    _event_log.append(msg)
    # 发起者
    if ws is not None:
        try:
            await ws.send_json(msg)
        except Exception:
            pass
    # 订阅者（包装一层 mirror 包，前端可识别）
    await _broadcast({"type": "mirror", "event": msg})


async def _push_status(patch: Optional[Dict[str, Any]] = None, *, reset: bool = False) -> None:
    """更新 _active_status 并向所有订阅者广播。"""
    global _active_status
    if reset:
        _active_status = None
        _event_log.clear()
    elif patch:
        if _active_status is None:
            _active_status = {"busy": True}
        _active_status.update(patch)
    snap = {"type": "status", **(_active_status or _idle_snapshot())}
    await _broadcast(snap)


@app.websocket("/ws/status")
async def ws_status(ws: WebSocket):
    """只读订阅：当前任务状态 + 历史回放 + 后续广播。"""
    await ws.accept()
    _status_subscribers.add(ws)
    try:
        # 立即推快照
        await ws.send_json({"type": "status", **(_active_status or _idle_snapshot())})
        # 回放本次任务已发生的所有事件，让新页面重建 UI
        for evt in list(_event_log):
            await ws.send_json({"type": "mirror", "event": evt})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _status_subscribers.discard(ws)


@app.websocket("/ws/run")
async def ws_run(ws: WebSocket):
    """前端通过 WebSocket 提交并实时接收进度。

    协议:
      客户端首条消息: {direct_prompt, nl_prompt, rewrite, sentence_mode}
      服务端推送: {type: "log"|"progress"|"image"|"done"|"error", ...}
    """
    await ws.accept()

    if _run_lock.locked():
        await ws.send_json({
            "type": "error",
            "message": "服务器繁忙：已有任务在执行（其它页面/会话正在生图）",
            "busy": True,
        })
        await ws.close()
        return

    async with _run_lock:
        try:
            init = await ws.receive_json()
        except Exception:
            return
        try:
            await _run_task(ws, RunRequest(**init))
        except WebSocketDisconnect:
            return
        except Exception as e:
            try:
                await emit(ws, {"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            await _push_status(reset=True)


async def _run_task(ws: WebSocket, req: RunRequest):
    import time as _time
    path = req.workflow_path
    if not path:
        await emit(ws, {"type": "error", "message": "未指定工作流（前端未传 workflow_path）"})
        return

    await _push_status({
        "busy": True,
        "stage": "loading",
        "workflow": path,
        "started_at": _time.time(),
    })

    await emit(ws, {"type": "log", "message": f"[1/4] 加载工作流 {path}"})
    data = await get_workflow(path)
    prompt_dict, positive_ref = workflow_to_prompt_api(data)
    if not positive_ref:
        await emit(ws, {"type": "error", "message": "未找到正向 CLIPTextEncode 节点"})
        return
    node_id, input_name = positive_ref
    builtin = prompt_dict[node_id]["inputs"].get(input_name, "") or ""
    if not isinstance(builtin, str):
        builtin = str(builtin)
    builtin = builtin.strip()

    sep = ", "

    # 覆写模式：忽略工作流内置 prompt
    effective_builtin = "" if req.override else builtin
    if req.override:
        await emit(ws, {"type": "log", "message": "覆写模式：忽略工作流内置 prompt"})

    if req.nl_prompt:
        await emit(ws, {"type": "log", "message": f"[2/4] LLM {'改写' if req.rewrite else '翻译'}中..."})
        await emit(ws, {"type": "llm_start"})
        await _push_status({"stage": "llm"})

        async def _on_chunk(piece: str):
            await emit(ws, {"type": "llm_chunk", "delta": piece})

        base = req.direct_prompt or effective_builtin
        if req.rewrite and base:
            translated = await translate_prompt(
                req.nl_prompt, original_prompt=base, on_chunk=_on_chunk,
            )
            sd_prompt = translated
        else:
            translated = await translate_prompt(
                req.nl_prompt, on_chunk=_on_chunk,
            )
            parts = [p for p in (effective_builtin, req.direct_prompt, translated) if p]
            sd_prompt = sep.join(parts)
        await emit(ws, {"type": "llm_done", "text": translated})
    else:
        parts = [p for p in (effective_builtin, req.direct_prompt) if p]
        sd_prompt = sep.join(parts)
        await emit(ws, {"type": "log", "message": "[2/4] 跳过 LLM"})

    if not sd_prompt.strip():
        await emit(ws, {"type": "error", "message": "最终 prompt 为空"})
        return

    prompt_dict[node_id]["inputs"][input_name] = sd_prompt

    if req.width and req.height and req.width > 0 and req.height > 0:
        n = apply_resolution(prompt_dict, int(req.width), int(req.height))
        if n:
            await emit(ws, {"type": "log", "message": f"分辨率覆盖为 {req.width}x{req.height} ({n} 个节点)"})

    for nid, ndata in prompt_dict.items():
        if ndata.get("class_type") == "KSampler":
            inp = ndata.get("inputs", {})
            if "seed" in inp:
                inp["seed"] = random.randint(0, 2**63 - 1)

    await emit(ws, {"type": "log", "message": "[3/4] 提交到 ComfyUI..."})
    prompt_id = await submit_prompt(prompt_dict)
    await emit(ws, {"type": "log", "message": f"prompt_id={prompt_id[:8]}"})
    await emit(ws, {"type": "prompt_id", "prompt_id": prompt_id, "final_prompt": sd_prompt})
    await _push_status({
        "stage": "generating",
        "prompt_id": prompt_id,
        "final_prompt": sd_prompt[:200],
    })

    await emit(ws, {"type": "log", "message": "[4/4] 等待生成..."})
    history = await _wait_for(prompt_id, ws, prompt_dict)

    images = []
    for _, node_output in (history.get("outputs") or {}).items():
        for img in node_output.get("images", []) or []:
            images.append({
                "filename": img.get("filename", ""),
                "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
            })

    if not images:
        await emit(ws, {"type": "error", "message": "无图片输出"})
        return

    for img in images:
        url = f"/api/image?filename={img['filename']}&subfolder={img['subfolder']}&type={img['type']}"
        await emit(ws, {
            "type": "image",
            "url": url,
            "filename": img["filename"],
            "subfolder": img["subfolder"],
            "image_type": img["type"],
        })

    await emit(ws, {"type": "done", "final_prompt": sd_prompt, "count": len(images)})


async def _wait_for(prompt_id: str, ws: WebSocket, prompt_dict: Dict[str, Any], timeout: int = 600) -> Dict[str, Any]:
    ws_url = f"{COMFYUI_WS}/ws?clientId={CLIENT_ID}"
    start = asyncio.get_event_loop().time()
    completed = False
    try:
        async with websockets.connect(ws_url, max_size=None) as cws:
            while True:
                if asyncio.get_event_loop().time() - start > timeout:
                    raise TimeoutError("生成超时")
                try:
                    raw = await asyncio.wait_for(cws.recv(), timeout=2)
                except asyncio.TimeoutError:
                    continue
                if isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                msg_type = msg.get("type", "")
                data = msg.get("data", {}) or {}
                if data.get("prompt_id") and data["prompt_id"] != prompt_id:
                    if msg_type != "status":
                        continue
                if msg_type == "progress_state":
                    nodes = data.get("nodes") or {}
                    running = None
                    done = 0
                    total = len(nodes)
                    for _, ninfo in nodes.items():
                        st = ninfo.get("state")
                        if st == "finished":
                            done += 1
                        elif st == "running" and running is None:
                            running = ninfo
                    if running:
                        rid = running.get("node_id")
                        cls = prompt_dict.get(str(rid), {}).get("class_type", str(rid))
                        cv = running.get("value", 0)
                        cm = running.get("max", 0)
                        prog = {
                            "type": "progress",
                            "node": cls,
                            "value": cv,
                            "max": cm,
                            "done": done,
                            "total": total,
                        }
                        await emit(ws, prog)
                        await _push_status({
                            "stage": "generating",
                            "node": cls,
                            "value": cv,
                            "max": cm,
                            "done": done,
                            "total": total,
                        })
                elif msg_type == "executing":
                    node = data.get("node")
                    if node is not None:
                        cls = prompt_dict.get(str(node), {}).get("class_type", str(node))
                        await emit(ws, {"type": "progress", "node": cls})
                        await _push_status({"stage": "generating", "node": cls})
                    elif data.get("prompt_id") == prompt_id:
                        completed = True
                        break
                elif msg_type == "execution_success":
                    completed = True
                    break
                elif msg_type == "execution_error":
                    err = data.get("exception_message", "执行错误")
                    raise RuntimeError(f"ComfyUI: {err}")
    except websockets.WebSocketException:
        pass

    for _ in range(60):
        h = await get_history(prompt_id)
        if h:
            return h
        if asyncio.get_event_loop().time() - start > timeout:
            raise TimeoutError("等待 history 超时")
        await asyncio.sleep(1)
    raise TimeoutError("无法获取 history")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="ComfyUI Web 控制台")
    parser.add_argument("--host", default=WEB_HOST,
                        help=f"监听地址，默认 {WEB_HOST}。用 0.0.0.0 监听所有地址")
    parser.add_argument("--port", type=int, default=WEB_PORT, help=f"端口，默认 {WEB_PORT}")
    parser.add_argument("--reload", action="store_true",
                        help="开启代码热重载（py 文件变更自动重启）")
    args = parser.parse_args()

    if args.reload:
        # reload 模式必须传 import string
        # 兼容两种启动方式：
        #   python -m web.app          → __package__ == "web"
        #   python web/app.py / uv run → __package__ 为空，需把父目录加进 sys.path
        import sys
        here = Path(__file__).parent
        if not __package__:
            sys.path.insert(0, str(here.parent))
        uvicorn.run(
            "web.app:app",
            host=args.host,
            port=args.port,
            reload=True,
            reload_dirs=[str(here)],
            app_dir=str(here.parent),
        )
    else:
        uvicorn.run(app, host=args.host, port=args.port)
