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
                createdAt INTEGER NOT NULL
            )
        `);
    }

    async save(record: ISettlementRecord): Promise<void> {
        if (!this.db) await this.init();
        await this.db!.run(`
            INSERT INTO settlements (id, signature, payer, status, txHash, validBefore, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, record.id, record.signature, record.payer, record.status, record.txHash, record.validBefore, record.createdAt);
    }

    async get(id: string): Promise<ISettlementRecord | null> {
        if (!this.db) await this.init();
        const row = await this.db!.get('SELECT * FROM settlements WHERE id = ?', id);
        if (!row) return null;
        return row as ISettlementRecord;
    }

    async updateStatus(id: string, status: ISettlementRecord['status'], txHash?: string): Promise<void> {
        if (!this.db) await this.init();
        await this.db!.run('UPDATE settlements SET status = ?, txHash = ? WHERE id = ?', status, txHash, id);
    }

    async deleteExpired(now: number): Promise<void> {
        if (!this.db) await this.init();
        await this.db!.run('DELETE FROM settlements WHERE validBefore < ?', now);
    }
}
