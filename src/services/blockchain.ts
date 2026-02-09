import { Abi, Address, DevnetEntrypoint, MainnetEntrypoint, TestnetEntrypoint, SmartContractController } from '@multiversx/sdk-core';
import identityAbiJson from '../abis/identity-registry.abi.json' with { type: 'json' };



export interface AgentDetails {
    name: string;
    uri: string;
    public_key: string;
    owner: Address;
    metadata: Array<{ key: string; value: string }>;
}

export interface AgentServiceConfig {
    token: { identifier: string; nonce?: number };
    pnonce: number;
    price: bigint;
}

export class BlockchainService {
    private controller: SmartContractController;
    private entrypoint: DevnetEntrypoint | TestnetEntrypoint | MainnetEntrypoint;

    constructor(
        private apiUrl: string,
        private chainId: string,
        private registryAddress: string
    ) {
        const kind = apiUrl.includes('api') ? 'api' : 'proxy';

        if (chainId === '1') {
            this.entrypoint = new MainnetEntrypoint({ url: apiUrl, kind });
        } else if (chainId === 'T') {
            this.entrypoint = new TestnetEntrypoint({ url: apiUrl, kind });
        } else {
            this.entrypoint = new DevnetEntrypoint({ url: apiUrl, kind });
        }

        // Patch ABI types that sdk-core TypeMapper doesn't recognize
        const patchedAbiJson = JSON.parse(
            JSON.stringify(identityAbiJson)
                .replace(/"TokenId"/g, '"TokenIdentifier"')
                .replace(/"NonZeroBigUint"/g, '"BigUint"')
        );
        const abi = Abi.create(patchedAbiJson);
        this.controller = this.entrypoint.createSmartContractController(abi);
    }

    async getAgentDetails(nonce: number): Promise<AgentDetails> {
        const results = await this.controller.query({
            contract: Address.newFromBech32(this.registryAddress),
            function: 'get_agent',
            arguments: [nonce],
        });

        return results[0] as AgentDetails;
    }

    async getAgentServicePrice(nonce: number, serviceId: string): Promise<bigint> {
        const results = await this.controller.query({
            contract: Address.newFromBech32(this.registryAddress),
            function: 'get_agent_service_price',
            arguments: [nonce, Buffer.from(serviceId)],
        });

        return results[0] as bigint;
    }

    async getAgentServiceConfig(nonce: number, serviceId: string): Promise<AgentServiceConfig> {
        const results = await this.controller.query({
            contract: Address.newFromBech32(this.registryAddress),
            function: 'get_agent_service_config',
            arguments: [nonce, Buffer.from(serviceId)],
        });

        return results[0] as AgentServiceConfig;
    }
}
