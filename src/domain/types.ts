export interface X402Payload {
    nonce: number;
    value: string; // BigInt as string
    receiver: string; // Bech32
    sender: string; // Bech32
    gasPrice: number;
    gasLimit: number;
    data?: string;
    chainID: string;
    version: number;
    options: number;
    signature: string; // Hex string
    relayer?: string; // Bech32 (optional, for Relayed V3)
    validAfter?: number;
    validBefore?: number;
}

export interface X402Requirements {
    payTo: string; // Bech32
    amount: string; // BigInt as string
    asset: string; // Ticker/Identifier
    network: string; // CAIP-like, e.g., multiversx:D
    extra?: {
        assetTransferMethod: 'direct' | 'esdt';
    };
}

export interface VerifyRequest {
    scheme: 'exact';
    payload: X402Payload;
    requirements: X402Requirements;
}

export interface VerifyResponse {
    isValid: boolean;
    payer: string; // Bech32
}

export interface SettleResponse {
    success: boolean;
    transaction: string; // Tx hash hex
    network: string;
    payer: string;
}
