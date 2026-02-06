import { Address, Query, U64Value, BytesValue } from '@multiversx/sdk-core';
import { INetworkProvider } from '../domain/network.js';
import { config } from '../config.js';
import { pino } from 'pino';
import crypto from 'crypto';

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
    receiver: string;
    data: string;
    registryAddress: string;
}

export class Architect {
    static async prepare(
        request: PrepareRequest,
        provider: INetworkProvider
    ): Promise<PrepareResponse> {
        const jobId = request.jobId || crypto.randomBytes(32).toString('hex');
        logger.info({ agentNonce: request.agentNonce, serviceId: request.serviceId }, 'Preparing job initialization');

        const identityAddr = Address.newFromBech32(config.identityRegistryAddress);

        // 1. Resolve agent owner and price
        const { owner, price } = await this.resolveAgentDetails(
            request.agentNonce,
            request.serviceId,
            identityAddr,
            provider
        );

        // 2. Construct transaction data for init_job_with_payment
        // Function name: init_job_with_payment
        // Arguments: [job_id (buffer), agent_nonce (u64), service_id (buffer)]
        const data = this.constructDataField(
            jobId,
            request.agentNonce,
            request.serviceId
        );

        return {
            jobId,
            amount: price,
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
    ): Promise<{ owner: string; price: string }> {
        // Query IdentityRegistry for owner and price
        // Note: We modified IdentityRegistry to have:
        // getAgentOwner(nonce: u64) -> ManagedAddress
        // getAgentServicePrice(nonce: u64, service_id: ManagedBuffer) -> BigUint

        const ownerQuery = new Query({
            address: registryAddr,
            func: 'get_agent_owner',
            args: [new U64Value(BigInt(nonce))],
        });

        const priceQuery = new Query({
            address: registryAddr,
            func: 'get_agent_service_price',
            args: [
                new U64Value(BigInt(nonce)),
                new BytesValue(Buffer.from(serviceId))
            ],
        });

        const [ownerRes, priceRes] = await Promise.all([
            provider.queryContract(ownerQuery),
            provider.queryContract(priceQuery),
        ]);

        logger.info({ ownerRes, priceRes }, 'Facilitator: Registry query results');

        // Robust check for returnData vs returnDataParts
        const ownerData = ownerRes.returnData || ownerRes.returnDataParts;
        const priceData = priceRes.returnData || priceRes.returnDataParts;

        if (!ownerData || ownerData.length === 0 || !priceData || priceData.length === 0) {
            logger.error({ ownerData, priceData }, 'Facilitator: Missing registry return data');
            throw new Error('Failed to fetch agent details from registry: missing data');
        }

        // Parse Results
        const ownerBuffer = Buffer.from(ownerData[0], 'base64');
        const priceBuffer = Buffer.from(priceData[0], 'base64');

        const owner = new Address(ownerBuffer).toBech32();
        const price = BigInt('0x' + priceBuffer.toString('hex')).toString();

        return { owner, price };
    }

    private static constructDataField(jobId: string, nonce: number, serviceId: string): string {
        // init_job_with_payment @ job_id @ agent_nonce @ service_id
        const func = 'init_job_with_payment';
        const jobIdHex = Buffer.from(jobId).toString('hex');
        const nonceHex = nonce.toString(16).padStart(16, '0');
        const serviceIdHex = Buffer.from(serviceId).toString('hex');

        return `${func}@${jobIdHex}@${nonceHex}@${serviceIdHex}`;
    }
}
