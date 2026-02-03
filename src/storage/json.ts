import fs from 'fs';
import { ISettlementRecord, ISettlementStorage } from '../domain/storage.js';

export class JsonSettlementStorage implements ISettlementStorage {
    private records: Map<string, ISettlementRecord> = new Map();

    constructor(private filePath: string) {
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                for (const record of data) {
                    this.records.set(record.id, record);
                }
            } catch (e) {
                console.error('Failed to load storage file:', e);
            }
        }
    }

    private saveToFile() {
        try {
            const data = Array.from(this.records.values());
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('Failed to save to storage file:', e);
        }
    }

    async save(record: ISettlementRecord): Promise<void> {
        this.records.set(record.id, record);
        this.saveToFile();
    }

    async get(id: string): Promise<ISettlementRecord | null> {
        return this.records.get(id) || null;
    }

    async updateStatus(id: string, status: ISettlementRecord['status'], txHash?: string): Promise<void> {
        const record = this.records.get(id);
        if (record) {
            record.status = status;
            record.txHash = txHash;
            this.saveToFile();
        }
    }

    async deleteExpired(now: number): Promise<void> {
        let changed = false;
        for (const [id, record] of this.records.entries()) {
            if (record.validBefore && record.validBefore < now) {
                this.records.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.saveToFile();
        }
    }
}
