/**
 * 全局事件总线 - 用于视图间通信
 */

import type { EventMap } from './types';

type EventCallback<T> = (data: T) => void;

class EventBus {
    private listeners: Map<string, Set<EventCallback<unknown>>> = new Map();

    /**
     * 订阅事件
     */
    on<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(callback as EventCallback<unknown>);

        // 返回取消订阅函数
        return () => this.off(event, callback);
    }

    /**
     * 取消订阅
     */
    off<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): void {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.delete(callback as EventCallback<unknown>);
        }
    }

    /**
     * 触发事件
     */
    emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach((cb) => cb(data));
        }
    }

    /**
     * 一次性订阅
     */
    once<K extends keyof EventMap>(event: K, callback: EventCallback<EventMap[K]>): () => void {
        const wrapper: EventCallback<EventMap[K]> = (data) => {
            this.off(event, wrapper);
            callback(data);
        };
        return this.on(event, wrapper);
    }

    /**
     * 清除所有监听器
     */
    clear(): void {
        this.listeners.clear();
    }
}

// 单例导出
export const eventBus = new EventBus();
