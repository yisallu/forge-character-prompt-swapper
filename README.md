# Forge Character Prompt Swapper

Chrome MV3 扩展，用 `Shift + 左键` 捕获网页图片，打开生成标签页，通过 `api.sysmeng.com` 的 OpenAI 兼容 LLM 识别角色，再把角色 tags 替换进从 Forge PNG info 导入的基础提示词和参数，最后调用本地 SD WebUI Forge `/sdapi/v1/txt2img` 生图并显示进度日志。

## 文件

- `extension/`：Chrome 扩展目录，在 `chrome://extensions` 里加载这个文件夹。
- `tests/parser.test.mjs`：用你本机 Forge 输出 PNG 验证 metadata 解析、角色段替换和 txt2img payload。

## 使用

1. 启动 `D:\sd-webui-forge-neo\webui-user.bat`。我已经给 `COMMANDLINE_ARGS` 加了 `--api`，备份在同目录的 `webui-user.bat.bak-*`。
2. 打开 Chrome 的 `chrome://extensions`，启用开发者模式，加载已解压的扩展：`C:\Users\yisal\Documents\New project 42\extension`。
3. 打开扩展选项页，填写 `api.sysmeng.com` 的 API key、模型名、Forge API 地址，以及可选的 Yisalbot Token / Chat ID。默认 Forge 地址是 `http://127.0.0.1:7860`。
4. 在扩展弹窗上传 `D:\sd-webui-forge-neo\output\txt2img-images` 里的 PNG，确认“角色替换区”。
5. 在网页图片上按 `Shift + 左键`，扩展会打开新标签页，显示 LLM、Forge、进度轮询、最终图片和 Yisalbot 推送状态。

## 说明

- PNG info 解析支持 Stable Diffusion 常见的 `parameters` tEXt/iTXt chunk。
- LLM 接口按 `/v1/chat/completions` 的多模态 OpenAI 兼容格式调用。
- 如果网页图片是跨域图，内容脚本会先尝试 canvas 抓图，失败时由扩展后台用 host permission 抓取图片 URL。
- Forge 生成期间会轮询 `/sdapi/v1/progress?skip_current_image=true`，所以新标签页能看到百分比和 ETA。
- 每次生成都会使用随机 seed；基础图里的 seed 只作为信息保留，不会锁定结果。
- 生成后可以直接点“重新生成”，用当前提示词和随机 seed 再跑一次，不调用 LLM。
- 生成后可以在“改图反馈”里写问题，然后点“改提示词重生成”，LLM 会根据当前结果图和提示词改写正向提示词并再次调用 Forge。
- 结果图用 `blob:` URL 展示，可以右键在新标签打开；页面上也有“打开图片”按钮。
- Forge hires payload 会显式传 `hr_additional_modules: ["Use same choices"]`，避免 Forge Neo API 在 hires pass 里把缺省值当成 `None` 崩掉。
- Yisalbot 推送使用 Telegram Bot API `sendPhoto`；Token 或 Chat ID 留空时自动跳过。
- 命令行加载扩展时路径里有空格必须加引号；手动在 `chrome://extensions` 选择文件夹不受影响。
