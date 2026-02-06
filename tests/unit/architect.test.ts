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

        mockProvider.queryContract.mockImplementation(async (query) => {
            if (query.function === 'get_agent_owner') {
                return {
                    returnDataParts: [mockOwner.getPublicKey().toString('base64')],
                    returnCode: 'ok'
                };
            }
            if (query.function === 'get_agent_service_price') {
                return {
                    returnDataParts: [Buffer.from(mockPrice.toString(16).padStart(16, '0'), 'hex').toString('base64')],
                    returnCode: 'ok'
                };
            }
            return { returnDataParts: [], returnCode: 'ok' };
        });

        // Initialize ABIs first (it's called in prepare, but here we test the private resolve method)
        (Architect as any).initializeAbis();

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
