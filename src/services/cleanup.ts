import { ISettlementStorage } from '../domain/storage.js';

export class CleanupService {
    private timer?: NodeJS.Timeout;

    constructor(
        private storage: ISettlementStorage,
        private intervalMs: number = 5 * 60 * 1000 // 5 minutes
    ) { }

    start() {
        if (this.timer) return;
        this.timer = setInterval(async () => {
            const now = Math.floor(Date.now() / 1000);
            try {
                await this.storage.deleteExpired(now);
                console.log(`[CleanupService] Purged expired records at ${new Date().toISOString()}`);
            } catch (e) {
                console.error('[CleanupService] Error during cleanup:', e);
            }
        }, this.intervalMs);
        this.timer.unref(); // Don't keep the process alive just for this
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}
