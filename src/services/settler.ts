import { Address, Transaction, UserSigner, TransactionComputer } from '@multiversx/sdk-core';
import { ApiNetworkProvider, ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { X402Payload } from '../domain/types.js';
import { ISettlementStorage } from '../domain/storage.js';
import crypto from 'crypto';
import { pino } from 'pino';

const logger = pino();

export class Settler {
    private transactionComputer = new TransactionComputer();

    constructor(
        private storage: ISettlementStorage,
        private provider: any,
        private relayerSigner?: UserSigner
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
            createdAt: Math.floor(Date.now() / 1000)
        });

        try {
            let txHash: string;

            if (this.relayerSigner) {
                logger.info({ relayer: this.relayerSigner.getAddress().toBech32() }, 'Broadcasting via Relayed V3');
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
            data: payload.data ? Buffer.from(payload.data) : undefined,
            chainID: payload.chainID,
            version: payload.version,
            signature: Buffer.from(payload.signature, 'hex'),
        });

        const txHash = await this.provider.sendTransaction(tx);
        return txHash;
    }

    private async sendRelayedV3(payload: X402Payload): Promise<string> {
        if (!this.relayerSigner) throw new Error('Relayer signer not configured');

        const relayerAddress = this.relayerSigner.getAddress();

        const tx = new Transaction({
            nonce: BigInt(payload.nonce),
            value: BigInt(payload.value),
            receiver: Address.newFromBech32(payload.receiver),
            sender: Address.newFromBech32(payload.sender),
            relayer: relayerAddress,
            gasPrice: BigInt(payload.gasPrice),
            gasLimit: BigInt(payload.gasLimit) + 50000n, // +50,000 for relayed
            data: payload.data ? Buffer.from(payload.data) : undefined,
            chainID: payload.chainID,
            version: payload.version,
            signature: Buffer.from(payload.signature, 'hex'),
        });

        // Relayer signs as well
        const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
        tx.relayerSignature = await this.relayerSigner.sign(bytesToSign);

        const txHash = await this.provider.sendTransaction(tx);
        return txHash;
    }
}
