import type TelegramBot from "node-telegram-bot-api";

export interface CachedMessage {
  message_id: number;
  from_id: number;
  from_username?: string;
  from_first_name: string;
  from_last_name?: string;
  text: string;
  timestamp: number;
}

class MessageCache {
  private cache: Map<number, CachedMessage[]> = new Map();
  private maxWindow: number;

  constructor(maxWindow: number) {
    this.maxWindow = maxWindow;
  }

  /**
   * Add a message to the cache for a specific chat
   */
  addMessage(chatId: number, message: TelegramBot.Message): void {
    if (!message.from || !message.text) return;

    const cachedMsg: CachedMessage = {
      message_id: message.message_id,
      from_id: message.from.id,
      from_username: message.from.username,
      from_first_name: message.from.first_name,
      from_last_name: message.from.last_name,
      text: message.text,
      timestamp: message.date * 1000, // Convert to milliseconds
    };

    const messages = this.cache.get(chatId) || [];
    messages.push(cachedMsg);

    // Keep only the last maxWindow messages
    if (messages.length > this.maxWindow) {
      messages.shift();
    }

    this.cache.set(chatId, messages);
  }

  /**
   * Get all cached messages for a specific chat
   */
  getMessages(chatId: number): CachedMessage[] {
    return this.cache.get(chatId) || [];
  }

  /**
   * Clear cache for a specific chat
   */
  clearChat(chatId: number): void {
    this.cache.delete(chatId);
  }

  /**
   * Clear all cache
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Update max window size
   */
  setMaxWindow(maxWindow: number): void {
    this.maxWindow = maxWindow;
    // Trim existing caches to new size
    for (const [chatId, messages] of this.cache.entries()) {
      if (messages.length > maxWindow) {
        this.cache.set(chatId, messages.slice(-maxWindow));
      }
    }
  }
}

export function createMessageCache(maxWindow: number): MessageCache {
  return new MessageCache(maxWindow);
}
