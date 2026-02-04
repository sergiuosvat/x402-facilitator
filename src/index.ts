import express, { Request, Response } from 'express';
import { Verifier } from './services/verifier.js';
import { Settler } from './services/settler.js';
import { CleanupService } from './services/cleanup.js';
import { JsonSettlementStorage } from './storage/json.js';
import { SqliteSettlementStorage } from './storage/sqlite.js';
import { VerifyRequestSchema, SettleRequestSchema } from './domain/schemas.js';
import { ISettlementRecord, ISettlementStorage } from './domain/storage.js';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { UserSigner } from '@multiversx/sdk-core';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';
import { pino } from 'pino';
import { RelayerManager } from './services/relayer_manager.js';

const logger = pino({
    level: config.logLevel,
});

import { INetworkProvider } from './domain/network.js';

export function createServer(dependencies: {
    provider: INetworkProvider,
    storage: ISettlementStorage,
    relayerManager?: RelayerManager
}) {
    const { provider, storage, relayerManager } = dependencies;
    const app = express();
    app.use(express.json());

    const settler = new Settler(storage, provider, relayerManager);
    const cleanupService = new CleanupService(storage);
    cleanupService.start();

    app.post('/verify', async (req: Request, res: Response) => {
        try {
            const validated = VerifyRequestSchema.parse(req.body);
            const result = await Verifier.verify(validated.payload, validated.requirements, provider);
            res.json(result);
        } catch (error: any) {
            logger.warn({ error: error.message, body: req.body }, 'Verify request failed');
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/settle', async (req: Request, res: Response) => {
        try {
            const validated = SettleRequestSchema.parse(req.body);
            await Verifier.verify(validated.payload, validated.requirements, provider);
            const result = await settler.settle(validated.payload);
            res.json(result);
        } catch (error: any) {
            logger.warn({ error: error.message, body: req.body }, 'Settle request failed');
            res.status(400).json({ error: error.message });
        }
    });

    // Event Polling (Simple Implementation)
    app.get('/events', async (req: Request, res: Response) => {
        try {
            const unread = await storage.getUnread();

            // Transform to Moltbot schema if needed, but for now return raw records
            const events = unread.map((r: ISettlementRecord) => ({
                amount: r.amount || '0',
                token: r.token || 'EGLD',
                // For MVP, we return the record which contains the raw payload?
                // SettlementStorage record structure is limited (id, signature, payer, status).
                // We might need to store the FULL payload to be useful?
                // For now, let's map what we have.
                meta: {
                    jobId: r.id, // Using hash as JobID effectively
                    payload: r.id, // Or signature? Moltbot uses this payload string.
                    sender: r.payer,
                    txHash: r.txHash
                    // We don't have the original 'data' field in ISettlementRecord unless we add it.
                    // But Moltbot just needs a trigger.
                }
            }));

            // Auto-mark as read if requested (consuming the queue)
            if (req.query.unread === 'true' && unread.length > 0) {
                await storage.markAsRead(unread.map((r: ISettlementRecord) => r.id));
            }

            res.json(events);
        } catch (error: any) {
            logger.error({ error: error.message }, 'Events poll failed');
            res.status(500).json({ error: error.message });
        }
    });

    return app;
}

async function start() {
    const provider = new ProxyNetworkProvider(config.networkProvider);

    let storage;
    if (config.storageType === 'sqlite') {
        logger.info({ path: config.sqliteDbPath }, 'Using SQLite storage');
        const sqliteStorage = new SqliteSettlementStorage(config.sqliteDbPath);
        await sqliteStorage.init();
        storage = sqliteStorage;
    } else {
        const dataDir = './data';
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
        }
        const jsonPath = path.join(dataDir, 'settlements.json');
        logger.info({ path: jsonPath }, 'Using JSON storage');
        storage = new JsonSettlementStorage(jsonPath);
    }

    const relayerManager = new RelayerManager(config.relayerWalletsDir, config.relayerPemPath);

    const app = createServer({ provider, storage, relayerManager });
    app.listen(config.port, () => {
        logger.info({ port: config.port, network: config.networkProvider }, 'x402 Facilitator started');
    });
}

if (require.main === module) {
    start().catch(err => {
        logger.error({ error: err.message }, 'Failed to start server');
        process.exit(1);
    });
}
