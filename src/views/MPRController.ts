/**
 * MPR 三视图联动控制器
 */

import type { VolumeData, ViewType } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { MPRView } from './MPRView';

/**
 * MPR 控制器
 */
export class MPRController {
    private views: Map<ViewType, MPRView> = new Map();
    private volume: VolumeData | null = null;

    // 同步窗宽窗位
    private syncWindowLevel = true;

    /**
     * 注册视图
     */
    registerView(container: HTMLElement, viewType: ViewType): MPRView {
        const view = new MPRView(container, viewType);
        view.initialize();
        this.views.set(viewType, view);

        // 如果已有体数据，设置到新视图
        if (this.volume) {
            view.setVolumeData(this.volume);
        }

        return view;
    }

    /**
     * 加载体数据
     */
    setVolumeData(volume: VolumeData): void {
        this.volume = volume;

        // 设置到所有视图
        for (const view of this.views.values()) {
            view.setVolumeData(volume);
        }

        // 发送事件
        eventBus.emit('volume:loaded', { metadata: volume.metadata });
    }

    /**
     * 获取视图
     */
    getView(viewType: ViewType): MPRView | undefined {
        return this.views.get(viewType);
    }

    /**
     * 设置切片
     */
    setSlice(viewType: ViewType, index: number): void {
        const view = this.views.get(viewType);
        view?.setSlice(index);
    }

    /**
     * 同步窗宽窗位到所有视图
     */
    setWindowLevel(width: number, center: number): void {
        for (const view of this.views.values()) {
            view.setWindowLevel(width, center);
        }
    }

    /**
     * 设置是否同步窗宽窗位
     */
    setSyncWindowLevel(sync: boolean): void {
        this.syncWindowLevel = sync;
    }

    /**
     * 初始化事件监听
     */
    initializeEventHandlers(): void {
        // 监听窗宽窗位变化
        if (this.syncWindowLevel) {
            eventBus.on('window:change', ({ windowWidth, windowCenter }) => {
                for (const view of this.views.values()) {
                    const state = view.getState();
                    if (state.windowWidth !== windowWidth || state.windowCenter !== windowCenter) {
                        view.setWindowLevel(windowWidth, windowCenter);
                    }
                }
            });
        }
    }

    /**
     * 渲染所有视图
     */
    renderAll(): void {
        for (const view of this.views.values()) {
            view.render();
        }
    }

    /**
     * 获取所有视图的切片位置
     */
    getSlicePositions(): Record<ViewType, number> {
        const positions: Partial<Record<ViewType, number>> = {};
        for (const [type, view] of this.views) {
            positions[type] = view.getSlice();
        }
        return positions as Record<ViewType, number>;
    }

    /**
     * 销毁
     */
    dispose(): void {
        for (const view of this.views.values()) {
            view.dispose();
        }
        this.views.clear();
    }
}

// 单例导出
export const mprController = new MPRController();
