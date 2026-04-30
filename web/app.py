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
import os
import random
import uuid
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Optional, Tuple

import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
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
LORA_LINKS_DIR = Path(__file__).parent / "lora_links"
WORKFLOW_META_FILE = Path(__file__).parent / "workflow_meta.json"
CREATOR_MAP_FILE = Path(__file__).parent / "creator_ips.txt"
_creator_map_lock = asyncio.Lock()

# ---------------- 管理员 / 封禁列表 / 精选 ----------------
# 注意：本服务自身不做任何鉴权，/admin 与 /api/admin/* 公开可达。
# 部署时务必在反向代理（Cloudflare Access、nginx auth_basic、IP 白名单等）
# 上做访问控制；详见 README「部署与鉴权」一节。
BANNED_IPS_FILE = Path(__file__).parent / "banned_ips.txt"
FEATURED_FILE = Path(__file__).parent / "featured.txt"
LIMITS_FILE = Path(__file__).parent / "limits.json"
ANNOUNCEMENT_FILE = Path(__file__).parent / "announcement.json"
LLM_CONFIG_FILE = Path(__file__).parent / "llm_config.json"
REPORTS_FILE = Path(__file__).parent / "reports.json"
STYLES_FILE = Path(__file__).parent / "styles.json"
STYLE_THUMB_DIR = Path(__file__).parent / "style_thumbnails"
_banned_lock = asyncio.Lock()
_featured_lock = asyncio.Lock()
_limits_lock = asyncio.Lock()
_reports_lock = asyncio.Lock()
_styles_lock = asyncio.Lock()
_announcement_lock = asyncio.Lock()
_llm_config_lock = asyncio.Lock()
_REPORT_RATE: Dict[str, List[float]] = {}
_RATE_LAST_TS: Dict[str, float] = {}  # client_ip -> 上次开始生图的时间戳（用于生图冷却）

DEFAULT_LIMITS = {
    "gen_cooldown_sec": 30,    # 单 IP 两次生图最少间隔（秒）
    "image_rate_window_sec": 60,  # 图片限流滑动窗口（秒）
    "image_rate_max": 120,        # 每个 IP 在窗口内允许的图片请求数
    "report_window_sec": 300,     # 举报滑动窗口（秒）
    "report_window_max": 3,       # 窗口内最多举报次数
    "report_pending_max": 10,     # 单 IP 最多待处理举报数
    "gpu_poll_interval_ms": 5000,  # 前端轮询 GPU 状态间隔（毫秒）
    "gpu_cache_ttl_ms": 5000,      # 后端 nvidia-smi 缓存有效期（毫秒）
    "gc_interval_hours": 6,        # 定时 GC 执行间隔（小时），0 = 禁用
}


def _load_limits() -> Dict[str, int]:
    if LIMITS_FILE.is_file():
        try:
            data = json.loads(LIMITS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                merged = dict(DEFAULT_LIMITS)
                for k, v in data.items():
                    if k in DEFAULT_LIMITS and isinstance(v, (int, float)) and v >= 0:
                        merged[k] = int(v)
                return merged
        except Exception:
            pass
    return dict(DEFAULT_LIMITS)


_limits: Dict[str, int] = _load_limits()


async def _save_limits(new_limits: Dict[str, int]) -> bool:
    async with _limits_lock:
        try:
            tmp = LIMITS_FILE.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(new_limits, f, ensure_ascii=False, indent=2)
            os.replace(tmp, LIMITS_FILE)
            return True
        except Exception:
            return False



# ---------------- 公告 ----------------
DEFAULT_ANNOUNCEMENT = {"enabled": False, "title": "", "content": ""}


def _load_announcement() -> Dict[str, Any]:
    if not ANNOUNCEMENT_FILE.is_file():
        return dict(DEFAULT_ANNOUNCEMENT)
    try:
        d = json.loads(ANNOUNCEMENT_FILE.read_text(encoding="utf-8"))
        if not isinstance(d, dict):
            return dict(DEFAULT_ANNOUNCEMENT)
        return {
            "enabled": bool(d.get("enabled", False)),
            "title": str(d.get("title") or ""),
            "content": str(d.get("content") or ""),
        }
    except Exception:
        return dict(DEFAULT_ANNOUNCEMENT)


_announcement: Dict[str, Any] = _load_announcement()


async def _save_announcement(state: Dict[str, Any]) -> bool:
    async with _announcement_lock:
        try:
            tmp = ANNOUNCEMENT_FILE.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, ANNOUNCEMENT_FILE)
            return True
        except Exception:
            return False


# ---------------- 画风配置 ----------------
def _load_styles() -> List[Dict[str, Any]]:
    if not STYLES_FILE.is_file():
        return []
    try:
        d = json.loads(STYLES_FILE.read_text(encoding="utf-8"))
        if not isinstance(d, list):
            return []
        return [
            {"name": str(s.get("name", "")), "tags": str(s.get("tags", "")), "image": str(s.get("image", ""))}
            for s in d if isinstance(s, dict) and str(s.get("tags", "")).strip()
        ]
    except Exception:
        return []


_styles: List[Dict[str, Any]] = _load_styles()


async def _save_styles(data: List[Dict[str, Any]]) -> bool:
    async with _styles_lock:
        try:
            tmp = STYLES_FILE.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, STYLES_FILE)
            return True
        except Exception:
            return False


# ---------------- 工作流元数据（缩略图 + Lora 链接） ----------------
def _load_workflow_meta() -> Dict[str, Dict[str, str]]:
    if not WORKFLOW_META_FILE.is_file():
        return {}
    try:
        d = json.loads(WORKFLOW_META_FILE.read_text(encoding="utf-8"))
        if not isinstance(d, list):
            return {}
        result = {}
        for item in d:
            if not isinstance(item, dict):
                continue
            wf = str(item.get("workflow", "")).strip()
            if not wf:
                continue
            entry = {}
            if item.get("thumbnail"):
                entry["thumbnail"] = str(item["thumbnail"])
            if item.get("lora_link"):
                entry["lora_link"] = str(item["lora_link"])
            if entry:
                result[wf] = entry
        return result
    except Exception:
        return {}


def _save_workflow_meta_file(data: Dict[str, Dict[str, str]]) -> bool:
    try:
        arr = []
        for wf in sorted(data):
            entry = {"workflow": wf}
            entry.update(data[wf])
            arr.append(entry)
        tmp = WORKFLOW_META_FILE.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(arr, f, ensure_ascii=False, indent=2)
        os.replace(tmp, WORKFLOW_META_FILE)
        return True
    except Exception:
        return False


_workflow_meta: Dict[str, Dict[str, str]] = _load_workflow_meta()


# ---------------- LLM 配置 ----------------
DEFAULT_LLM_CONFIG = {
    "provider": "local",           # "local" | "google" | "custom"
    "local_endpoint": f"http://{LMS_HOST}:{LMS_PORT}",
    "google_api_key": "",          # Google AI Studio API Key
    "google_model": "gemma-4-31b-it",
    "google_thinking": "off",      # "off" | "level_*" | "budget_*"
    "custom_endpoint": "",         # 自定义 OpenAI 兼容 API 的 base URL
    "custom_api_key": "",
    "custom_model": "",
    "llm_stream": True,            # True=SSE 流式，False=普通请求（所有 provider 通用）
}

_GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _load_llm_config() -> Dict[str, Any]:
    if not LLM_CONFIG_FILE.is_file():
        return dict(DEFAULT_LLM_CONFIG)
    try:
        d = json.loads(LLM_CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(d, dict):
            return dict(DEFAULT_LLM_CONFIG)
        return {
            "provider": d.get("provider") if d.get("provider") in ("local", "google", "custom") else "local",
            "local_endpoint": str(d.get("local_endpoint") or DEFAULT_LLM_CONFIG["local_endpoint"]),
            "google_api_key": str(d.get("google_api_key") or ""),
            "google_model": str(d.get("google_model") or DEFAULT_LLM_CONFIG["google_model"]),
            "google_thinking": str(d.get("google_thinking") or "off"),
            "custom_endpoint": str(d.get("custom_endpoint") or ""),
            "custom_api_key": str(d.get("custom_api_key") or ""),
            "custom_model": str(d.get("custom_model") or ""),
            "llm_stream": bool(d.get("llm_stream", True)),
        }
    except Exception:
        return dict(DEFAULT_LLM_CONFIG)


_llm_config: Dict[str, Any] = _load_llm_config()


async def _save_llm_config(state: Dict[str, Any]) -> bool:
    async with _llm_config_lock:
        try:
            tmp = LLM_CONFIG_FILE.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
            os.replace(tmp, LLM_CONFIG_FILE)
            return True
        except Exception:
            return False


def _load_reports() -> list:
    if REPORTS_FILE.is_file():
        try:
            data = json.loads(REPORTS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


async def _save_reports(reports: list) -> bool:
    async with _reports_lock:
        try:
            tmp = REPORTS_FILE.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(reports, f, ensure_ascii=False, indent=2)
            os.replace(tmp, REPORTS_FILE)
            return True
        except Exception:
            return False


async def _auto_dismiss_reports_for_image(image_path: str):
    """图片被删除后，自动忽略该图所有剩余待处理举报。"""
    reports = _load_reports()
    changed = False
    for r in reports:
        if r.get("status") == "pending" and r.get("image_path") == image_path:
            r["status"] = "resolved"
            r["resolved_action"] = "dismiss"
            changed = True
    if changed:
        await _save_reports(reports)


def _client_ip_from_request(request: Request) -> str:
    h = request.headers
    return (
        h.get("cf-connecting-ip")
        or (h.get("x-forwarded-for", "").split(",")[0].strip() if h.get("x-forwarded-for") else "")
        or (request.client.host if request.client else "")
        or ""
    )


def _read_banned_ips() -> list:
    """返回封禁 IP 列表，保持文件中的顺序（最后一个是最新封禁的）。"""
    if not BANNED_IPS_FILE.is_file():
        return []
    try:
        seen = []
        for ln in BANNED_IPS_FILE.read_text(encoding="utf-8").splitlines():
            ip = ln.strip()
            if ip and not ip.startswith("#"):
                seen.append(ip)
        return seen
    except Exception:
        return []


def _read_banned_ips_set() -> set:
    return set(_read_banned_ips())


async def _write_banned_ips(ips: list) -> bool:
    async with _banned_lock:
        try:
            tmp = BANNED_IPS_FILE.with_suffix(".txt.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(ips) + ("\n" if ips else ""))
            os.replace(tmp, BANNED_IPS_FILE)
            return True
        except Exception:
            return False


def is_ip_banned(ip: str) -> bool:
    if not ip:
        return False
    return ip in _read_banned_ips_set()


def _read_featured() -> List[str]:
    """精选图片相对路径列表，按管理员设定顺序保留。"""
    if not FEATURED_FILE.is_file():
        return []
    try:
        out: List[str] = []
        seen: set = set()
        for ln in FEATURED_FILE.read_text(encoding="utf-8").splitlines():
            rel = ln.strip()
            if not rel or rel.startswith("#") or rel in seen:
                continue
            seen.add(rel)
            out.append(rel)
        return out
    except Exception:
        return []


async def _write_featured(items: List[str]) -> bool:
    async with _featured_lock:
        try:
            tmp = FEATURED_FILE.with_suffix(".txt.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(items) + ("\n" if items else ""))
            os.replace(tmp, FEATURED_FILE)
            return True
        except Exception:
            return False


def _creator_key(p: Path) -> str:
    """相对 OUTPUT_DIR 的正斜杠路径。"""
    try:
        rel = p.resolve().relative_to(OUTPUT_DIR.resolve())
    except Exception:
        rel = Path(p.name)
    return str(rel).replace("\\", "/")


def _creator_map_get(rel: str) -> str:
    if not CREATOR_MAP_FILE.is_file():
        return ""
    try:
        with open(CREATOR_MAP_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\r\n")
                if not line or "\t" not in line:
                    continue
                k, _, v = line.partition("\t")
                if k == rel:
                    return v
    except Exception:
        return ""
    return ""


async def _creator_map_set(rel: str, ip: str) -> bool:
    """每行 `<rel>\\t<ip>`，同 key 去重保留最新；原子替换。"""
    if not rel or not ip:
        return False
    async with _creator_map_lock:
        try:
            lines: list[str] = []
            if CREATOR_MAP_FILE.is_file():
                with open(CREATOR_MAP_FILE, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.rstrip("\r\n")
                        if not line or "\t" not in line:
                            continue
                        if line.split("\t", 1)[0] == rel:
                            continue
                        lines.append(line)
            lines.append(f"{rel}\t{ip}")
            tmp = CREATOR_MAP_FILE.with_suffix(".txt.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            os.replace(tmp, CREATOR_MAP_FILE)
            return True
        except Exception:
            return False

app = FastAPI(title="自然语言生图")
# 文本响应（JSON / HTML / JS / CSS）做轻量级 gzip 压缩；图片字节走另一条路（webp 转码）
app.add_middleware(GZipMiddleware, minimum_size=512, compresslevel=4)


# 全局禁止搜索引擎索引
@app.middleware("http")
async def _no_index_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet, noimageindex"
    return resp


# 图片端点的滑动窗口限流：保护 /api/output/file、/api/image、/api/thumbnail
_IMAGE_RATE_PATHS = ("/api/output/file", "/api/image", "/api/thumbnail")
_image_rate_buckets: Dict[str, List[float]] = {}

@app.middleware("http")
async def _image_rate_limit(request: Request, call_next):
    if not request.url.path.startswith(_IMAGE_RATE_PATHS):
        return await call_next(request)
    # 管理员面板跳过限流
    referer = request.headers.get("referer", "")
    if "/admin" in referer:
        return await call_next(request)
    window = float(_limits.get("image_rate_window_sec", 60))
    cap = int(_limits.get("image_rate_max", 120))
    if window <= 0 or cap <= 0:
        return await call_next(request)
    ip = _client_ip_from_request(request)
    if not ip:
        return await call_next(request)
    import time as _time
    now = _time.time()
    bucket = _image_rate_buckets.get(ip) or []
    cutoff = now - window
    bucket = [t for t in bucket if t >= cutoff]
    if len(bucket) >= cap:
        retry_after = max(1, int(bucket[0] + window - now))
        return Response(
            content=f"请求太频繁，{retry_after}s 后重试",
            status_code=429,
            media_type="text/plain; charset=utf-8",
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)
    _image_rate_buckets[ip] = bucket
    return await call_next(request)


# ---------------- 定时 GC ----------------
_gc_task: Optional[asyncio.Task] = None


async def _run_gc():
    """清理已处理举报、过期内存限流数据、孤儿 creator 映射。"""
    import time as _time
    now = _time.time()
    cleaned: Dict[str, int] = {}

    # 1. 清理已处理/无效举报（status != "pending"）
    reports = _load_reports()
    before = len(reports)
    reports = [r for r in reports if r.get("status") == "pending"]
    removed_reports = before - len(reports)
    if removed_reports > 0:
        await _save_reports(reports)
    cleaned["resolved_reports"] = removed_reports

    # 2. 清理内存中过期的限流条目
    window_report = float(_limits.get("report_window_sec", 300))
    stale_keys = [k for k, v in _REPORT_RATE.items() if all(now - t >= window_report for t in v)]
    for k in stale_keys:
        del _REPORT_RATE[k]
    cleaned["report_rate_entries"] = len(stale_keys)

    cooldown = float(_limits.get("gen_cooldown_sec", 30))
    stale_keys = [k for k, ts in _RATE_LAST_TS.items() if now - ts >= cooldown]
    for k in stale_keys:
        del _RATE_LAST_TS[k]
    cleaned["gen_cooldown_entries"] = len(stale_keys)

    window_img = float(_limits.get("image_rate_window_sec", 60))
    stale_keys = [k for k, v in _image_rate_buckets.items() if all(now - t >= window_img for t in v)]
    for k in stale_keys:
        del _image_rate_buckets[k]
    cleaned["image_rate_entries"] = len(stale_keys)

    # 3. 清理孤儿 creator 映射（图片已不存在）
    orphan_count = 0
    async with _creator_map_lock:
        try:
            if CREATOR_MAP_FILE.is_file():
                kept = []
                for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                    if not ln or "\t" not in ln:
                        continue
                    rel = ln.split("\t", 1)[0]
                    p = OUTPUT_DIR / rel.replace("/", os.sep)
                    if p.is_file():
                        kept.append(ln)
                    else:
                        orphan_count += 1
                if orphan_count > 0:
                    tmp = CREATOR_MAP_FILE.with_suffix(".txt.tmp")
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write("\n".join(kept) + ("\n" if kept else ""))
                    os.replace(tmp, CREATOR_MAP_FILE)
        except Exception:
            pass
    cleaned["orphan_creator_entries"] = orphan_count

    return cleaned


async def _gc_loop():
    """后台 GC 循环，按 gc_interval_hours 定时执行。"""
    while True:
        interval_h = float(_limits.get("gc_interval_hours", 6))
        if interval_h <= 0:
            await asyncio.sleep(3600)
            continue
        await asyncio.sleep(interval_h * 3600)
        try:
            await _run_gc()
        except Exception:
            pass


@app.on_event("startup")
async def _start_gc():
    global _gc_task
    _gc_task = asyncio.create_task(_gc_loop())



@app.get("/robots.txt")
async def robots_txt():
    return Response("User-agent: *\nDisallow: /\n", media_type="text/plain")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------- WebP 转码（轻量级图片压缩） ----------------

# 进程内缓存：(abs_path, mtime, size) -> webp bytes
_WEBP_CACHE: "Dict[Tuple[str, float, str], bytes]" = {}
_WEBP_CACHE_MAX = 64  # LRU 上限，防止内存爆掉


def _accepts_webp(request: Request) -> bool:
    return "image/webp" in (request.headers.get("accept", "") or "").lower()


def _encode_webp(src_bytes: bytes, *, quality: int = 80, max_side: Optional[int] = None) -> bytes:
    """把任意图片字节编码为 webp。max_side 给定时按最长边等比缩放。"""
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(src_bytes))
    # webp 不支持 P 模式调色板透明；统一转 RGBA / RGB
    if im.mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    elif im.mode not in ("RGB", "RGBA", "L"):
        im = im.convert("RGBA")
    if max_side and max_side > 0:
        w, h = im.size
        m = max(w, h)
        if m > max_side:
            scale = max_side / m
            im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()


def _serve_image_maybe_webp(
    request: Request,
    path: Path,
    *,
    quality: int = 80,
    max_side: Optional[int] = None,
) -> Response:
    """根据 Accept 头决定原图直传还是 webp 转码。"""
    media = {"jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(
        path.suffix.lower().lstrip("."), f"image/{path.suffix.lower().lstrip('.')}"
    )
    # 已是 webp / gif / 不接受 webp，直传
    ext = path.suffix.lower()
    if ext in (".webp", ".gif") or not _accepts_webp(request):
        return FileResponse(str(path), media_type=media)
    try:
        st = path.stat()
        key = (str(path), st.st_mtime, f"{quality}@{max_side or 0}")
        cached = _WEBP_CACHE.get(key)
        if cached is None:
            with open(path, "rb") as f:
                src = f.read()
            cached = _encode_webp(src, quality=quality, max_side=max_side)
            if len(_WEBP_CACHE) >= _WEBP_CACHE_MAX:
                # 朴素 LRU：丢掉最早一个
                try:
                    _WEBP_CACHE.pop(next(iter(_WEBP_CACHE)))
                except StopIteration:
                    pass
            _WEBP_CACHE[key] = cached
        headers = {"Content-Length": str(len(cached)), "Vary": "Accept", "Cache-Control": "public, max-age=300"}
        return Response(content=cached, media_type="image/webp", headers=headers)
    except Exception:
        return FileResponse(str(path), media_type=media)


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
    from urllib.parse import quote
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{COMFYUI_API}/api/userdata/workflows%2F{quote(path, safe='')}",
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

    # 透传：如果传入的就是 API 格式（顶层每个值都带 class_type），直接当 prompt 用
    if workflow and "nodes" not in workflow and all(
        isinstance(v, dict) and "class_type" in v for v in workflow.values()
    ):
        prompt = {str(k): v for k, v in workflow.items()}
        # 尝试找 positive 引用：KSampler.inputs.positive → CLIPTextEncode
        for nid, ndata in prompt.items():
            if ndata.get("class_type") in ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"):
                pos = (ndata.get("inputs") or {}).get("positive")
                if isinstance(pos, list) and pos:
                    src_id = str(pos[0])
                    src = prompt.get(src_id, {})
                    if src.get("class_type") in ("CLIPTextEncode", "CLIPTextEncodeSDXL"):
                        positive_ref = (src_id, "text")
                        break
        return prompt, positive_ref

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
    import re as _re
    if original_prompt:
        system = (
            "You are a Chinese-to-English dictionary for Danbooru image tags.\n"
            "The user provides original tags and a new description.\n"
            "Translate the new description into standard English Danbooru tags, "
            "then merge them into the original tags.\n"
            "Keep all original tags that are not asked to change.\n"
            "Output ONLY the final comma-separated tags. No explanation. No Chinese in output."
        )
        user = f"Original prompt:\n{original_prompt}\n\nNew description:\n{prompt}\n\nGenerate the final prompt:"
    else:
        system = (
            "You are a Chinese-to-English dictionary for Danbooru image tags.\n"
            "For each Chinese word or phrase in the input, output the matching English Danbooru tag.\n"
            "Output all tags on one line separated by commas. No other text.\n\n"
            "Tag vocabulary reference (use these exact tags when applicable):\n"
            "- Body: breasts, large_breasts, huge_breasts, nipples, penis, vagina, ass, feet, soles, toes\n"
            "- Positions: doggystyle, missionary, cowgirl, from_behind, reverse_cowgirl\n"
            "- Actions: sex, vaginal, anal, oral, footjob, handjob, kissing, groping, masturbation, squirting, ejaculation\n"
            "- States: nude, topless, bottomless, cum, wet, spread_legs, barefoot, penetration\n"
            "- Subjects: 1girl, 1boy, 2girls, multiple_girls, hetero, yuri\n\n"
            "Output: tags only, one line, no other text."
        )
        user = prompt

    cfg = _llm_config
    provider = cfg.get("provider", "local")
    use_stream = cfg.get("llm_stream", True)

    if provider == "google":
        result = await _llm_google(system, user, cfg, on_chunk, use_stream)
    elif provider == "custom":
        result = await _llm_openai_compat(system, user, cfg.get("custom_endpoint", ""),
                                          cfg.get("custom_api_key", ""), cfg.get("custom_model", ""),
                                          on_chunk, use_stream)
    else:
        result = await _llm_openai_compat(system, user, cfg.get("local_endpoint") or LMS_API,
                                          "", "", on_chunk, use_stream)

    return result


async def _llm_google(system: str, user: str, cfg: Dict[str, Any], on_chunk: Optional[Any],
                      use_stream: bool = True) -> str:
    """Google AI Studio API，支持流式与非流式。"""
    api_key = cfg.get("google_api_key") or ""
    model = cfg.get("google_model") or "gemma-4-31b-it"
    if not api_key:
        raise RuntimeError("Google API Key 未配置")

    body = {
        "contents": [{"role": "user", "parts": [{"text": f"{system}\n\n{user}"}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1024},
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ],
    }
    thinking = cfg.get("google_thinking", "off")
    if thinking.startswith("level_"):
        body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": thinking[6:]}
    elif thinking == "budget_auto":
        body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": -1}
    elif thinking.startswith("budget_"):
        try:
            body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": int(thinking[7:])}
        except ValueError:
            pass

    chunks: List[str] = []
    thought_chunks: List[str] = []
    async with httpx.AsyncClient(timeout=120) as client:
        if use_stream:
            url = f"{_GOOGLE_API_BASE}/models/{model}:streamGenerateContent?alt=sse&key={api_key}"
            async with client.stream("POST", url, json=body) as r:
                if r.status_code >= 400:
                    text = await r.aread()
                    raise RuntimeError(f"LLM 返回 HTTP {r.status_code}: {text.decode()[:500]}")
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
                    candidates = obj.get("candidates") or []
                    if not candidates:
                        continue
                    parts = (candidates[0].get("content") or {}).get("parts") or []
                    for p in parts:
                        piece = p.get("text") or ""
                        if not piece:
                            continue
                        is_thought = p.get("thought", False)
                        if on_chunk is not None:
                            try:
                                await on_chunk(piece)
                            except Exception:
                                pass
                        if is_thought:
                            thought_chunks.append(piece)
                        else:
                            chunks.append(piece)
        else:
            url = f"{_GOOGLE_API_BASE}/models/{model}:generateContent?key={api_key}"
            r = await client.post(url, json=body)
            if r.status_code >= 400:
                raise RuntimeError(f"LLM 返回 HTTP {r.status_code}: {r.text[:500]}")
            resp = r.json()
            for cand in resp.get("candidates") or []:
                for p in (cand.get("content") or {}).get("parts") or []:
                    piece = p.get("text") or ""
                    if not piece:
                        continue
                    if p.get("thought", False):
                        thought_chunks.append(piece)
                    else:
                        chunks.append(piece)
    full = "".join(chunks).strip()
    if thought_chunks:
        import re as _re
        thought_text = "".join(thought_chunks)
        candidates = []
        for line in thought_text.splitlines():
            cleaned = line.strip().strip("`").strip()
            if "," in cleaned and len(cleaned) > 20:
                tag_part = cleaned.split(":")[-1].strip() if cleaned.count(":") == 1 and cleaned.index(":") < 20 else cleaned
                if tag_part.startswith("`"):
                    tag_part = tag_part.strip("`").strip()
                candidates.append(tag_part)
        backtick_blocks = _re.findall(r"`([^`]{20,})`", thought_text)
        for block in backtick_blocks:
            if "," in block:
                candidates.append(block.strip())
        if candidates:
            thought_candidate = max(candidates, key=lambda c: c.count(","))
            if not full or thought_candidate.count(",") > full.count(","):
                full = thought_candidate
    if not full:
        raise RuntimeError("Google LLM 返回空内容")
    return full


async def _llm_openai_compat(system: str, user: str, endpoint: str,
                             api_key: str, model: str, on_chunk: Optional[Any],
                             use_stream: bool = True) -> str:
    """OpenAI 兼容格式（LM Studio / 自定义 API），支持流式与非流式。"""
    endpoint = endpoint.rstrip("/")
    if not endpoint:
        raise RuntimeError("LLM 端点未配置")
    headers: Dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body: Dict[str, Any] = {
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.7,
        "max_tokens": 1024,
        "stream": use_stream,
    }
    if model:
        body["model"] = model

    chunks: List[str] = []
    async with httpx.AsyncClient(timeout=120, headers=headers) as client:
        if use_stream:
            async with client.stream("POST", f"{endpoint}/v1/chat/completions", json=body) as r:
                if r.status_code >= 400:
                    text = await r.aread()
                    raise RuntimeError(f"LLM 返回 HTTP {r.status_code}: {text.decode()[:500]}")
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
                    delta = ((obj.get("choices") or [{}])[0].get("delta") or {})
                    piece = delta.get("content") or ""
                    if piece:
                        chunks.append(piece)
                        if on_chunk is not None:
                            try:
                                await on_chunk(piece)
                            except Exception:
                                pass
        else:
            r = await client.post(f"{endpoint}/v1/chat/completions", json=body)
            if r.status_code >= 400:
                raise RuntimeError(f"LLM 返回 HTTP {r.status_code}: {r.text[:500]}")
            resp = r.json()
            content = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            if content:
                chunks.append(content)
    full = "".join(chunks).strip()
    if not full:
        raise RuntimeError("LLM 返回空内容")
    return full


# ---------------- routes ----------------

@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def find_thumbnail(wf_path: str) -> Optional[Path]:
    """按工作流路径在 web/thumbnails/ 下查找同名图片。

    优先从 workflow_meta.json 配置读取，找不到则回退到文件名约定匹配。
    """
    if not wf_path:
        return None
    # 1. 从 workflow_meta.json 查找
    meta = _workflow_meta.get(wf_path, {})
    fname = meta.get("thumbnail", "")
    if fname:
        p = (THUMB_DIR / fname).resolve()
        try:
            if p.is_file() and p.is_relative_to(THUMB_DIR.resolve()):
                return p
        except Exception:
            pass
    # 2. 回退：文件名约定匹配
    stem = wf_path[:-5] if wf_path.lower().endswith(".json") else wf_path
    base = Path(stem)
    candidates = []
    for ext in THUMB_EXTS:
        candidates.append(THUMB_DIR / (str(base) + ext))
        candidates.append(THUMB_DIR / (base.name + ext))
    for c in candidates:
        try:
            cr = c.resolve()
            if cr.is_file() and cr.is_relative_to(THUMB_DIR.resolve()):
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
async def api_thumbnail(request: Request, path: str):
    p = find_thumbnail(path)
    if not p:
        raise HTTPException(404, "no thumbnail")
    # 缩略图固定限制最长边 256，质量更低
    return _serve_image_maybe_webp(request, p, quality=72, max_side=256)


@app.get("/api/styles")
async def api_styles_public():
    return {"styles": list(_styles)}


@app.get("/api/style_thumbnail")
async def api_style_thumbnail(request: Request, name: str):
    if not name or ".." in name or "/" in name or "\\" in name:
        raise HTTPException(400, "invalid name")
    for ext in THUMB_EXTS:
        candidate = STYLE_THUMB_DIR / (name + ext)
        try:
            cr = candidate.resolve()
            if cr.is_file() and cr.is_relative_to(STYLE_THUMB_DIR.resolve()):
                return _serve_image_maybe_webp(request, cr, quality=72, max_side=256)
        except Exception:
            continue
    p = STYLE_THUMB_DIR / name
    try:
        cr = p.resolve()
        if cr.is_file() and cr.is_relative_to(STYLE_THUMB_DIR.resolve()):
            return _serve_image_maybe_webp(request, cr, quality=72, max_side=256)
    except Exception:
        pass
    raise HTTPException(404, "no style thumbnail")


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


@app.get("/api/output/featured")
async def api_output_featured():
    """游客可见的精选图片列表，按管理员保存的顺序返回。失效项（文件已删）会过滤掉。"""
    items: List[Dict[str, Any]] = []
    for rel in _read_featured():
        try:
            p = _resolve_output_path(rel)
        except Exception:
            continue
        if not p.is_file():
            continue
        try:
            mt = p.stat().st_mtime
        except Exception:
            mt = None
        items.append({"path": rel, "mtime": mt})
    return {"items": items, "total": len(items)}


@app.get("/api/output/file")
async def api_output_file(request: Request, path: str, full: int = 0):
    p = _resolve_output_path(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    if p.suffix.lower() not in OUTPUT_IMAGE_EXTS:
        raise HTTPException(400, "not an image")
    # 默认走 webp 转码（限制最长边 1600 节省带宽）；?full=1 返回原图
    if full:
        ext = p.suffix.lower().lstrip(".")
        media = {"jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(ext, f"image/{ext}")
        return FileResponse(str(p), media_type=media)
    return _serve_image_maybe_webp(request, p, quality=82, max_side=1600)


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


@app.get("/api/output/creator")
async def api_output_creator(path: str):
    """读取该图片的生图者 IP（来自 creator_ips.txt 映射）。"""
    p = _resolve_output_path(path)
    if not p.is_file():
        raise HTTPException(404, "not found")
    return {"creator_ip": _creator_map_get(_creator_key(p))}


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


def _read_png_text_chunk(path: Path, key: str) -> str:
    """直接扫描 PNG 的 tEXt / zTXt / iTXt chunk，返回指定 key 的文本。
    不受 Pillow MAX_TEXT_CHUNK 限制；适合读 ComfyUI 写入的大 workflow。
    """
    import struct
    import zlib
    target = key.encode("latin-1")
    try:
        with open(path, "rb") as f:
            sig = f.read(8)
            if sig != b"\x89PNG\r\n\x1a\n":
                return ""
            while True:
                head = f.read(8)
                if len(head) < 8:
                    return ""
                length, ctype = struct.unpack(">I4s", head)
                data = f.read(length)
                f.read(4)  # crc
                if ctype == b"IEND":
                    return ""
                if ctype == b"tEXt":
                    k, _, v = data.partition(b"\x00")
                    if k == target:
                        return v.decode("utf-8", errors="replace")
                elif ctype == b"zTXt":
                    k, _, rest = data.partition(b"\x00")
                    if k == target and rest:
                        # rest[0] = compression method (0=deflate)
                        try:
                            return zlib.decompress(rest[1:]).decode("utf-8", errors="replace")
                        except Exception:
                            return ""
                elif ctype == b"iTXt":
                    k, _, rest = data.partition(b"\x00")
                    if k != target or len(rest) < 2:
                        continue
                    comp_flag = rest[0]
                    # comp_method = rest[1]; 跳过 language tag 和 translated keyword
                    rest2 = rest[2:]
                    _, _, rest3 = rest2.partition(b"\x00")  # language
                    _, _, text_bytes = rest3.partition(b"\x00")  # translated kw
                    if comp_flag:
                        try:
                            text_bytes = zlib.decompress(text_bytes)
                        except Exception:
                            return ""
                    return text_bytes.decode("utf-8", errors="replace")
    except Exception:
        return ""
    return ""


@app.post("/api/output/fork")
async def api_output_fork(payload: Dict[str, Any]):
    """从输出 PNG 提取 workflow / prompt 元信息，原样返回给前端用于"临时还原"。
    不持久化、不写盘。前端拿到后存在内存里，下次提交时通过 /ws/run 的 inline_workflow 字段送回。

    入参：{"path": "<相对 OUTPUT_DIR 的图片路径>"}
    出参：{"workflow": <dict>, "summary": {...}, "default_width": int|None, "default_height": int|None,
          "builtin_prompt": str, "loras": [str], "format": "api"|"editor"}
    """
    rel = (payload or {}).get("path", "")
    if not rel:
        raise HTTPException(400, "path required")
    p = _resolve_output_path(rel)
    if not p.is_file():
        raise HTTPException(404, "not found")
    if p.suffix.lower() != ".png":
        raise HTTPException(400, "仅支持从 PNG 中提取工作流")
    try:
        from PIL import Image
        from PIL import PngImagePlugin
        PngImagePlugin.MAX_TEXT_CHUNK = 100 * 1024 * 1024
        PngImagePlugin.MAX_TEXT_MEMORY = 100 * 1024 * 1024
        im = Image.open(p)
        info = im.info or {}
    except Exception as e:
        raise HTTPException(500, f"读取图片失败: {e}")

    raw_wf = info.get("workflow")
    if not isinstance(raw_wf, str) or not raw_wf.strip():
        raw_wf = _read_png_text_chunk(p, "workflow")
    fmt = "editor"
    if not isinstance(raw_wf, str) or not raw_wf.strip():
        raw_wf = info.get("prompt") if isinstance(info.get("prompt"), str) else None
        fmt = "api"
    if not isinstance(raw_wf, str) or not raw_wf.strip():
        raw_wf = _read_png_text_chunk(p, "prompt")
        fmt = "api"
    if not isinstance(raw_wf, str) or not raw_wf.strip():
        keys = list(info.keys())
        raise HTTPException(400, f"图片中没有 workflow / prompt 元信息（可读字段: {keys}）")
    try:
        wf_json = json.loads(raw_wf)
    except Exception as e:
        raise HTTPException(400, f"workflow 元信息解析失败: {e}")

    pd, positive_ref = workflow_to_prompt_api(wf_json)
    res = detect_default_resolution(pd)
    builtin_prompt = ""
    if positive_ref:
        nid, inp = positive_ref
        v = pd.get(nid, {}).get("inputs", {}).get(inp, "")
        if isinstance(v, str):
            builtin_prompt = v.strip()
    summary = summarize_workflow(wf_json) if "nodes" in wf_json and isinstance(wf_json.get("nodes"), list) else {
        "node_count": len(pd), "link_count": 0, "group_count": 0, "types": {},
    }
    return {
        "workflow": wf_json,
        "format": fmt,
        "summary": summary,
        "default_width": res[0] if res else None,
        "default_height": res[1] if res else None,
        "builtin_prompt": builtin_prompt,
        "loras": extract_loras(pd),
        "source_image": rel,
    }


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
        "loras": extract_loras(pd),
        "lora_link": find_lora_link(path),
    }


def find_lora_link(wf_path: str) -> Optional[str]:
    """查找与工作流关联的 Lora 链接。

    优先从 workflow_meta.json 配置读取，找不到则回退到 lora_links/*.txt 文件。
    """
    if not wf_path:
        return None
    # 1. 从 workflow_meta.json 查找
    meta = _workflow_meta.get(wf_path, {})
    url = meta.get("lora_link", "").strip()
    if url:
        return url
    # 2. 回退：lora_links/*.txt 文件
    stem = wf_path[:-5] if wf_path.lower().endswith(".json") else wf_path
    base = Path(stem)
    candidates = [
        LORA_LINKS_DIR / (str(base) + ".txt"),
        LORA_LINKS_DIR / (base.name + ".txt"),
    ]
    root = LORA_LINKS_DIR.resolve()
    for c in candidates:
        try:
            cr = c.resolve()
            if cr.is_file() and cr.is_relative_to(root):
                line = cr.read_text(encoding="utf-8").strip().splitlines()
                url = line[0].strip() if line else ""
                if url:
                    return url
        except Exception:
            continue
    return None


def extract_loras(prompt_dict: Dict[str, Any]) -> List[str]:
    """从 prompt API 格式中提取所有 Lora 文件名（去重，保持顺序）。
    覆盖 LoraLoader / LoraLoaderModelOnly / rgthree Power Lora Loader 等。
    """
    seen: Dict[str, None] = {}
    for nid, ndata in prompt_dict.items():
        if not isinstance(ndata, dict):
            continue
        cls = (ndata.get("class_type") or "")
        if "lora" not in cls.lower():
            continue
        inputs = ndata.get("inputs") or {}
        for k, v in inputs.items():
            if not isinstance(v, str):
                # rgthree Power Lora Loader: inputs 形如 {"lora_1": {"on": true, "lora": "xxx.safetensors", ...}}
                if isinstance(v, dict):
                    name = v.get("lora")
                    on = v.get("on", True)
                    if isinstance(name, str) and name and name.lower() != "none" and on:
                        seen.setdefault(name, None)
                continue
            kl = k.lower()
            if "lora" in kl and "name" in kl or kl == "lora_name" or kl == "lora":
                if v and v.lower() != "none":
                    seen.setdefault(v, None)
    return list(seen.keys())


@app.get("/api/image")
async def api_image(request: Request, filename: str, subfolder: str = "", type: str = "output"):
    try:
        content, ct = await download_image(filename, subfolder, type)
    except Exception as e:
        raise HTTPException(500, str(e))
    # 浏览器接受 webp 时即时转码（节省 60-80% 带宽）
    if _accepts_webp(request) and ct.startswith("image/") and ct not in ("image/webp", "image/gif"):
        try:
            webp = _encode_webp(content, quality=82, max_side=1600)
            return Response(content=webp, media_type="image/webp", headers={"Vary": "Accept"})
        except Exception:
            pass
    return Response(content=content, media_type=ct)


# GPU 状态轻量缓存：500ms 内同一进程复用一次结果，避免被前端 1Hz 轮询打爆
_gpu_cache: Dict[str, Any] = {"ts": 0.0, "data": None}


@app.get("/api/gpu")
async def api_gpu():
    """通过 nvidia-smi 读取所有 GPU 关键指标。无 nvidia-smi 时 available=False。
    用同步 subprocess 走线程池，避开 Windows ProactorEventLoop 子进程偶发卡死。"""
    import time as _time
    import subprocess
    now = _time.time()
    poll_ms = _limits.get("gpu_poll_interval_ms", 5000)
    if _gpu_cache["data"] is not None and now - _gpu_cache["ts"] < _limits.get("gpu_cache_ttl_ms", 5000) / 1000:
        return {**_gpu_cache["data"], "poll_interval_ms": poll_ms}
    fields = [
        "index", "name",
        "utilization.gpu", "utilization.memory",
        "memory.used", "memory.total",
        "temperature.gpu",
        "power.draw", "power.limit",
        "clocks.current.graphics", "clocks.current.memory",
        "fan.speed",
    ]
    cmd = [
        "nvidia-smi",
        f"--query-gpu={','.join(fields)}",
        "--format=csv,noheader,nounits",
    ]
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags = subprocess.CREATE_NO_WINDOW

    def _run() -> Dict[str, Any]:
        try:
            r = subprocess.run(
                cmd, capture_output=True, timeout=8.0, creationflags=flags,
            )
        except FileNotFoundError:
            return {"available": False, "error": "nvidia-smi 未安装", "gpus": []}
        except subprocess.TimeoutExpired:
            return {"available": False, "error": "nvidia-smi 超时", "gpus": []}
        except Exception as e:  # noqa: BLE001
            return {"available": False, "error": f"{type(e).__name__}: {e}", "gpus": []}
        if r.returncode != 0:
            return {
                "available": False,
                "error": (r.stderr or b"").decode("utf-8", "replace").strip() or f"rc={r.returncode}",
                "gpus": [],
            }
        return {"_out": (r.stdout or b"").decode("utf-8", "replace")}

    res = await asyncio.to_thread(_run)
    if "_out" not in res:
        _gpu_cache["ts"] = now
        _gpu_cache["data"] = res
        return {**res, "poll_interval_ms": poll_ms}

    def _num(s: str) -> Any:
        s = s.strip()
        if s in ("[N/A]", "[Not Supported]", "N/A", ""):
            return None
        try:
            return float(s) if "." in s else int(s)
        except ValueError:
            return s

    gpus: List[Dict[str, Any]] = []
    for line in res["_out"].strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(fields):
            continue
        rec: Dict[str, Any] = {}
        for k, v in zip(fields, parts):
            rec[k] = v if k == "name" else _num(v)
        try:
            rec["index"] = int(rec["index"])
        except Exception:
            pass
        gpus.append(rec)

    data = {"available": True, "gpus": gpus}
    _gpu_cache["ts"] = now
    _gpu_cache["data"] = data
    return {**data, "poll_interval_ms": poll_ms}


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


@app.post("/api/admin/force-restart")
async def api_admin_force_restart():
    """强制杀死后端进程，uvicorn --reload 会自动拉起。"""
    import os as _os
    try:
        await interrupt_prompt()
    except Exception:
        pass
    _os._exit(0)


class RunRequest(BaseModel):
    workflow_path: str = ""
    inline_workflow: Optional[Dict[str, Any]] = None  # 临时 fork：直接传整份工作流（不持久化）
    direct_prompt: str = ""
    nl_prompt: str = ""
    rewrite: bool = False
    override: bool = False
    width: Optional[int] = None
    height: Optional[int] = None
    style_tags: str = ""


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
        # 真实 IP：优先 Cloudflare 头 → X-Forwarded-For → socket
        h = ws.headers
        client_ip = (
            h.get("cf-connecting-ip")
            or (h.get("x-forwarded-for", "").split(",")[0].strip() if h.get("x-forwarded-for") else "")
            or (ws.client.host if ws.client else "")
            or "unknown"
        )
        if is_ip_banned(client_ip):
            try:
                await ws.send_json({"type": "error", "message": "你已被管理员禁止生图"})
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
            return
        # 单 IP 生图冷却（来自 limits.json，可在管理面板改）
        import time as _time
        now = _time.time()
        last = _RATE_LAST_TS.get(client_ip, 0.0)
        cooldown = float(_limits.get("gen_cooldown_sec", 30))
        wait = cooldown - (now - last)
        if wait > 0:
            try:
                await ws.send_json({
                    "type": "error",
                    "message": f"生图间隔限制：请 {int(wait) + 1}s 后再试",
                })
            except Exception:
                pass
            try:
                await ws.close()
            except Exception:
                pass
            return
        try:
            await _run_task(ws, RunRequest(**init), client_ip=client_ip)
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as e:
            try:
                await emit(ws, {"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            await _push_status(reset=True)


async def _run_task(ws: WebSocket, req: RunRequest, *, client_ip: str = "unknown"):
    import time as _time
    path = req.workflow_path
    inline = req.inline_workflow
    if not path and not inline:
        await emit(ws, {"type": "error", "message": "未指定工作流（前端未传 workflow_path 或 inline_workflow）"})
        return

    display_path = path or "(临时 fork)"
    await _push_status({
        "busy": True,
        "stage": "loading",
        "workflow": display_path,
        "started_at": _time.time(),
    })

    if inline:
        await emit(ws, {"type": "log", "message": "[1/4] 使用临时 fork 工作流（内存内，不持久化）"})
        data = inline
    else:
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

    style_tags = req.style_tags.strip()
    if style_tags:
        await emit(ws, {"type": "log", "message": f"画风词条：{style_tags}"})

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

    if style_tags:
        sd_prompt = sep.join([style_tags, sd_prompt]) if sd_prompt else style_tags

    if not sd_prompt.strip():
        await emit(ws, {"type": "error", "message": "最终 prompt 为空"})
        return

    prompt_dict[node_id]["inputs"][input_name] = sd_prompt

    if req.width and req.height and req.width > 0 and req.height > 0:
        MAX_DIM = 1344
        if req.width > MAX_DIM or req.height > MAX_DIM:
            await emit(ws, {"type": "error", "message": f"分辨率不得大于 {MAX_DIM}（请求: {req.width}x{req.height}）"})
            return
        n = apply_resolution(prompt_dict, int(req.width), int(req.height))
        if n:
            await emit(ws, {"type": "log", "message": f"分辨率覆盖为 {req.width}x{req.height} ({n} 个节点)"})

    for nid, ndata in prompt_dict.items():
        if ndata.get("class_type") == "KSampler":
            inp = ndata.get("inputs", {})
            if "seed" in inp:
                inp["seed"] = random.randint(0, 2**63 - 1)

    _RATE_LAST_TS[client_ip] = _time.time()

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

    # 写入 IP 映射：拿到文件名后立刻把 <相对路径> -> <client_ip> 写进 creator_ips.txt
    for img in images:
        if img.get("type") != "output":
            continue
        try:
            sub = img.get("subfolder") or ""
            rel = (sub + "/" + img["filename"]) if sub else img["filename"]
            rel = rel.replace("\\", "/")
            await _creator_map_set(rel, client_ip)
        except Exception as e:
            await emit(ws, {"type": "log", "message": f"[warn] 写 creator_ips.txt 失败: {e}"})

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


async def _wait_for(prompt_id: str, ws: WebSocket, prompt_dict: Dict[str, Any],
                    timeout: int = 600) -> Dict[str, Any]:
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


# ---------------- 举报 ----------------

@app.post("/api/report")
async def api_report(payload: Dict[str, Any], request: Request):
    import time as _time
    reporter_ip = _client_ip_from_request(request)
    if is_ip_banned(reporter_ip):
        raise HTTPException(403, "你已被封禁")
    image_path = str((payload or {}).get("image_path", "")).strip()
    reason = str((payload or {}).get("reason", "")).strip()[:500]
    if not image_path:
        raise HTTPException(400, "image_path required")
    if not reason:
        raise HTTPException(400, "请填写举报原因")
    try:
        p = _resolve_output_path(image_path)
    except HTTPException:
        raise HTTPException(404, "图片不存在")
    if not p.is_file():
        raise HTTPException(404, "图片不存在")
    now = _time.time()
    ts_list = _REPORT_RATE.get(reporter_ip, [])
    window = float(_limits.get("report_window_sec", 300))
    ts_list = [t for t in ts_list if now - t < window]
    max_in_window = int(_limits.get("report_window_max", 3))
    if len(ts_list) >= max_in_window:
        raise HTTPException(429, f"举报过于频繁，请 {int(window // 60)} 分钟后再试")
    reports = _load_reports()
    pending_count = 0
    pending_max = int(_limits.get("report_pending_max", 10))
    for r in reports:
        if r.get("reporter_ip") == reporter_ip and r.get("status") == "pending":
            pending_count += 1
            if r.get("image_path") == image_path:
                raise HTTPException(409, "您已举报过此图片")
    if pending_count >= pending_max:
        raise HTTPException(429, "您的待处理举报数已达上限，请等待管理员处理")
    new_report = {
        "id": uuid.uuid4().hex,
        "image_path": image_path,
        "reporter_ip": reporter_ip,
        "reason": reason,
        "timestamp": now,
        "status": "pending",
        "resolved_action": None,
    }
    reports.append(new_report)
    if not await _save_reports(reports):
        raise HTTPException(500, "保存举报失败")
    ts_list.append(now)
    _REPORT_RATE[reporter_ip] = ts_list
    return {"ok": True}


# ---------------- 管理员 API ----------------

@app.get("/admin")
async def admin_page():
    return FileResponse(str(STATIC_DIR / "admin.html"))


@app.get("/api/admin/whoami")
async def api_admin_whoami():
    return {"user": "admin"}


@app.get("/api/admin/bans")
async def api_admin_bans():
    return {"banned": list(reversed(_read_banned_ips()))}


@app.post("/api/admin/ban")
async def api_admin_ban(payload: Dict[str, Any]):
    ip = (payload or {}).get("ip", "").strip()
    if not ip:
        raise HTTPException(400, "ip required")
    ips = _read_banned_ips()
    if ip not in ips:
        ips.append(ip)
    if not await _write_banned_ips(ips):
        raise HTTPException(500, "写入 banned_ips.txt 失败")
    return {"ok": True, "banned": list(reversed(ips))}


@app.post("/api/admin/unban")
async def api_admin_unban(payload: Dict[str, Any]):
    ip = (payload or {}).get("ip", "").strip()
    if not ip:
        raise HTTPException(400, "ip required")
    ips = [x for x in _read_banned_ips() if x != ip]
    if not await _write_banned_ips(ips):
        raise HTTPException(500, "写入 banned_ips.txt 失败")
    return {"ok": True, "banned": list(reversed(ips))}


@app.get("/api/admin/recent")
async def api_admin_recent(limit: int = 200, offset: int = 0):
    """列出 OUTPUT_DIR 下所有图片，按 mtime 倒序分页；IP 来自 creator_ips.txt（无则空串）。"""
    if not OUTPUT_DIR.exists():
        return {"items": [], "total": 0, "limit": limit, "offset": offset}
    # 一次性载入映射到字典，避免每张图都扫整文件
    ip_map: Dict[str, str] = {}
    if CREATOR_MAP_FILE.is_file():
        try:
            for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                if not ln or "\t" not in ln:
                    continue
                k, _, v = ln.partition("\t")
                ip_map[k] = v
        except Exception:
            pass
    base = OUTPUT_DIR.resolve()
    raw: List[Tuple[float, str, float]] = []  # (mtime, rel, mtime_for_sort)
    try:
        for p in OUTPUT_DIR.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in THUMB_EXTS:
                continue
            try:
                rel = str(p.resolve().relative_to(base)).replace("\\", "/")
                mt = p.stat().st_mtime
            except Exception:
                continue
            raw.append((mt, rel, mt))
    except Exception:
        pass
    raw.sort(key=lambda x: x[0], reverse=True)
    total = len(raw)
    if offset < 0:
        offset = 0
    if limit <= 0:
        limit = 200
    page = raw[offset:offset + limit]
    items = [
        {"path": rel, "ip": ip_map.get(rel, ""), "mtime": mt}
        for mt, rel, _ in page
    ]
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.post("/api/admin/delete")
async def api_admin_delete(payload: Dict[str, Any]):
    """删除 OUTPUT_DIR 下的一张图，并从 creator_ips.txt 移除对应映射。"""
    rel = (payload or {}).get("path", "").strip()
    if not rel:
        raise HTTPException(400, "path required")
    p = _resolve_output_path(rel)
    if not p.is_file():
        raise HTTPException(404, "not found")
    try:
        p.unlink()
    except Exception as e:
        raise HTTPException(500, f"删除失败: {e}")
    # 同步清理映射
    key = rel.replace("\\", "/")
    async with _creator_map_lock:
        try:
            if CREATOR_MAP_FILE.is_file():
                kept = []
                for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                    if not ln or "\t" not in ln:
                        continue
                    if ln.split("\t", 1)[0] == key:
                        continue
                    kept.append(ln)
                tmp = CREATOR_MAP_FILE.with_suffix(".txt.tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write("\n".join(kept) + ("\n" if kept else ""))
                os.replace(tmp, CREATOR_MAP_FILE)
        except Exception:
            pass
    # 删图时同步从精选清掉
    feats = _read_featured()
    if rel in feats:
        feats = [x for x in feats if x != rel]
        await _write_featured(feats)
    # 自动忽略该图所有待处理举报
    await _auto_dismiss_reports_for_image(rel)
    return {"ok": True}


@app.get("/api/admin/images_by_ip")
async def api_admin_images_by_ip(ip: str = ""):
    """列出某个 IP 生成的所有图片。"""
    ip = ip.strip()
    if not ip:
        raise HTTPException(400, "ip required")
    ip_map: Dict[str, str] = {}
    if CREATOR_MAP_FILE.is_file():
        try:
            for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                if not ln or "\t" not in ln:
                    continue
                k, _, v = ln.partition("\t")
                ip_map[k] = v
        except Exception:
            pass
    base = OUTPUT_DIR.resolve()
    results: list = []
    for rel, rel_ip in ip_map.items():
        if rel_ip != ip:
            continue
        p = base / rel.replace("/", os.sep)
        if not p.is_file():
            continue
        try:
            mt = p.stat().st_mtime
        except Exception:
            mt = 0
        results.append({"path": rel, "ip": ip, "mtime": mt})
    results.sort(key=lambda x: x["mtime"], reverse=True)
    return {"items": results, "total": len(results)}


@app.post("/api/admin/delete_batch")
async def api_admin_delete_batch(payload: Dict[str, Any]):
    """批量删除多张图。"""
    paths = (payload or {}).get("paths", [])
    if not paths or not isinstance(paths, list):
        raise HTTPException(400, "paths (list) required")
    deleted = []
    failed = []
    for rel in paths:
        rel = str(rel).strip()
        if not rel:
            continue
        try:
            p = _resolve_output_path(rel)
            if p.is_file():
                p.unlink()
                deleted.append(rel)
            else:
                failed.append(rel)
        except Exception:
            failed.append(rel)
    # 批量清理 creator_ips.txt 映射
    del_set = set(r.replace("\\", "/") for r in deleted)
    if del_set:
        async with _creator_map_lock:
            try:
                if CREATOR_MAP_FILE.is_file():
                    kept = []
                    for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                        if not ln or "\t" not in ln:
                            continue
                        if ln.split("\t", 1)[0] in del_set:
                            continue
                        kept.append(ln)
                    tmp = CREATOR_MAP_FILE.with_suffix(".txt.tmp")
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write("\n".join(kept) + ("\n" if kept else ""))
                    os.replace(tmp, CREATOR_MAP_FILE)
            except Exception:
                pass
        # 同步清理精选
        feats = _read_featured()
        changed = False
        for rel in deleted:
            if rel in feats:
                feats = [x for x in feats if x != rel]
                changed = True
        if changed:
            await _write_featured(feats)
        # 自动忽略已删图片的所有待处理举报
        reports = _load_reports()
        report_changed = False
        for r in reports:
            if r.get("status") == "pending" and r.get("image_path") in del_set:
                r["status"] = "resolved"
                r["resolved_action"] = "dismiss"
                report_changed = True
        if report_changed:
            await _save_reports(reports)
    return {"ok": True, "deleted": len(deleted), "failed": len(failed)}


@app.get("/api/admin/featured")
async def api_admin_featured():
    return {"items": _read_featured()}


@app.post("/api/admin/featured/add")
async def api_admin_featured_add(payload: Dict[str, Any]):
    rel = (payload or {}).get("path", "").strip()
    if not rel:
        raise HTTPException(400, "path required")
    p = _resolve_output_path(rel)
    if not p.is_file():
        raise HTTPException(404, "not found")
    rel = rel.replace("\\", "/")
    feats = _read_featured()
    if rel not in feats:
        feats.insert(0, rel)  # 新加的放最前
        if not await _write_featured(feats):
            raise HTTPException(500, "写入 featured.txt 失败")
    return {"ok": True, "items": feats}


@app.post("/api/admin/featured/remove")
async def api_admin_featured_remove(payload: Dict[str, Any]):
    rel = (payload or {}).get("path", "").strip()
    if not rel:
        raise HTTPException(400, "path required")
    rel = rel.replace("\\", "/")
    feats = [x for x in _read_featured() if x != rel]
    if not await _write_featured(feats):
        raise HTTPException(500, "写入 featured.txt 失败")
    return {"ok": True, "items": feats}


@app.post("/api/admin/featured/reorder")
async def api_admin_featured_reorder(payload: Dict[str, Any]):
    """整体覆写顺序。前端拖拽排序后调一次。"""
    items = (payload or {}).get("items") or []
    if not isinstance(items, list):
        raise HTTPException(400, "items must be list")
    cleaned: List[str] = []
    seen: set = set()
    for it in items:
        if not isinstance(it, str):
            continue
        rel = it.strip().replace("\\", "/")
        if not rel or rel in seen:
            continue
        seen.add(rel)
        cleaned.append(rel)
    if not await _write_featured(cleaned):
        raise HTTPException(500, "写入 featured.txt 失败")
    return {"ok": True, "items": cleaned}


@app.get("/api/admin/limits")
async def api_admin_limits_get():
    return {"limits": dict(_limits), "defaults": dict(DEFAULT_LIMITS)}


@app.post("/api/admin/limits")
async def api_admin_limits_set(payload: Dict[str, Any]):
    """更新限流配置。仅接受白名单字段，非负整数。"""
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be object")
    new_limits = dict(_limits)
    for k in DEFAULT_LIMITS:
        if k not in payload:
            continue
        v = payload[k]
        if not isinstance(v, (int, float)) or v < 0:
            raise HTTPException(400, f"{k} 必须为非负数")
        new_limits[k] = int(v)
    if not await _save_limits(new_limits):
        raise HTTPException(500, "写入 limits.json 失败")
    _limits.clear()
    _limits.update(new_limits)
    return {"ok": True, "limits": dict(_limits)}


@app.post("/api/admin/gc")
async def api_admin_gc_run():
    """手动触发一次 GC。"""
    result = await _run_gc()
    return {"ok": True, "cleaned": result}



# ---------------- 公告端点 ----------------

@app.get("/api/announcement")
async def api_announcement():
    return {"announcement": dict(_announcement)}


@app.get("/api/admin/announcement")
async def api_admin_announcement_get():
    return {"announcement": dict(_announcement)}


@app.post("/api/admin/announcement")
async def api_admin_announcement_set(payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be object")
    new_state = {
        "enabled": bool(payload.get("enabled", _announcement.get("enabled", False))),
        "title": str(payload.get("title", _announcement.get("title", ""))).strip(),
        "content": str(payload.get("content", _announcement.get("content", ""))).strip(),
    }
    if not await _save_announcement(new_state):
        raise HTTPException(500, "写入 announcement.json 失败")
    _announcement.clear()
    _announcement.update(new_state)
    return {"ok": True, "announcement": dict(_announcement)}


# ---------------- 画风端点 ----------------

@app.get("/api/admin/styles")
async def api_admin_styles_get():
    return {"styles": list(_styles)}


@app.post("/api/admin/styles")
async def api_admin_styles_set(payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be object")
    raw = payload.get("styles")
    if not isinstance(raw, list):
        raise HTTPException(400, "styles must be array")
    cleaned = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        tags = str(s.get("tags", "")).strip()
        if not tags:
            continue
        cleaned.append({
            "name": str(s.get("name", "")).strip(),
            "tags": tags,
            "image": str(s.get("image", "")).strip(),
        })
    if not await _save_styles(cleaned):
        raise HTTPException(500, "写入 styles.json 失败")
    _styles.clear()
    _styles.extend(cleaned)
    return {"ok": True, "styles": list(_styles)}


async def _save_upload(file: UploadFile, dest_dir: Path) -> str:
    """流式保存上传文件，边写边校验大小（上限 5 MB）。"""
    if not file.filename:
        raise HTTPException(400, "no filename")
    ext = Path(file.filename).suffix.lower()
    if ext not in THUMB_EXTS:
        raise HTTPException(400, f"不支持的格式，仅限 {', '.join(THUMB_EXTS)}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename).name
    if not safe_name or ".." in safe_name:
        raise HTTPException(400, "invalid filename")
    dest = dest_dir / safe_name
    MAX_SIZE = 5 * 1024 * 1024
    written = 0
    CHUNK = 256 * 1024
    with open(dest, "wb") as f:
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_SIZE:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(400, "文件过大（上限 5 MB）")
            f.write(chunk)
    return safe_name


@app.post("/api/admin/style_thumbnail")
async def api_admin_style_thumbnail_upload(file: UploadFile):
    filename = await _save_upload(file, STYLE_THUMB_DIR)
    return {"ok": True, "filename": filename}


# ---------------- 工作流元数据端点 ----------------

@app.get("/api/admin/workflow_meta")
async def api_admin_workflow_meta_get():
    arr = []
    for wf in sorted(_workflow_meta):
        entry = {"workflow": wf}
        entry.update(_workflow_meta[wf])
        arr.append(entry)
    return {"workflow_meta": arr}


@app.post("/api/admin/workflow_meta")
async def api_admin_workflow_meta_set(payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be object")
    raw = payload.get("workflow_meta")
    if not isinstance(raw, list):
        raise HTTPException(400, "workflow_meta must be array")
    cleaned = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        wf = str(item.get("workflow", "")).strip()
        if not wf:
            continue
        entry = {}
        thumb = str(item.get("thumbnail", "")).strip()
        link = str(item.get("lora_link", "")).strip()
        if thumb:
            entry["thumbnail"] = thumb
        if link:
            parsed = urlparse(link)
            if parsed.scheme and parsed.scheme not in ("http", "https"):
                raise HTTPException(400, f"lora_link 仅支持 http/https 协议")
            entry["lora_link"] = link
        if entry:
            cleaned[wf] = entry
    if not _save_workflow_meta_file(cleaned):
        raise HTTPException(500, "写入 workflow_meta.json 失败")
    _workflow_meta.clear()
    _workflow_meta.update(cleaned)
    arr = []
    for wf in sorted(_workflow_meta):
        entry = {"workflow": wf}
        entry.update(_workflow_meta[wf])
        arr.append(entry)
    return {"ok": True, "workflow_meta": arr}


@app.post("/api/admin/wf_thumbnail")
async def api_admin_wf_thumbnail_upload(file: UploadFile):
    safe_name = await _save_upload(file, THUMB_DIR)
    return {"ok": True, "filename": safe_name}


# ---------------- LLM 配置端点 ----------------

@app.get("/api/admin/llm")
async def api_admin_llm_get():
    safe = dict(_llm_config)
    for key_field in ("google_api_key", "custom_api_key"):
        k = safe.pop(key_field, "")
        safe[f"{key_field}_masked"] = (k[:4] + "****" + k[-4:]) if len(k) > 8 else ("****" if k else "")
    return {"llm": safe}


@app.post("/api/admin/llm")
async def api_admin_llm_set(payload: Dict[str, Any]):
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be object")
    provider = payload.get("provider", _llm_config.get("provider", "local"))
    if provider not in ("local", "google", "custom"):
        raise HTTPException(400, "provider must be 'local', 'google', or 'custom'")
    new_state = {
        "provider": provider,
        "local_endpoint": str(payload.get("local_endpoint", _llm_config.get("local_endpoint", ""))).strip()
            or DEFAULT_LLM_CONFIG["local_endpoint"],
        "google_api_key": str(payload.get("google_api_key", _llm_config.get("google_api_key", ""))).strip(),
        "google_model": str(payload.get("google_model", _llm_config.get("google_model", ""))).strip()
            or DEFAULT_LLM_CONFIG["google_model"],
        "google_thinking": str(payload.get("google_thinking", _llm_config.get("google_thinking", "off"))).strip()
            or "off",
        "custom_endpoint": str(payload.get("custom_endpoint", _llm_config.get("custom_endpoint", ""))).strip(),
        "custom_api_key": str(payload.get("custom_api_key", _llm_config.get("custom_api_key", ""))).strip(),
        "custom_model": str(payload.get("custom_model", _llm_config.get("custom_model", ""))).strip(),
        "llm_stream": payload.get("llm_stream", _llm_config.get("llm_stream", True)) in (True, "true", 1),
    }
    if not await _save_llm_config(new_state):
        raise HTTPException(500, "写入 llm_config.json 失败")
    _llm_config.clear()
    _llm_config.update(new_state)
    return {"ok": True}


@app.post("/api/admin/llm/test")
async def api_admin_llm_test(payload: Dict[str, Any]):
    """测试 LLM 连接是否可用。"""
    cfg = dict(_llm_config)
    if isinstance(payload, dict):
        for k in cfg:
            if k in payload and payload[k] is not None:
                cfg[k] = str(payload[k]).strip()

    provider = cfg.get("provider", "local")
    try:
        if provider == "google":
            api_key = cfg.get("google_api_key") or ""
            model = cfg.get("google_model") or "gemma-4-31b-it"
            if not api_key:
                return {"ok": False, "error": "API Key 未填写"}
            body = {
                "contents": [{"role": "user", "parts": [{"text": "Hi"}]}],
                "generationConfig": {"maxOutputTokens": 10},
            }
            url = f"{_GOOGLE_API_BASE}/models/{model}:generateContent?key={api_key}"
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(url, json=body)
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}"}
                data = r.json()
                parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                reply = "".join(p.get("text", "") for p in parts)
                return {"ok": True, "reply": reply[:100]}
        else:
            endpoint = (cfg.get("custom_endpoint") if provider == "custom"
                        else cfg.get("local_endpoint") or LMS_API).rstrip("/") or ""
            if not endpoint:
                return {"ok": False, "error": "端点未填写"}
            headers: Dict[str, str] = {}
            api_key = cfg.get("custom_api_key", "") if provider == "custom" else ""
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            body_oai: Dict[str, Any] = {"messages": [{"role": "user", "content": "Hi"}],
                                        "max_tokens": 5, "stream": False}
            model = cfg.get("custom_model", "") if provider == "custom" else ""
            if model:
                body_oai["model"] = model
            async with httpx.AsyncClient(timeout=15, headers=headers) as client:
                r = await client.post(f"{endpoint}/v1/chat/completions", json=body_oai)
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}"}
                data = r.json()
                reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
                return {"ok": True, "reply": reply[:100]}
    except httpx.ConnectError:
        return {"ok": False, "error": "连接失败，请检查端点地址"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "请求超时（15s）"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/admin/llm/models")
async def api_admin_llm_models(payload: Dict[str, Any]):
    """探测可用模型列表。"""
    cfg = dict(_llm_config)
    if isinstance(payload, dict):
        for k in cfg:
            if k in payload and payload[k] is not None:
                cfg[k] = str(payload[k]).strip()

    provider = cfg.get("provider", "local")
    try:
        if provider == "google":
            api_key = cfg.get("google_api_key") or ""
            if not api_key:
                return {"ok": False, "error": "API Key 未填写"}
            url = f"{_GOOGLE_API_BASE}/models?key={api_key}"
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(url)
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
                data = r.json()
                models = []
                for m in data.get("models", []):
                    name = m.get("name", "")
                    display = m.get("displayName", name)
                    model_id = name.replace("models/", "") if name.startswith("models/") else name
                    if "generateContent" in str(m.get("supportedGenerationMethods", [])):
                        models.append({"id": model_id, "name": display})
                return {"ok": True, "models": models}
        else:
            endpoint = (cfg.get("custom_endpoint") if provider == "custom"
                        else cfg.get("local_endpoint") or LMS_API).rstrip("/") or ""
            if not endpoint:
                return {"ok": False, "error": "端点未填写"}
            headers: Dict[str, str] = {}
            api_key = cfg.get("custom_api_key", "") if provider == "custom" else ""
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            async with httpx.AsyncClient(timeout=15, headers=headers) as client:
                r = await client.get(f"{endpoint}/v1/models")
                if r.status_code >= 400:
                    return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
                data = r.json()
                models = [{"id": m.get("id", ""), "name": m.get("id", "")} for m in data.get("data", [])]
                return {"ok": True, "models": models}
    except httpx.ConnectError:
        return {"ok": False, "error": "连接失败，请检查端点地址"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "请求超时（15s）"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/api/admin/reports")
async def api_admin_reports():
    reports = _load_reports()
    pending = [r for r in reports if r.get("status") == "pending"]
    pending.sort(key=lambda r: r.get("timestamp", 0), reverse=True)
    for r in pending:
        r["creator_ip"] = _creator_map_get(r.get("image_path", ""))
        try:
            p = _resolve_output_path(r["image_path"])
            r["image_exists"] = p.is_file()
        except Exception:
            r["image_exists"] = False
    return {"reports": pending, "total": len(pending)}


@app.post("/api/admin/report/resolve")
async def api_admin_report_resolve(payload: Dict[str, Any]):
    report_id = str((payload or {}).get("report_id", "")).strip()
    action = str((payload or {}).get("action", "")).strip()
    if not report_id:
        raise HTTPException(400, "report_id required")
    if action not in ("delete", "ban_creator", "ban_reporter", "dismiss"):
        raise HTTPException(400, "action must be one of: delete, ban_creator, ban_reporter, dismiss")
    reports = _load_reports()
    target = None
    for r in reports:
        if r.get("id") == report_id:
            target = r
            break
    if not target:
        raise HTTPException(404, "举报记录不存在")
    if target.get("status") != "pending":
        raise HTTPException(400, "此举报已被处理")
    image_path = target.get("image_path", "")
    if action == "delete":
        try:
            p = _resolve_output_path(image_path)
            if p.is_file():
                p.unlink()
        except Exception:
            pass
        key = image_path.replace("\\", "/")
        async with _creator_map_lock:
            try:
                if CREATOR_MAP_FILE.is_file():
                    kept = []
                    for ln in CREATOR_MAP_FILE.read_text(encoding="utf-8").splitlines():
                        if not ln or "\t" not in ln:
                            continue
                        if ln.split("\t", 1)[0] == key:
                            continue
                        kept.append(ln)
                    tmp = CREATOR_MAP_FILE.with_suffix(".txt.tmp")
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write("\n".join(kept) + ("\n" if kept else ""))
                    os.replace(tmp, CREATOR_MAP_FILE)
            except Exception:
                pass
        feats = _read_featured()
        if image_path in feats:
            feats = [x for x in feats if x != image_path]
            await _write_featured(feats)
        for r in reports:
            if r.get("status") == "pending" and r.get("image_path") == image_path and r.get("id") != report_id:
                r["status"] = "resolved"
                r["resolved_action"] = "dismiss"
    elif action == "ban_creator":
        creator_ip = _creator_map_get(image_path)
        if creator_ip:
            ips = _read_banned_ips()
            if creator_ip not in ips:
                ips.append(creator_ip)
            await _write_banned_ips(ips)
        else:
            raise HTTPException(400, "未找到该图片的绘图者 IP")
    elif action == "ban_reporter":
        reporter_ip = target.get("reporter_ip", "")
        if reporter_ip:
            ips = _read_banned_ips()
            if reporter_ip not in ips:
                ips.append(reporter_ip)
            await _write_banned_ips(ips)
            for r in reports:
                if r.get("status") == "pending" and r.get("reporter_ip") == reporter_ip and r.get("id") != report_id:
                    r["status"] = "resolved"
                    r["resolved_action"] = "dismiss"
    target["status"] = "resolved"
    target["resolved_action"] = action
    if not await _save_reports(reports):
        raise HTTPException(500, "保存举报记录失败")
    return {"ok": True, "action": action}


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="ComfyUI Web 控制台")
    parser.add_argument("--host", default=WEB_HOST,
                        help=f"监听地址，默认 {WEB_HOST}。用 0.0.0.0 监听所有地址")
    parser.add_argument("--port", type=int, default=WEB_PORT, help=f"端口，默认 {WEB_PORT}")
    parser.add_argument("--reload", action="store_true",
                        help="开启代码热重载（py 文件变更自动重启）")
    parser.add_argument("--i-have-configured-auth", action="store_true",
                        help="跳过启动前的鉴权配置确认提示")
    args = parser.parse_args()

    if not args.i_have_configured_auth:
        banner = (
            "\n" + "=" * 70 + "\n"
            "⚠️  安全提示：本服务自身不做任何鉴权！\n"
            "    /admin 与 /api/admin/* 公开可达，可封禁 IP、删图、维护模式…\n"
            "    任何能访问本服务端口的人都能调用这些接口。\n\n"
            "    部署前请务必在反向代理上加访问控制，至少满足其一：\n"
            "      • Cloudflare Access / Zero Trust 策略\n"
            "      • Nginx auth_basic\n"
            "      • IP 白名单（防火墙 / nginx allow/deny）\n"
            "      • Tailscale / WireGuard 等私有网络\n\n"
            "    若仅本机使用 (host=127.0.0.1)，可直接继续。\n"
            "    用 --i-have-configured-auth 跳过本提示。\n"
            + "=" * 70 + "\n"
        )
        print(banner)
        # 只在 host 不是 loopback 时强制确认
        loopback_hosts = {"127.0.0.1", "::1", "localhost"}
        if args.host not in loopback_hosts:
            try:
                ans = input("已在反向代理上配置鉴权？输入 yes 继续，其它退出： ").strip().lower()
            except EOFError:
                ans = ""
            if ans != "yes":
                print("已取消启动。请先配置访问控制，或确认仅监听本机。")
                raise SystemExit(1)

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
