import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { ISettlementRecord, ISettlementStorage } from '../domain/storage.js';

export class SqliteSettlementStorage implements ISettlementStorage {
    private db?: Database;

    constructor(private dbPath: string) { }

    async init() {
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS settlements (
                id TEXT PRIMARY KEY,
                signature TEXT NOT NULL,
                payer TEXT NOT NULL,
                status TEXT NOT NULL,
                txHash TEXT,
                validBefore INTEGER,
                createdAt INTEGER NOT NULL,
                isRead INTEGER DEFAULT 0,
                amount TEXT,
                token TEXT,
                jobId TEXT
            )
        `);
        // Migration support (simple check)
        try {
            await this.db.exec(`ALTER TABLE settlements ADD COLUMN isRead INTEGER DEFAULT 0`);
        } catch { /* Column likely exists */ }

        try {
            await this.db.exec(`ALTER TABLE settlements ADD COLUMN amount TEXT`);
            await this.db.exec(`ALTER TABLE settlements ADD COLUMN token TEXT`);
        } catch { /* Columns likely exist */ }

        try {
            await this.db.exec(`ALTER TABLE settlements ADD COLUMN jobId TEXT`);
        } catch { /* Columns likely exist */ }
    }

    async save(record: ISettlementRecord): Promise<void> {
        if (!this.db) await this.init();
        const isRead = record.isRead ? 1 : 0;
        await this.db!.run(`
            INSERT INTO settlements(id, signature, payer, status, txHash, validBefore, createdAt, isRead, amount, token, jobId)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, record.id, record.signature, record.payer, record.status, record.txHash, record.validBefore, record.createdAt, isRead, record.amount, record.token, record.jobId);
    }

    async get(id: string): Promise<ISettlementRecord | null> {
        if (!this.db) await this.init();
        const row = await this.db!.get('SELECT * FROM settlements WHERE id = ?', id);
        if (!row) return null;
        return {
            ...row,
            isRead: row.isRead === 1
        } as ISettlementRecord;
    }

    async updateStatus(id: string, status: ISettlementRecord['status'], txHash?: string): Promise<void> {
        if (!this.db) await this.init();
        await this.db!.run('UPDATE settlements SET status = ?, txHash = ? WHERE id = ?', status, txHash, id);
    }

    async deleteExpired(now: number): Promise<void> {
        if (!this.db) await this.init();
        await this.db!.run('DELETE FROM settlements WHERE validBefore < ?', now);
    }

    async getUnread(): Promise<ISettlementRecord[]> {
        if (!this.db) await this.init();
        const rows = await this.db!.all('SELECT * FROM settlements WHERE status = ? AND isRead = 0', 'completed');
        return rows.map(r => ({ ...r, isRead: false }));
    }

    async markAsRead(ids: string[]): Promise<void> {
        if (!this.db) await this.init();
        if (ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        await this.db!.run(`UPDATE settlements SET isRead = 1 WHERE id IN(${placeholders})`, ...ids);
    }
}
