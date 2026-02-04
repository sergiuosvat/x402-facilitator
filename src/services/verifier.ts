import { Address, UserVerifier, Transaction } from '@multiversx/sdk-core';
import { X402Payload, X402Requirements } from '../domain/types.js';
import { pino } from 'pino';

const logger = pino();

import { INetworkProvider } from '../domain/network.js';

export class Verifier {
    static async verify(payload: X402Payload, requirements: X402Requirements, provider?: INetworkProvider): Promise<{ isValid: boolean; payer: string }> {
        logger.info({ sender: payload.sender, receiver: payload.receiver }, 'Verifying payment payload');

        // 1. Static Checks (Time)
        const now = Math.floor(Date.now() / 1000);
        if (payload.validAfter && now < payload.validAfter) {
            logger.warn({ validAfter: payload.validAfter, now }, 'Transaction not yet valid');
            throw new Error('Transaction not yet valid');
        }
        if (payload.validBefore && now > payload.validBefore) {
            logger.warn({ validBefore: payload.validBefore, now }, 'Transaction expired');
            throw new Error('Transaction expired');
        }

        // 2. Signature Verification
        const senderAddress = Address.newFromBech32(payload.sender);
        const verifier = UserVerifier.fromAddress(senderAddress);

        // We need to re-serialize the payload for verification.
        const message = this.serializePayload(payload);
        const isValidSignature = await verifier.verify(message, Buffer.from(payload.signature, 'hex'));

        if (!isValidSignature) {
            logger.error({ sender: payload.sender }, 'Invalid signature detected');
            throw new Error('Invalid signature');
        }

        // 3. Requirements Match
        const isEsdt = payload.data?.startsWith('MultiESDTNFTTransfer');

        if (!isEsdt && payload.receiver !== requirements.payTo) {
            logger.error({ payloadReceiver: payload.receiver, requiredPayTo: requirements.payTo }, 'Receiver mismatch');
            throw new Error('Receiver mismatch');
        }

        if (requirements.asset === 'EGLD') {
            if (BigInt(payload.value) < BigInt(requirements.amount)) {
                logger.error({ payloadValue: payload.value, requiredAmount: requirements.amount }, 'Insufficient amount');
                throw new Error('Insufficient amount');
            }
        } else {
            // ESDT Logic (MultiESDTNFTTransfer parsing)
            this.verifyESDT(payload, requirements);
        }

        // 4. Simulation
        if (provider) {
            await this.simulate(payload, provider);
        }

        logger.info({ sender: payload.sender }, 'Payment payload verified successfully');
        return { isValid: true, payer: payload.sender };
    }

    public static async simulate(payload: X402Payload, provider: INetworkProvider) {
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

        try {
            const simulationResult = await provider.simulateTransaction(tx);
            if (simulationResult.execution.result !== 'success') {
                const message = simulationResult.execution.message || 'Unknown error';
                logger.error({ error: message }, 'Simulation failed');
                throw new Error(`Simulation failed: ${message}`);
            }
        } catch (error: any) {
            logger.error({ error: error.message }, 'Simulation error');
            throw new Error(`Simulation error: ${error.message}`);
        }
    }

    private static serializePayload(payload: X402Payload): Buffer {
        const parts = [
            payload.nonce.toString(),
            payload.value,
            payload.receiver,
            payload.sender,
            payload.gasPrice.toString(),
            payload.gasLimit.toString(),
            payload.data || "",
            payload.chainID,
            payload.version.toString(),
            payload.options.toString()
        ];
        return Buffer.from(parts.join('|'));
    }

    private static verifyESDT(payload: X402Payload, requirements: X402Requirements) {
        if (!payload.data?.startsWith('MultiESDTNFTTransfer')) {
            throw new Error('Not an ESDT transfer');
        }

        const parts = payload.data.split('@');
        if (parts.length < 6) {
            throw new Error('Invalid MultiESDTNFTTransfer data');
        }

        const receiverHex = parts[1];
        const tokenHex = parts[3];
        const amountHex = parts[5];

        try {
            const actualReceiverAddress = new Address(receiverHex);
            const actualReceiver = actualReceiverAddress.toBech32();
            const actualToken = Buffer.from(tokenHex, 'hex').toString();
            const actualAmount = BigInt('0x' + amountHex);

            if (actualReceiver !== requirements.payTo) {
                logger.error({ actualReceiver, requiredPayTo: requirements.payTo }, 'ESDT receiver mismatch');
                throw new Error('ESDT receiver mismatch');
            }

            if (actualToken !== requirements.asset) {
                logger.error({ actualToken, requiredAsset: requirements.asset }, 'ESDT token mismatch');
                throw new Error('ESDT token mismatch');
            }

            if (actualAmount < BigInt(requirements.amount)) {
                logger.error({ actualAmount: actualAmount.toString(), requiredAmount: requirements.amount }, 'Insufficient ESDT amount');
                throw new Error('Insufficient ESDT amount');
            }
        } catch (error: any) {
            logger.error({ error: error.message, receiverHex }, 'Error in verifyESDT Address creation');
            throw error;
        }
    }
}
