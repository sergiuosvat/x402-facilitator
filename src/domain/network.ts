import { Transaction } from '@multiversx/sdk-core';

export interface INetworkProvider {
    sendTransaction(tx: Transaction): Promise<string>;
    simulateTransaction(tx: Transaction): Promise<any>;
}
