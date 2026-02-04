import { Address, Transaction, TransactionComputer } from '@multiversx/sdk-core';
import { X402Payload } from '../domain/types.js';
import { ISettlementStorage } from '../domain/storage.js';
import crypto from 'crypto';
import { pino } from 'pino';

const logger = pino();

import { RelayerManager } from './relayer_manager.js';

import { INetworkProvider } from '../domain/network.js';

export class Settler {
    private transactionComputer = new TransactionComputer();

    constructor(
        private storage: ISettlementStorage,
        private provider: INetworkProvider,
        private relayerManager?: RelayerManager
    ) { }

    async settle(payload: X402Payload): Promise<{ success: boolean; txHash?: string }> {
        const id = this.calculateId(payload);
        logger.info({ settlementId: id, sender: payload.sender }, 'Starting settlement process');

        // 1. Idempotency Check
        const existing = await this.storage.get(id);

        if (existing && existing.status === 'completed') {
            logger.info({ settlementId: id, txHash: existing.txHash }, 'Settlement already completed, returning existing hash');
            return { success: true, txHash: existing.txHash };
        }

        if (existing && existing.status === 'pending') {
            logger.warn({ settlementId: id }, 'Settlement already in progress');
            throw new Error('Settlement already in progress');
        }

        // 2. Save Pending Record
        await this.storage.save({
            id,
            signature: payload.signature,
            payer: payload.sender,
            status: 'pending',
            validBefore: payload.validBefore,
            createdAt: Math.floor(Date.now() / 1000),
            amount: payload.value,
            token: 'EGLD' // Default for x402 V1/V2 pending native token support in schema
        });

        try {
            let txHash: string;

            if (this.relayerManager) {
                logger.info({ sender: payload.sender }, 'Broadcasting via Relayed V3');
                txHash = await this.sendRelayedV3(payload);
            } else {
                logger.info('Broadcasting direct transaction');
                txHash = await this.sendDirect(payload);
            }

            // 3. Update to Completed
            await this.storage.updateStatus(id, 'completed', txHash);
            logger.info({ settlementId: id, txHash }, 'Settlement completed successfully');
            return { success: true, txHash };

        } catch (error: any) {
            logger.error({ settlementId: id, error: error.message }, 'Settlement failed');
            await this.storage.updateStatus(id, 'failed');
            throw new Error(`Settlement failed: ${error.message}`);
        }
    }

    private calculateId(payload: X402Payload): string {
        return crypto.createHash('sha256').update(payload.signature).digest('hex');
    }

    private async sendDirect(payload: X402Payload): Promise<string> {
        const tx = new Transaction({
            nonce: BigInt(payload.nonce),
            value: BigInt(payload.value),
            receiver: Address.newFromBech32(payload.receiver),
            sender: Address.newFromBech32(payload.sender),
            gasPrice: BigInt(payload.gasPrice),
            gasLimit: BigInt(payload.gasLimit),
            data: payload.data ? Uint8Array.from(Buffer.from(payload.data)) : undefined,
            chainID: payload.chainID,
            version: payload.version,
            signature: Uint8Array.from(Buffer.from(payload.signature, 'hex')),
        });

        const txHash = await this.provider.sendTransaction(tx);
        return txHash;
    }

    private async sendRelayedV3(payload: X402Payload): Promise<string> {
        if (!this.relayerManager) throw new Error('Relayer manager not configured');

        // Select correct relayer for this sender (shard aware)
        const relayerSigner = this.relayerManager.getSignerForUser(payload.sender);
        const expectedRelayerAddress = relayerSigner.getAddress().bech32();

        // VALIDATION: In Relayed V3, the sender MUST set the relayer address BEFORE signing.
        // We use the relayer address from the payload to ensure we don't invalidate the signature.
        const relayerAddress = payload.relayer ? Address.newFromBech32(payload.relayer) : Address.newFromBech32(expectedRelayerAddress);

        if (relayerAddress.toBech32() !== expectedRelayerAddress) {
            logger.warn({
                provided: relayerAddress.toBech32(),
                expected: expectedRelayerAddress
            }, 'Relayer address mismatch for sender shard');
            throw new Error(`Invalid relayer address. Expected ${expectedRelayerAddress} for sender's shard.`);
        }

        const tx = new Transaction({
            nonce: BigInt(payload.nonce),
            value: BigInt(payload.value),
            receiver: Address.newFromBech32(payload.receiver),
            sender: Address.newFromBech32(payload.sender),
            relayer: relayerAddress,
            gasPrice: BigInt(payload.gasPrice), // Note: Version 2 doesn't always use custom gasPrice but inherits
            gasLimit: BigInt(payload.gasLimit) + 50000n, // +50,000 for relayed
            data: payload.data ? Uint8Array.from(Buffer.from(payload.data)) : undefined,
            chainID: payload.chainID,
            version: payload.version >= 2 ? payload.version : 2, // Ensure at least V2
            signature: Uint8Array.from(Buffer.from(payload.signature, 'hex')),
        });

        // Relayer signs as well
        const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
        tx.relayerSignature = Uint8Array.from(await relayerSigner.sign(bytesToSign));

        const txHash = await this.provider.sendTransaction(tx);
        return txHash;
    }
}
