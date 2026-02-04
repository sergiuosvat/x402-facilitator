import express, { Request, Response } from 'express';
import { Verifier } from './services/verifier.js';
import { Settler } from './services/settler.js';
import { CleanupService } from './services/cleanup.js';
import { JsonSettlementStorage } from './storage/json.js';
import { SqliteSettlementStorage } from './storage/sqlite.js';
import { VerifyRequestSchema, SettleRequestSchema } from './domain/schemas.js';
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

export function createServer(dependencies: {
    provider: ProxyNetworkProvider,
    storage: any,
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
