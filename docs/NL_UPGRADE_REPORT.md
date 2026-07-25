# 自然语言生图升级方案：Flux.2 / Z-Image 语义直出改造报告

> 调研日期：2026-07-25 · 数据源：black-forest-labs/flux2 官方 README、Tongyi-MAI/Z-Image 官方 README、本机 ComfyUI 0.22.3 源码
> 目标：把 natureDrawImage 从「LLM 翻译层 + 大工作流库匹配」升级为「模型原生语义理解直出」

---

## 一、结论摘要（先看这个）

你的直觉方向**正确且可行**，而且有两个超预期的利好：

1. **本机 ComfyUI 0.22.3 已原生支持 Flux.2 和 Z-Image**（`comfy/supported_models.py` 里有 `class Flux2` 和 `class ZImage`），不需要装任何自定义节点，丢模型文件进去就能跑。

2. **Flux.2 和 Z-Image 的语义理解是「模型内建」的**，正好对应你想要的「不需要巨大工作流库」：
   - 它们用**大语言模型当文本编码器**（Qwen3-4B / Mistral-Small-24B），天然懂自然语言长句、中文、复杂指令；
   - **图像编辑是模型原生能力**（FLUX.2 全系、Z-Image-Edit 都支持单图/多图参考编辑），不再依赖「换背景专用工作流 JSON」。

3. **RTX 5090 32GB 是甜点区**：Flux.2 Klein 4B（~8GB）随便跑、Z-Image 6B（16G 内）轻松跑、Flux.2 dev 32B 需量化+offload 也能跑。

**推荐路线**：以 **Z-Image-Turbo（快速直出）+ FLUX.2 Klein 4B（开源可微调）** 为新一代主力，逐步替代现有「WAI/Anima/Real 工作流匹配 + LLM 提示词翻译」的繁琐链路。

---

## 二、三个方案对比

| 维度 | 现有方案（WAI/Anima/Real） | **FLUX.2** | **Z-Image** |
|------|---------------------------|------------|-------------|
| 语义理解方式 | LLM 翻译层 → Danbooru tags | 模型内建（Mistral/Qwen3 TE） | 模型内建（Qwen3-4B TE） |
| 自然语言长句 | 弱（要拆成 tags） | **强** | **强（中文更好）** |
| 中文理解 | 靠翻译 | 一般 | **原生双语** |
| 图像编辑 | 外挂 Kontext 工作流 | **原生（单图+多图参考）** | **原生（Z-Image-Edit）** |
| 工作流复杂度 | 高（每类一套 JSON） | **低（单一模型）** | **低（单一模型）** |
| 文字渲染 | 差 | 好 | **中英双语都准** |
| 开源/可微调 | 是 | Klein 4B=Apache2.0 | 是（ModelScope/HF） |

---

## 三、FLUX.2 家族详解（官方 README 核实）

> 数据源：github.com/black-forest-labs/flux2（官方推理仓库，2548★，2026-07 仍在更新）
> ⚠️ 注意：**官方没有「Flux 3」**。社区里叫 Flux 3 的都是第三方 API 封装。官方现最新是 **FLUX.2**。

### 模型矩阵（全部支持：文生图 ✅ 单图编辑 ✅ 多图参考编辑 ✅）

| 模型 | 参数 | 蒸馏 | 显存 | 许可 | 定位 |
|------|------|------|------|------|------|
| **FLUX.2 [klein] 4B** | 4B | 步数+引导双蒸馏 | **~8GB** | **Apache 2.0** | 实时/消费级首选 |
| FLUX.2 [klein] 9B | 9B | 双蒸馏 | ~16GB | 非商用 | 高质量文生图 |
| FLUX.2 [klein] 9B KV | 9B | 双蒸馏+KV缓存 | ~16GB | 非商用 | 多图编辑最快 |
| FLUX.2 [klein] 4B/9B Base | 4B/9B | 无 | 8/16GB | 4B=Apache | 微调/LoRA 训练底模 |
| **FLUX.2 [dev]** | **32B** | 引导蒸馏 | H100级（量化后 4090 可跑） | 非商用 | 最高画质 |

### 对你的意义
- **klein 4B 是革命性的**：Apache 2.0 全开源、8GB 显存、亚秒级、还自带图像编辑。这意味着你甚至能拿去商用。
- **文本编码器换成大语言模型**：klein 用 Qwen3-4B/8B，dev 用 Mistral-Small-3.2-24B——这就是它「懂自然语言」的原因，不再需要你把句子拆成 Danbooru tags。
- **dev 32B 的「prompt upsampling」**：官方内置用 Mistral-24B 自动扩写提示词，等于把「LLM 翻译层」做进了官方推理脚本。

---

## 四、Z-Image 家族详解（官方 README 核实）

> 数据源：github.com/Tongyi-MAI/Z-Image（官方仓库，11786★，阿里通义）
> 架构：**S3-DiT 单流 DiT**（文本+视觉+VAE token 拼成单序列），6B 参数，文本编码器 = **Qwen3-4B**

### 模型矩阵

| 模型 | 步数 | CFG | 任务 | 状态 | 特点 |
|------|------|-----|------|------|------|
| **Z-Image-Turbo** | **8 步** | 0（不用引导） | 文生图 | ✅已发布(2025-11-26) | 亚秒级、16G显存、写实强、中英文字渲染准 |
| **Z-Image (Base)** | 28-50步 | 3-5 | 文生图 | ✅已发布(2026-01-27) | 高质量、高多样性、支持负提示词、适合微调 |
| Z-Image-Omni-Base | 50 | 支持 | 生成+编辑 | ⏳未发布 | 最「raw」的微调底模 |
| Z-Image-Edit | 50 | 支持 | 图像编辑 | ⏳未发布 | 自然语言改图、双语编辑指令 |

### 亮点（对你最重要）
1. **原生中文理解**：官方示例直接上大段中文 prompt（汉服、大雁塔场景），不用翻译成英文 tags。
2. **中英文字渲染准确**：图里写中文/英文招牌都清晰，这是 GPT-Image/即梦级的标志性能力。
3. **Prompt Enhancer 推理增强**：模型内置推理能力，能超越表面描述调用世界知识。
4. **8 步出图 + 6B 小参数**：5090 上跑 Turbo 是「杀鸡用牛刀」，可以开全精度 + 批量 + 复杂后期。
5. **开源且微调友好**：DiffSynth-Studio 已支持它的 LoRA/全量/蒸馏训练，你可以拿 5090 本地微调专属画风。

---

## 五、关键发现：本机 ComfyUI 已原生支持（零插件）

直接读 `E:\AI\ComfyUI-aki-v1.4\ComfyUI-aki-v1.4\comfy\supported_models.py` 源码确认：

```python
class Flux2(Flux):            # 行 787  —— image_model: "flux2"
    sampling_settings = {"shift": 2.02}
    latent_format = latent_formats.Flux2
    # clip_target 支持 qwen3_4b / qwen3_8b 文本编码器（KleinTokenizer）

class ZImage(Lumina2):        # 行 1122 —— image_model: "lumina2", dim 3840
    sampling_settings = {"multiplier": 1.0, "shift": 3.0}
    # clip_target 用 qwen3_4b（ZImageTokenizer）
```

`comfy/latent_formats.py` 里也有 `class Flux2(LatentFormat)` 和 `class ZImagePixelSpace`。

**含义**：你当前这套 ComfyUI 0.22.3 不用升级、不用装节点，把模型文件放进 `models/` 对应目录，用标准 `UNETLoader`/`CheckpointLoaderSimple` 就能加载 Flux.2 和 Z-Image。唯一要补的是**新的文本编码器和 VAE 文件**（见下载清单）。

---

## 六、RTX 5090 (32GB) 部署方案

### 显存分配建议

| 场景 | 模型组合 | 显存占用 | 可行性 |
|------|----------|---------|--------|
| **日常快速直出** | Z-Image-Turbo(6B) FP16 + Qwen3-4B TE | ~14GB | ✅ 极流畅，可批量 |
| **开源可商用直出** | Flux.2 Klein 4B + TE + VAE | ~10GB | ✅ 极流畅，可批量 |
| **高质量单图** | Flux.2 Klein 9B | ~18GB | ✅ 流畅 |
| **顶级画质** | Flux.2 dev 32B 量化(FP8/GGUF Q4) + CPU offload | ~22GB + 内存 | ✅ 可跑，偏慢 |
| **同时挂LoRA/ControlNet** | Z-Image/Klein + 多节点 | 视节点而定 | ✅ 32GB 余量充足 |

### 配套建议
- **系统内存**：你已有 ~64GB（system_stats 显示 ram_total 66GB），跑 dev 32B offload 够用；若要更稳可上 96GB。
- **量化策略**：Flux.2 dev 用 FP8 或 GGUF Q4_K_M；Z-Image/Klein 直接 FP16 全精度（显存够，不用量化牺牲画质）。
- **散热/电源**：5090 满载跑批量时注意功耗，1200W ATX3.1 电源 + 良好风道。

---

## 七、下载清单（含国内镜像）

> GFW 环境下优先用 **ModelScope**（国内直连）。HF 链接仅作参考。

### Flux.2 Klein 4B（推荐第一个试）
| 文件 | 作用 | 大小 | 来源 |
|------|------|------|------|
| `FLUX.2-klein-4B` 模型权重 | 主模型 | ~8GB | ModelScope 搜 `FLUX.2-klein-4B` / HF `black-forest-labs/FLUX.2-klein-4B` |
| `qwen3_4b` 文本编码器 | TE | ~8GB | 同上模型页内 text_encoders |
| `ae.safetensors`(Flux.2版) | VAE | ~350MB | `black-forest-labs/FLUX.2-dev` 内 `ae.safetensors`（⚠️要用新版，不是你现在 Flux.1 的 ae） |

### Z-Image-Turbo（写实直出推荐）
| 文件 | 作用 | 大小 | 来源 |
|------|------|------|------|
| `Z-Image-Turbo` 权重 | 主模型 | ~12GB | ModelScope `Tongyi-MAI/Z-Image-Turbo`（国内直连✅） |
| `qwen3_4b` TE | TE | ~8GB | 同上（与 Flux.2 Klein 可复用同一份 qwen3_4b） |
| Z-Image VAE | VAE | ~300MB | 同模型页 |

> 💡 **TE 复用**：Flux.2 Klein 和 Z-Image 都用 `qwen3_4b`，下载一份放 `models/text_encoders/` 即可共用。

---

## 八、集成路线：怎么改造 natureDrawImage

核心思路：**把「选模型」从「选工作流 JSON」变成「选模型 + 原生语义直出」**。

### 现状链路（要替代的）
```
中文输入 → LLM翻译成英文tags → 匹配角色LoRA → 选工作流JSON → 注入参数 → ComfyUI
```

### 新链路（目标）
```
自然语言(中/英) → Z-Image/Flux.2 直接理解 → 原生生成/编辑 → 出图
                  （可选：LLM 只做「风格/角色增强」，不再做「强制拆tags」）
```

### 分步实施

**P0 — 跑通验证（先不动现有系统）**
1. 按下载清单把 Z-Image-Turbo + qwen3_4b TE + VAE 放进 `models/`
2. ComfyUI 里手动建一个最简 workflow：`UNETLoader(Z-Image-Turbo) + CLIPLoader(qwen3_4b) + VAELoader + CLIPTextEncode(中文长句) + KSampler(8步,cfg=0) + VAEDecode + SaveImage`
3. 用一大段中文 prompt 测试，确认「不用拆 tags、原生中文理解」效果

**P1 — 接入工作流库（作为新模式）**
4. 在 `workflows/` 下新建 `ZImage/base/none.json` 和 `Flux2Klein/base/none.json`（最简结构，不含 LoRA 节点）
5. 前端模式切换器加 `Z-Image` / `Flux2`（跟 WAI/Anima/Flux/Real 并列）
6. assistant 路由：命中「写实/照片/中文长句/文字渲染」意图时优先推荐这两个新模式

**P2 — 原生图像编辑（替代 Kontext 外挂）**
7. 等 Z-Image-Edit 发布（或先用 Flux.2 Klein 4B 的编辑能力）建「图生图·语义编辑」工作流
8. 前端 Img2imgTab 增加「Z-Image/Flux2 语义编辑」选项，直接接受「把背景换成雪山」这类自然语言指令，模型原生执行

**P3 — 简化助手层（减负）**
9. 对 Z-Image/Flux2 模式，assistant 不再强制调 LLM 拆 tags；改为把用户中文原句**直接**作为正向 prompt 传给模型
10. LLM 翻译层只保留给「需要挂二次元 LoRA 的 WAI/Anima 模式」用

---

## 九、推荐组合（一句话版）

- **快速直出 + 中文 + 写实**：`Z-Image-Turbo`（8步亚秒、中文好、可批量）
- **开源可商用 + 实时编辑**：`FLUX.2 Klein 4B`（Apache2.0、8GB、原生多图编辑）
- **顶级画质（备选）**：`FLUX.2 dev 32B` 量化版（最高画质，慢）
- **保留**：WAI/Anima（二次元 LoRA 生态）+ Real（majicMIX 亚洲写实）作为垂直补充

---

## 十、风险与注意点

1. **「Flux 3」不存在**：网上说的 Flux 3 都是第三方 API 封装，官方最新是 FLUX.2，别下错。
2. **Z-Image-Edit 未发布**：原生编辑能力暂时用 Flux.2 Klein 4B 顶上，等官方放出 Z-Image-Edit/Omni-Base 再换。
3. **dev 32B 许可非商用**：Klein 4B 才是 Apache2.0，要商用选 4B。
4. **新 VAE 必下**：Flux.2 的 ae.safetensors 是改进版，和你现有 Flux.1 的 ae 不通用，别复用错。
5. **验证先行**：P0 阶段务必先在 ComfyUI 手动跑通中文直出，再动 natureDrawImage 的代码，避免一上来改乱现有可用的系统。

---

*报告完。建议从「P0 跑通 Z-Image-Turbo 中文直出」开始——这是验证「模型原生语义理解能否替代工作流库」的最小成本实验。*



