import { Address, UserVerifier, Transaction, TransactionComputer } from '@multiversx/sdk-core';
import { X402Payload, X402Requirements } from '../domain/types.js';
import { pino } from 'pino';

const logger = pino();

import { INetworkProvider } from '../domain/network.js';

import { RelayerManager } from './relayer_manager.js';

export class Verifier {
    static async verify(payload: X402Payload, requirements: X402Requirements, provider?: INetworkProvider, relayerManager?: RelayerManager): Promise<{ isValid: boolean; payer: string }> {
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
        // Use Transaction object to reconstruct the message as the SDK does
        const tx = new Transaction({
            nonce: BigInt(payload.nonce),
            value: BigInt(payload.value),
            receiver: Address.newFromBech32(payload.receiver),
            sender: Address.newFromBech32(payload.sender),
            gasPrice: BigInt(payload.gasPrice), // Note: Verify if payload has GasPrice or inherits
            gasLimit: BigInt(payload.gasLimit),
            data: payload.data ? Buffer.from(payload.data) : undefined,
            chainID: payload.chainID,
            version: payload.version,
            options: payload.options,
            relayer: payload.relayer ? Address.newFromBech32(payload.relayer) : undefined
        });

        // Apply signature from payload
        tx.signature = Buffer.from(payload.signature, 'hex');

        const computer = new TransactionComputer();
        const message = computer.computeBytesForSigning(tx);
        const senderAddress = Address.newFromBech32(payload.sender);
        const verifier = UserVerifier.fromAddress(senderAddress);

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
        // 4. Simulation
        if (provider) {
            await this.simulate(payload, provider, relayerManager);
        }

        logger.info({ sender: payload.sender }, 'Payment payload verified successfully');
        return { isValid: true, payer: payload.sender };
    }

    public static async simulate(payload: X402Payload, provider: INetworkProvider, relayerManager?: RelayerManager) {
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
            relayer: payload.relayer ? Address.newFromBech32(payload.relayer) : undefined,
        });

        // 5. Relayer Signature (if relayed)
        if (payload.relayer && relayerManager) {
            try {
                const relayerSigner = relayerManager.getSignerForUser(payload.sender);
                const computer = new TransactionComputer();
                const bytesToSign = computer.computeBytesForSigning(tx);
                tx.relayerSignature = Uint8Array.from(await relayerSigner.sign(bytesToSign));
                logger.info({ relayer: payload.relayer }, 'Applied relayer signature for simulation');
            } catch (error: any) {
                logger.warn({ error: error.message }, 'Failed to apply relayer signature for simulation, proceeding without it');
            }
        }

        try {
            const simulationResult = await provider.simulateTransaction(tx);

            const statusFromStatus = simulationResult?.status?.status;
            const statusFromRaw = simulationResult?.raw?.status;
            const resultStatus = statusFromStatus || statusFromRaw;

            if (resultStatus !== 'success') {
                const message = simulationResult?.error || 'Unknown error';
                logger.error({
                    error: message,
                    simulationResult: JSON.stringify(simulationResult)
                }, 'Simulation failed');
                throw new Error(`Simulation failed: ${message}`);
            }

            logger.info({
                gasConsumed: simulationResult?.gasConsumed,
                result: resultStatus
            }, 'Simulation successful');
        } catch (error: any) {
            logger.error({ error: error.message }, 'Simulation error');
            throw new Error(`Simulation error: ${error.message}`);
        }
    }

    // private static serializePayload removed - using Transaction.serializeForSigning() instead


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
