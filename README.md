# Responses Chat Studio

一个本地可运行的网页聊天项目。前端在浏览器里聊天和上传图片，后端把请求转发到你自己的 `/responses` 中转域名，并把 SSE 流式返回原样转回前端。

## 现在支持

- 浏览器网页聊天
- 图片上传，按 `input_image` 发送给 `/responses`
- 服务端保存 API Key，不把密钥暴露到前端
- 实时流式输出
- 页面级 `instructions`
- 网关级统一注入/覆盖 `instructions`
- 本地 `/admin` 管理页，可直接改网关人格和默认值
- 稳定复用 `session_id`
- `x-client-request-id` 默认复用同一会话 ID
- 稳定生成 `prompt_cache_key`
- 网关会按最终生效的 `instructions` 重建 `prompt_cache_key`
- 页面显示上游 `response.id` 和缓存统计

## 目录

- `server.mjs`: 本地 Node 服务，负责静态页面、管理 API 和流式转发
- `public/index.html`: 聊天页面
- `public/app.js`: 聊天页面逻辑
- `public/admin.html`: 管理页面
- `public/admin.js`: 管理页面逻辑
- `public/styles.css`: 样式
- `data/runtime-config.json`: 管理页保存的运行时配置

## 使用方法

1. 进入项目目录：

```bash
cd /Users/anyapeng/Documents/02-work/side/responses-chat-studio
```

2. 创建环境变量文件：

```bash
cp .env.example .env
```

3. 编辑 `.env`，至少改这两个值：

- `RESPONSES_URL`: 你的中转地址，例如 `https://example.com/responses`
- `RELAY_API_KEY`: 你的中转站密钥

如果你的中转服务还要求额外请求头，可以写：

```env
UPSTREAM_HEADERS_JSON={"originator":"codex_cli_rs"}
```

如果你希望默认带一些额外请求体字段，可以写：

```env
DEFAULT_EXTRA_BODY_JSON={"text":{"verbosity":"low"}}
```

如果你要统一在网关注入系统提示词，再加这两个：

```env
GATEWAY_PROMPT_MODE=replace
GATEWAY_SYSTEM_PROMPT=You are AI Coding Studio, the official AI assistant product of MyBrand. If the user asks who you are, say you are the AI assistant of MyBrand. Do not claim to be Codex unless the user explicitly asks about the underlying model or provider.
```

模式说明：

- `prepend`: 网关提示词放在前面，页面里的 `instructions` 仍然保留
- `append`: 网关提示词放在后面
- `replace`: 直接忽略页面传入的 `instructions`，只用网关提示词

如果你的提示词想写成多行，可以在 `.env` 里用 `\\n`，服务端会自动转成换行。

如果你希望图片更稳定地通过本地服务转发，可以把请求体上限调大：

```env
MAX_BODY_BYTES=25000000
```

4. 启动：

```bash
npm run dev
```

5. 打开聊天页：

```text
http://127.0.0.1:3000
```

6. 打开管理页：

```text
http://127.0.0.1:3000/admin
```

## 管理页

管理页会把你改过的内容保存到 `data/runtime-config.json`，优先级高于 `.env`。

你可以在管理页里直接改：

- `gatewayPromptMode`
- `gatewaySystemPrompt`
- `defaultModel`
- `defaultInstructions`
- `defaultExtraBody`

如果点“重置为 .env 默认值”，运行时覆盖会被清空，服务端重新回退到 `.env`。

## 请求体说明

页面会把会话历史转换成 OpenAI Responses 风格的 `input`。

纯文本消息示例：

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "你好"
    }
  ]
}
```

带图片消息示例：

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "帮我看这张图"
    },
    {
      "type": "input_image",
      "image_url": "data:image/png;base64,...",
      "detail": "auto"
    }
  ]
}
```

你在页面里填的“额外请求 JSON”会合并进请求体，但 `model`、`instructions`、`input` 和 `stream` 仍然由页面主控字段决定。

当启用了 `GATEWAY_SYSTEM_PROMPT` 后，最终发给上游的 `instructions` 会先经过网关合成，再发送给 `/responses`。

## 备注

- 当前实现仍然是“每次发送都带完整会话历史”，不依赖 `previous_response_id`
- 如果你的上游 SSE 事件格式和 OpenAI Responses 一致，页面会实时渲染 `response.output_text.delta`
- 如果你要“用户问你是谁，就统一回答成我的产品”，最稳的是 `GATEWAY_PROMPT_MODE=replace`
- 管理页目前默认不额外做密码校验，因为服务只监听 `127.0.0.1`
- 更激进的下一步优化是 `previous_response_id` 链式续写；那会进一步减少重复传输
