import { Address, UserVerifier, Transaction, TransactionComputer } from '@multiversx/sdk-core';
import { X402Payload, X402Requirements } from '../domain/types.js';
import { pino } from 'pino';
import { INetworkProvider } from '../domain/network.js';
import { RelayerManager } from './relayer_manager.js';
import { BlockchainService } from './blockchain.js';
import { parseSimulationResult } from '../utils/simulationParser.js';

const logger = pino();

export class Verifier {
    static async verify(
        payload: X402Payload,
        requirements: X402Requirements,
        provider?: INetworkProvider,
        relayerManager?: RelayerManager,
        blockchainService?: BlockchainService
    ): Promise<{ isValid: boolean; payer: string }> {
        logger.info({ sender: payload.sender, receiver: payload.receiver }, 'Verifying payment payload');

        // 1. Requirement Resolution (v2.1)
        // If requirements are partial, try to resolve from Identity Registry
        const resolvedRequirements = { ...requirements };
        const jobId = this.extractJobId(payload.data);

        if (blockchainService && jobId && !requirements.amount) {
            try {
                // For simplicity, we assume agent nonce is part of the job ID or fetched elsewhere
                // In a real scenario, we'd extract agent nonce from the transaction data or receiver metadata
                // Since this is a standardization task, we demonstrate the ABI query pattern
                const agentNonce = this.extractAgentNonce(payload.data);
                if (agentNonce) {
                    const price = await blockchainService.getAgentServicePrice(agentNonce, 'default');
                    resolvedRequirements.amount = price.toString();
                    resolvedRequirements.asset = 'EGLD';
                    logger.info({ agentNonce, price: price.toString() }, 'Resolved requirements from Registry');
                }
            } catch (error) {
                logger.warn({ error: (error as Error).message }, 'Failed to resolve requirements from Registry');
            }
        }

        // 2. Static Checks (Time)
        const now = Math.floor(Date.now() / 1000);
        if (payload.validAfter && now < payload.validAfter) {
            throw new Error('Transaction not yet valid');
        }
        if (payload.validBefore && now > payload.validBefore) {
            throw new Error('Transaction expired');
        }

        // 3. Signature Verification
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
            options: payload.options,
            relayer: payload.relayer ? Address.newFromBech32(payload.relayer) : undefined
        });

        tx.signature = Buffer.from(payload.signature, 'hex');

        const computer = new TransactionComputer();
        const message = computer.computeBytesForSigning(tx);
        const verifier = UserVerifier.fromAddress(Address.newFromBech32(payload.sender));

        const isValidSignature = await verifier.verify(message, tx.signature);
        if (!isValidSignature) {
            throw new Error('Invalid signature');
        }

        // 4. Requirements Match
        const isEsdt = payload.data?.startsWith('MultiESDTNFTTransfer');
        if (!isEsdt && payload.receiver !== resolvedRequirements.payTo) {
            throw new Error('Receiver mismatch');
        }

        if (resolvedRequirements.asset === 'EGLD') {
            if (BigInt(payload.value) < BigInt(resolvedRequirements.amount)) {
                throw new Error('Insufficient amount');
            }
        } else {
            this.verifyESDT(payload, resolvedRequirements);
        }

        // 5. Simulation
        if (provider) {
            await this.simulate(payload, provider, relayerManager);
        }

        return { isValid: true, payer: payload.sender };
    }

    private static extractJobId(data?: string): string | undefined {
        if (!data) return undefined;
        const parts = data.split('@');
        if (parts.length >= 2 && (parts[0] === 'init_job_with_payment' || parts[0] === 'init_job')) {
            return Buffer.from(parts[1], 'hex').toString('utf8');
        }
        return undefined;
    }

    private static extractAgentNonce(data?: string): number | undefined {
        if (!data) return undefined;
        const parts = data.split('@');
        // init_job_with_payment@jobId@agentNonce@...
        if (parts.length >= 3 && parts[0] === 'init_job_with_payment') {
            return parseInt(parts[2], 16);
        }
        return undefined;
    }

    private static async simulate(payload: X402Payload, provider: INetworkProvider, relayerManager?: RelayerManager) {
        if (process.env.SKIP_SIMULATION === 'true' || process.env.SKIP_SIMULATION === '1') {
            logger.warn('Skipping simulation as per SKIP_SIMULATION env var');
            return;
        }

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

        if (payload.relayer && relayerManager) {
            try {
                const relayerSigner = relayerManager.getSignerForUser(payload.sender);
                const computer = new TransactionComputer();
                const bytesToSign = computer.computeBytesForSigning(tx);
                tx.relayerSignature = Uint8Array.from(await relayerSigner.sign(bytesToSign));
            } catch (error) {
                logger.warn({ error: (error as Error).message }, 'Failed to apply relayer signature for simulation');
            }
        }

        const simulationResult = await provider.simulateTransaction(tx);

        const { success, errorMessage } = parseSimulationResult(simulationResult);
        if (!success) {
            logger.error({ error: errorMessage, result: simulationResult }, 'Simulation failed');
            throw new Error(`Simulation failed: ${errorMessage}`);
        }
    }

    private static verifyESDT(payload: X402Payload, requirements: X402Requirements) {
        if (!payload.data?.startsWith('MultiESDTNFTTransfer')) {
            throw new Error('Not an ESDT transfer');
        }

        const parts = payload.data.split('@');
        if (parts.length < 6) {
            throw new Error('Invalid MultiESDTNFTTransfer data');
        }

        const actualReceiver = Address.newFromHex(parts[1]).toBech32();
        const actualToken = Buffer.from(parts[3], 'hex').toString();
        const actualAmount = BigInt('0x' + parts[5]);

        if (actualReceiver !== requirements.payTo) throw new Error('ESDT receiver mismatch');
        if (actualToken !== requirements.asset) throw new Error('ESDT token mismatch');
        if (actualAmount < BigInt(requirements.amount)) throw new Error('Insufficient ESDT amount');
    }
}
