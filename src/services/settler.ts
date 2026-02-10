import { Address, Transaction, TransactionComputer } from '@multiversx/sdk-core';
import { X402Payload } from '../domain/types.js';
import { ISettlementStorage } from '../domain/storage.js';
import crypto from 'crypto';
import { pino } from 'pino';
import { parseSimulationResult } from '../utils/simulationParser.js';

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
            token: 'EGLD', // Default for x402 V1/V2 pending native token support in schema
            jobId: this.extractJobId(payload.data)
        });

        try {
            let txHash: string;

            if (this.relayerManager && payload.relayer) {
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

        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ settlementId: id, error: message }, 'Settlement failed');
            await this.storage.updateStatus(id, 'failed');
            throw new Error(`Settlement failed: ${message}`);
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

        // VALIDATION: In Relayed V3, the sender MUST set the relayer address BEFORE signing.
        // The relayer field is mandatory — without it the reconstructed tx won't match the sender's signature.
        if (!payload.relayer) {
            throw new Error('Relayed V3 requires payload.relayer to be set by the sender before signing.');
        }

        if (payload.version < 2) {
            throw new Error('Relayed V3 requires transaction version >= 2.');
        }

        // Select correct relayer for this sender (shard aware)
        const relayerSigner = this.relayerManager.getSignerForUser(payload.sender);
        const expectedRelayerAddress = relayerSigner.getAddress().bech32();
        const relayerAddress = Address.newFromBech32(payload.relayer);

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
            gasPrice: BigInt(payload.gasPrice),
            gasLimit: BigInt(payload.gasLimit),
            data: payload.data ? Uint8Array.from(Buffer.from(payload.data)) : new Uint8Array(0),
            chainID: payload.chainID,
            version: payload.version,
            options: payload.options,
            signature: Uint8Array.from(Buffer.from(payload.signature, 'hex')),
        });

        // Relayer ONLY adds relayerSignature — no other tx mutations allowed
        const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
        tx.relayerSignature = Uint8Array.from(await relayerSigner.sign(bytesToSign));

        // Pre-broadcast simulation (critical for catching errors before on-chain)
        if (process.env.SKIP_SIMULATION !== 'true') {
            try {
                const simulationResult = await this.provider.simulateTransaction(tx);
                logger.debug({
                    simulationResult: JSON.stringify(simulationResult, (_, v) =>
                        typeof v === 'bigint' ? v.toString() : v)
                }, 'Relayed V3 simulation result');

                const { success, errorMessage } = parseSimulationResult(simulationResult);

                if (!success) {
                    logger.error({ message: errorMessage }, 'Relayed V3 simulation failed');
                    throw new Error(`On-chain simulation failed: ${errorMessage}`);
                }
                logger.info('Relayed V3 simulation successful');
            } catch (simError: unknown) {
                const message = simError instanceof Error ? simError.message : String(simError);
                logger.error({ error: message }, 'Relayed V3 simulation error');
                throw simError;
            }
        } else {
            logger.warn('Simulation SKIPPED by SKIP_SIMULATION config');
        }

        // Broadcast
        const txHash = await this.provider.sendTransaction(tx);
        return txHash;
    }

    private extractJobId(data?: string): string | undefined {
        if (!data) return undefined;
        try {
            // Decoded data often comes as base64 or raw string depending on payload source.
            // But here payload.data is likely the string format (e.g. "func@args").
            const parts = data.split('@');
            if (parts.length >= 2 && (parts[0] === 'init_job_with_payment' || parts[0] === 'init_job')) {
                const jobIdHex = parts[1];
                return Buffer.from(jobIdHex, 'hex').toString('utf8');
            }
        } catch {
            // Ignore parsing errors
        }
        return undefined;
    }
}
