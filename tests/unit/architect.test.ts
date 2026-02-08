import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Architect } from '../../src/services/architect.js';
import { Address } from '@multiversx/sdk-core';

describe('Architect Service', () => {
    const mockProvider = {
        queryContract: vi.fn(),
        sendTransaction: vi.fn(),
        simulateTransaction: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should correctly encode data for init_job_with_payment using ABI', async () => {
        const jobId = 'test-job-id';
        const nonce = 12345;
        const serviceId = 'test-service';
        const validationAddr = new Address(Buffer.alloc(32));

        // Access private method for testing encoding
        const data = await (Architect as any).constructDataField(validationAddr, jobId, nonce, serviceId);

        // Expected parts: init_job_with_payment, jobId (hex), nonce (hex, 8 bytes big endian), serviceId (hex)
        expect(data).toContain('init_job_with_payment');
        expect(data).toContain(Buffer.from(jobId).toString('hex'));

        // Nonce 12345 in hex is 3039.
        const expectedNonceHex = '3039';
        expect(data).toContain(expectedNonceHex);
        expect(data).toContain(Buffer.from(serviceId).toString('hex'));
    });

    it('should correctly parse query responses for agent details', async () => {
        const nonce = 12345;
        const serviceId = 'test-service';
        const registryAddr = new Address(Buffer.alloc(32));

        const mockOwner = new Address(Buffer.alloc(32));
        const mockPrice = 1000000000000000000n; // 1 EGLD

        // Initialize ABIs first so we can use them in the mock
        (Architect as any).initializeAbis();

        mockProvider.queryContract.mockImplementation(async (query) => {
            if (query.function === 'get_agent_owner') {
                return {
                    returnDataParts: [mockOwner.getPublicKey().toString('base64')],
                    returnCode: 'ok'
                };
            }
            if (query.function === 'get_agent_service_config') {
                const endpoint = (Architect as any).identityAbi.getEndpoint('get_agent_service_config');
                // ServiceConfig struct: price (BigUint), token (TokenIdentifier), pnonce (u64)
                // derived from ABI. We simulate the object.
                const mockConfig = {
                    price: mockPrice,
                    token: 'EGLD', // or 'USDC-123456'
                    pnonce: 10
                };

                // NativeSerializer to pack it according to ABI
                // The output is a Type (Struct), so nativeToTypedValue expects the object.
                // We rely on the ABI loaded in Architect.


                // Manually construct the ServiceConfig struct buffer to avoid NativeSerializer issues
                // Struct format: token (EgldOrEsdtTokenIdentifier), pnonce (u64), price (BigUint)

                // 1. Token (EgldOrEsdtTokenIdentifier - Enum)
                // Variant 0 (Egld) -> 0x00000000 (u32)
                const tokenBuf = Buffer.alloc(4);

                // 2. Pnonce (u64 = 10)
                const pnonceBuf = Buffer.alloc(8); pnonceBuf.writeBigUInt64BE(BigInt(10));

                // 3. Price (BigUint = mockPrice)
                let priceHex = mockPrice.toString(16);
                if (priceHex.length % 2 !== 0) priceHex = '0' + priceHex;
                const priceBuf = Buffer.from(priceHex, 'hex');
                const priceLen = Buffer.alloc(4); priceLen.writeUInt32BE(priceBuf.length);

                const structBuf = Buffer.concat([tokenBuf, pnonceBuf, priceLen, priceBuf]);

                const buffers = [structBuf];

                return {
                    returnDataParts: buffers.map(b => b.toString('base64')),
                    returnCode: 'ok'
                };
            }
            return { returnDataParts: [], returnCode: 'ok' };
        });



        const result = await (Architect as any).resolveAgentDetails(
            nonce,
            serviceId,
            registryAddr,
            mockProvider as any
        );

        expect(result.owner).toBe(mockOwner.toBech32());
        expect(result.price).toBe(mockPrice.toString());
    });
});
