# Telegram Bot with AI Streaming Replies

This Telegram bot uses Node.js, Bun, and the Vercel AI SDK with OpenRouter provider to reply to messages when mentioned (@bot).

## Features

- Responds when mentioned in group chats or direct messages
- Uses AI streaming to generate responses
- Sends initial message, then edits every second with updated content until complete

## Setup

1. Install dependencies: `bun install`

2. Copy configuration file: `cp example.config.toml config.toml`

3. Edit `config.toml` and fill in your values:
   - `telegram_bot_token`: Your Telegram bot token from @BotFather
   - `openrouter_api_key`: Your OpenRouter API key

4. Run the bot: `bun run start`

## Usage

Mention the bot in a message (e.g., "@yourbot hello") and it will generate an AI response using streaming.
