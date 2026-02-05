import { UserSigner } from '@multiversx/sdk-wallet';
import { Address } from '@multiversx/sdk-core';
import fs from 'fs';
import path from 'path';

import { pino } from 'pino';

const logger = pino();

export class RelayerManager {
    private signers: Map<number, UserSigner> = new Map();
    private addresses: Map<number, string> = new Map();
    private singleSigner?: UserSigner;

    constructor(walletsDir?: string, singlePemPath?: string) {
        if (walletsDir) {
            this.loadWallets(walletsDir);
        }
        if (singlePemPath && fs.existsSync(singlePemPath)) {
            try {
                const pemContent = fs.readFileSync(singlePemPath, 'utf8');
                this.singleSigner = UserSigner.fromPem(pemContent);
                logger.info({ address: this.singleSigner.getAddress().bech32() }, 'Loaded single relayer');
            } catch (e: any) {
                logger.warn({ error: e.message }, 'Failed to load single PEM');
            }
        }
    }

    private loadWallets(walletsDir: string) {
        if (!fs.existsSync(walletsDir)) {
            return;
        }

        const files = fs.readdirSync(walletsDir);
        for (const file of files) {
            if (file.endsWith(".pem")) {
                try {
                    const pemContent = fs.readFileSync(path.join(walletsDir, file), "utf8");
                    const signer = UserSigner.fromPem(pemContent);
                    const userAddress = signer.getAddress();
                    // Convert UserAddress (sdk-wallet) to Address (sdk-core)
                    const address = Address.newFromBech32(userAddress.bech32());
                    const shard = this.getShard(address);

                    this.signers.set(shard, signer);
                    this.addresses.set(shard, address.toBech32());
                    logger.info({ shard, address: address.toBech32() }, 'Loaded relayer for shard');
                } catch (e: any) {
                    logger.error({ file, error: e.message }, 'Failed to load wallet');
                }
            }
        }
    }

    private getShard(address: Address): number {
        const pubKey = address.getPublicKey();
        const lastByte = pubKey[31];
        const mask = 0x03;
        let shard = lastByte & mask;
        if (shard > 2) {
            shard = lastByte & 0x01;
        }
        return shard;
    }

    public getSignerForUser(userAddressStr: string): UserSigner {
        // Multi-shard check
        if (this.signers.size > 0) {
            const userAddress = new Address(userAddressStr);
            const shard = this.getShard(userAddress);
            const signer = this.signers.get(shard);
            if (signer) return signer;
        }

        // Fallback to single signer
        if (this.singleSigner) return this.singleSigner;

        throw new Error(`No relayer configured for user ${userAddressStr}`);
    }

    public getRelayerAddressForUser(userAddressStr: string): string {
        // Multi-shard check
        if (this.addresses.size > 0) {
            const userAddress = new Address(userAddressStr);
            const shard = this.getShard(userAddress);
            const relayerAddress = this.addresses.get(shard);
            if (relayerAddress) return relayerAddress;
        }

        // Fallback to single signer
        if (this.singleSigner) {
            return this.singleSigner.getAddress().bech32();
        }

        throw new Error(`No relayer configured for user ${userAddressStr}`);
    }
}
