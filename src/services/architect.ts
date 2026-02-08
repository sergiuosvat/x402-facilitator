import { Address, SmartContractQuery, AbiRegistry, SmartContractTransactionsFactory, TransactionsFactoryConfig, ArgSerializer, NativeSerializer } from '@multiversx/sdk-core';
import { INetworkProvider } from '../domain/network.js';
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

export class Architect {
    private static identityAbi: AbiRegistry;
    private static validationAbi: AbiRegistry;

    private static initializeAbis() {
        if (this.identityAbi && this.validationAbi) return;

        const identityPath = path.join(__dirname, '../abis/identity-registry.abi.json');
        const validationPath = path.join(__dirname, '../abis/validation-registry.abi.json');

        this.identityAbi = AbiRegistry.create(JSON.parse(fs.readFileSync(identityPath, 'utf8')));
        this.validationAbi = AbiRegistry.create(JSON.parse(fs.readFileSync(validationPath, 'utf8')));
    }

    static async prepare(
        request: PrepareRequest,
        provider: INetworkProvider
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
            provider
        );

        // 2. Construct transaction data for init_job_with_payment using TransactionsFactory
        const validationAddr = Address.newFromBech32(config.validationRegistryAddress);
        const data = await this.constructDataField(
            validationAddr,
            jobId,
            request.agentNonce,
            request.serviceId
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
        provider: INetworkProvider
    ): Promise<{ owner: string; price: string; token: string; pnonce: number }> {
        const serializer = new ArgSerializer();

        // Query IdentityRegistry for owner
        const ownerQuery = new SmartContractQuery({
            contract: registryAddr,
            function: 'get_agent_owner',
            arguments: serializer.valuesToBuffers(NativeSerializer.nativeToTypedValues([nonce], this.identityAbi.getEndpoint('get_agent_owner'))),
        });

        // Query IdentityRegistry for full service configuration (Unified Call)
        const configQuery = new SmartContractQuery({
            contract: registryAddr,
            function: 'get_agent_service_config',
            arguments: serializer.valuesToBuffers(NativeSerializer.nativeToTypedValues([nonce, Buffer.from(serviceId)], this.identityAbi.getEndpoint('get_agent_service_config'))),
        });

        const [ownerRes, configRes] = await Promise.all([
            provider.queryContract(ownerQuery),
            provider.queryContract(configQuery),
        ]);

        const ownerValues = serializer.buffersToValues(ownerRes.returnDataParts.map((p: string) => Buffer.from(p, 'base64')), this.identityAbi.getEndpoint('get_agent_owner').output);
        const configValues = serializer.buffersToValues(configRes.returnDataParts.map((p: string) => Buffer.from(p, 'base64')), this.identityAbi.getEndpoint('get_agent_service_config').output);

        const owner: string = (ownerValues[0].valueOf() as Address).toBech32();
        const serviceConfig = configValues[0].valueOf() as any;

        const price = serviceConfig.price.toString();

        let token = 'EGLD';
        if (serviceConfig.token && serviceConfig.token.identifier) {
            token = serviceConfig.token.identifier.toString();
        } else if (serviceConfig.token && typeof serviceConfig.token.toString === 'function') {
            const str = serviceConfig.token.toString();
            // If it's the Enum object for EGLD, it might be 'Egld' or empty.
            // We default to EGLD if no identifier.
            if (str !== 'Egld' && str !== '') token = str;
        }
        const pnonce = Number(serviceConfig.pnonce);

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
        const factory = new SmartContractTransactionsFactory({
            abi: this.validationAbi,
            config: new TransactionsFactoryConfig({ chainID: 'D' })
        });

        const endpoint = this.validationAbi.getEndpoint('init_job_with_payment');
        const typedArgs = NativeSerializer.nativeToTypedValues([
            Buffer.from(jobId),
            BigInt(nonce),
            Buffer.from(serviceId)
        ], endpoint);

        // Use the factory to create a transaction, then extract the data field
        const tx = await factory.createTransactionForExecute(
            new Address(Buffer.alloc(32)), // Placeholder
            {
                contract: validationAddr,
                function: 'init_job_with_payment',
                arguments: typedArgs,
                gasLimit: 0n
            }
        );

        return Buffer.from(tx.data).toString();
    }
}
