import { Address, Abi, DevnetEntrypoint, SmartContractController } from '@multiversx/sdk-core';
import { config } from '../config.js';
import { pino } from 'pino';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino();

export interface PrepareRequest {
    agentNonce: number;
    serviceId: string;
    employerAddress: string;
    jobId?: string;
}

export interface PrepareResponse {
    jobId: string;
    amount: string;
    token: string;
    pnonce: number;
    receiver: string;
    data: string;
    registryAddress: string;
}

interface AgentServiceConfig {
    token: { identifier: string; nonce?: number };
    pnonce: number;
    price: bigint;
}

export class Architect {
    private static identityAbi: Abi;
    private static validationAbi: Abi;
    private static identityController: SmartContractController;
    private static validationController: SmartContractController;

    private static initializeAbis() {
        if (this.identityAbi && this.validationAbi) return;

        const identityPath = path.join(__dirname, '../abis/identity-registry.abi.json');
        const validationPath = path.join(__dirname, '../abis/validation-registry.abi.json');

        // Patch ABI types that sdk-core TypeMapper doesn't recognize
        const patchAbiTypes = (abiJson: any) => {
            const raw = JSON.stringify(abiJson);
            return JSON.parse(
                raw
                    .replace(/"TokenId"/g, '"TokenIdentifier"')
                    .replace(/"NonZeroBigUint"/g, '"BigUint"'),
            );
        };

        this.identityAbi = Abi.create(patchAbiTypes(JSON.parse(fs.readFileSync(identityPath, 'utf8'))));
        this.validationAbi = Abi.create(patchAbiTypes(JSON.parse(fs.readFileSync(validationPath, 'utf8'))));

        const apiUrl = config.networkProvider;
        const kind = apiUrl.includes('api') ? 'api' as const : 'proxy' as const;
        const entrypoint = new DevnetEntrypoint({ url: apiUrl, kind });

        this.identityController = entrypoint.createSmartContractController(this.identityAbi);
        this.validationController = entrypoint.createSmartContractController(this.validationAbi);
    }

    static async prepare(
        request: PrepareRequest,
    ): Promise<PrepareResponse> {
        this.initializeAbis();
        const jobId = request.jobId || crypto.randomBytes(32).toString('hex');
        logger.info({ agentNonce: request.agentNonce, serviceId: request.serviceId }, 'Preparing job initialization');

        const identityAddr = Address.newFromBech32(config.identityRegistryAddress);

        // 1. Resolve agent owner and full service config (price, token, pnonce)
        const { owner, price, token, pnonce } = await this.resolveAgentDetails(
            request.agentNonce,
            request.serviceId,
            identityAddr,
        );

        // 2. Construct transaction data for init_job_with_payment
        const validationAddr = Address.newFromBech32(config.validationRegistryAddress);
        const data = await this.constructDataField(
            validationAddr,
            jobId,
            request.agentNonce,
            request.serviceId,
        );

        return {
            jobId,
            amount: price,
            token,
            pnonce,
            receiver: owner,
            data,
            registryAddress: config.validationRegistryAddress,
        };
    }

    private static async resolveAgentDetails(
        nonce: number,
        serviceId: string,
        registryAddr: Address,
    ): Promise<{ owner: string; price: string; token: string; pnonce: number }> {
        // Query IdentityRegistry for owner using SmartContractController (v15 pattern)
        const ownerResults = await this.identityController.query({
            contract: registryAddr,
            function: 'get_agent_owner',
            arguments: [nonce],
        });

        // Query IdentityRegistry for full service configuration
        const configResults = await this.identityController.query({
            contract: registryAddr,
            function: 'get_agent_service_config',
            arguments: [nonce, Buffer.from(serviceId)],
        });

        const owner: string = (ownerResults[0] as Address).toBech32();
        const serviceConfig = configResults[0] as AgentServiceConfig;

        const price = serviceConfig?.price?.toString() ?? "0";

        let token = 'EGLD';
        if (serviceConfig?.token && serviceConfig?.token?.identifier) {
            token = serviceConfig.token.identifier.toString();
        }
        const pnonce = Number(serviceConfig?.pnonce ?? 0);

        if (!owner) {
            throw new Error(`Failed to fetch agent owner from registry for nonce ${nonce}`);
        }

        logger.info({ owner, price, token, pnonce }, 'Facilitator: Resolved agent details and service config');

        return { owner, price, token, pnonce };
    }

    private static async constructDataField(
        validationAddr: Address,
        jobId: string,
        nonce: number,
        serviceId: string
    ): Promise<string> {
        this.initializeAbis();
        const apiUrl = config.networkProvider;
        const kind = apiUrl.includes('api') ? 'api' as const : 'proxy' as const;
        const entrypoint = new DevnetEntrypoint({ url: apiUrl, kind });
        const factory = entrypoint.createSmartContractTransactionsFactory(this.validationAbi);

        // Use the factory to create a transaction, then extract the data field
        const tx = await factory.createTransactionForExecute(
            new Address(Buffer.alloc(32)), // Placeholder sender
            {
                contract: validationAddr,
                function: 'init_job',
                arguments: [
                    Buffer.from(jobId),
                    BigInt(nonce),
                    Number(serviceId),
                ],
                gasLimit: 0n,
            }
        );

        return Buffer.from(tx.data).toString();
    }
}
