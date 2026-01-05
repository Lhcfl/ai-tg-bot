# AGENTS.md

## 概述

本项目中的 Telegram Bot 使用 AI 代理来处理用户消息。当用户在 Telegram 中 @ 机器人时，机器人会调用 AI 代理生成回复。代理基于 OpenRouter 平台，支持多种 AI 模型。

## 上下文管理

### 消息缓存功能
AI 代理现在具有上下文感知能力：
- **自动缓存**: 机器人会自动缓存所有聊天消息（包括用户消息和 AI 的回复）
- **可配置窗口**: 通过 `config.max_message_window` 设置缓存的最大消息数量（默认 50 条）
- **完整上下文**: 当被 @ 时，AI 将获取最近的所有缓存消息作为上下文
- **持久对话**: AI 可以记住之前的对话内容，提供更连贯的回复

### 消息缓存工作原理
1. 所有文本消息（包括用户和 AI）都会被存储在内存中
2. 每个聊天独立维护自己的消息历史
3. 当缓存超过 `max_message_window` 限制时，最早的消息会被移除
4. AI 回复时会将所有缓存的消息作为上下文发送给模型

## 支持的代理类型

### 1. OpenRouter AI 代理
- **提供商**: OpenRouter
- **描述**: 使用 OpenRouter 的 API 调用各种 AI 模型，包括 OpenAI、Anthropic 等。
- **配置**:
  - 需要设置 `OPENROUTER_API_KEY` 环境变量
  - 默认模型: `openai/gpt-3.5-turbo`
  - 可在代码中修改模型: `openrouter('model-name')`

## 代理行为

### 消息处理流程
1. 用户发送消息并 @ 机器人
2. 机器人检测到提及
3. 发送初始回复: "Generating response..."
4. 从缓存中获取最近的消息历史作为上下文
5. 调用 AI 代理开始流式生成
6. 每秒更新消息内容
7. 生成完成后，最终更新消息
8. 将 AI 的回复也添加到消息缓存中

### 流式回复机制
- 使用 Vercel AI SDK 的 `streamText` 函数
- 实时累积文本，每秒编辑 Telegram 消息
- 确保用户看到渐进的回复过程

## 配置代理

### 配置文件
复制 `example.config.toml` 到 `config.toml` 并填写：
```toml
telegram_bot_token = "your_telegram_bot_token"
openrouter_api_key = "your_openrouter_api_key"
model = "openai/gpt-3.5-turbo"
app_name = "Telegram Bot"
max_message_window = 50  # 消息缓存窗口大小
```

### 代码中的配置
在 `index.ts` 中，可以修改模型：
```typescript
const result = await streamText({
  model: openrouter('openai/gpt-4o'), // 更改为其他模型
  prompt: prompt,
});
```

## 支持的模型列表

OpenRouter 支持数百种模型，包括：
- OpenAI: gpt-3.5-turbo, gpt-4, gpt-4o 等
- Anthropic: claude-3, claude-3.5-sonnet 等
- Google: gemini-pro 等
- 其他开源模型

完整列表请参考: https://openrouter.ai/models

## 代理扩展

### 添加新代理
要添加新的 AI 提供商：
1. 安装相应的 AI SDK provider
2. 在代码中导入并配置
3. 修改 `streamText` 调用

### 自定义行为
- 修改提示词 (prompt)
- 调整流式更新频率 (当前为每秒)
- 添加多代理协作
- 调整消息缓存窗口大小

## 注意事项

- 确保 API 密钥安全，不要提交到版本控制
- 监控 API 使用量和费用
- 处理 API 错误和速率限制
- 遵守 Telegram Bot API 和 OpenRouter 的使用条款
- 消息缓存存储在内存中，重启后会清空