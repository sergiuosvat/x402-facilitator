import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    networkProvider: process.env.NETWORK_PROVIDER || 'https://devnet-api.multiversx.com',
    relayerPemPath: process.env.RELAYER_PEM_PATH ? path.resolve(process.env.RELAYER_PEM_PATH) : undefined,
    relayerWalletsDir: process.env.RELAYER_WALLETS_DIR ? path.resolve(process.env.RELAYER_WALLETS_DIR) : undefined,
    cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '300000', 10),
    storageType: process.env.STORAGE_TYPE || 'sqlite',
    sqliteDbPath: process.env.SQLITE_DB_PATH || './facilitator.db',
    logLevel: process.env.LOG_LEVEL || 'info',
};
