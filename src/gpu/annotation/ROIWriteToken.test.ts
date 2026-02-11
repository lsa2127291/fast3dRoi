import { describe, expect, it } from 'vitest';
import { ROIWriteToken } from './ROIWriteToken';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ROIWriteToken', () => {
    it('should serialize writes for the same ROI', async () => {
        const token = new ROIWriteToken();
        const order: string[] = [];

        const first = token.runExclusive(7, async () => {
            order.push('first:start');
            await sleep(10);
            order.push('first:end');
        });

        const second = token.runExclusive(7, async () => {
            order.push('second:start');
            order.push('second:end');
        });

        await Promise.all([first, second]);
        expect(order).toEqual([
            'first:start',
            'first:end',
            'second:start',
            'second:end',
        ]);
    });

    it('should allow different ROI writes to run concurrently', async () => {
        const token = new ROIWriteToken();
        let inFlight = 0;
        let maxInFlight = 0;

        await Promise.all([
            token.runExclusive(1, async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await sleep(10);
                inFlight -= 1;
            }),
            token.runExclusive(2, async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await sleep(10);
                inFlight -= 1;
            }),
        ]);

        expect(maxInFlight).toBe(2);
    });
});
