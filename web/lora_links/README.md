Lora 链接映射目录。

每个文件名与 `web/workflows/` 下的工作流 `.json` 同名，扩展名改为 `.txt`，文件内容只放一行 URL。

示例：
- 工作流 `WAI - 莫宁.json` → 在此目录创建 `WAI - 莫宁.txt`，内容：
  ```
  https://example.com/lora-page
  ```

匹配规则同缩略图：先按完整相对路径（保留子目录），再退回 basename。
