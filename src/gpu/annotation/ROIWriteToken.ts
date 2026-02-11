export class ROIWriteToken {
    private readonly queueByRoi = new Map<number, Array<() => void>>();
    private readonly lockedRoi = new Set<number>();

    async acquire(roiId: number): Promise<() => void> {
        if (!this.lockedRoi.has(roiId)) {
            this.lockedRoi.add(roiId);
            return () => {
                this.release(roiId);
            };
        }

        return new Promise((resolve) => {
            const queue = this.queueByRoi.get(roiId) ?? [];
            queue.push(() => {
                this.lockedRoi.add(roiId);
                resolve(() => {
                    this.release(roiId);
                });
            });
            this.queueByRoi.set(roiId, queue);
        });
    }

    async runExclusive<T>(roiId: number, task: () => Promise<T>): Promise<T> {
        const release = await this.acquire(roiId);
        try {
            return await task();
        } finally {
            release();
        }
    }

    isLocked(roiId: number): boolean {
        return this.lockedRoi.has(roiId);
    }

    private release(roiId: number): void {
        const queue = this.queueByRoi.get(roiId);
        if (queue && queue.length > 0) {
            const next = queue.shift();
            if (queue.length === 0) {
                this.queueByRoi.delete(roiId);
            }
            next?.();
            return;
        }

        this.lockedRoi.delete(roiId);
    }
}
