# CivitAI Prompt Scraper

爬取 [civitai.red](https://civitai.red) 集合页的所有模型，提取提示词（trigger words / positive / negative），并按分类归档到 Excel。

## 项目结构

```
civitai_scraper/
├── civitai_scraper.py   ← 主脚本
├── requirements.txt     ← Python 依赖
└── README.md
```

## 安装依赖

```bash
pip install -r requirements.txt
playwright install chromium
```

## 配置

编辑 `civitai_scraper.py` 顶部的 `CONFIG` 字典：

```python
CONFIG = {
    "api_key": "你的_API_KEY",        # 从 https://civitai.com/user/account 获取
    "collection_url": "https://civitai.red/collections/6485353?tag=character",
    "collection_id": "6485353",
    "max_models": 0,                  # 0=不限制
    "use_api": True,                  # True=API, False=Playwright 浏览器爬取
}
```

## 运行

```bash
python civitai_scraper.py
```

## 输出

Excel 文件，按分类（Character / Pose / Concept / Other）分 Sheet，包含：
- 模型 ID、名称、类型、标签
- Trigger Words（触发词）
- 正面/负面提示词样例
- 模型描述、下载量、评分、URL

## 两种模式

| 模式 | 说明 |
|------|------|
| **API** (`use_api=True`) | 快速，需要 API Key，走 `civitai.com/api/v1` |
| **Playwright** (`use_api=False`) | 模拟浏览器，不需要 Key，适合 API 被封的情况 |
