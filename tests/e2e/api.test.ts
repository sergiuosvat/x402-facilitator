import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../../src/index';
import { JsonSettlementStorage } from '../../src/storage/json';
import { UserSigner, UserSecretKey, Address, Transaction, TransactionComputer } from '@multiversx/sdk-core';
import fs from 'fs';

describe('API E2E Tests', () => {
    let app: any;
    let mockProvider: any;
    let storage: JsonSettlementStorage;

    const aliceHex = '01'.repeat(32);
    const secretKey = new UserSecretKey(Buffer.from(aliceHex, 'hex'));
    const aliceAddress = secretKey.generatePublicKey().toAddress();
    const aliceBech32 = aliceAddress.toBech32();

    const bobAddress = new Address(Buffer.alloc(32, 2));
    const bobBech32 = bobAddress.toBech32();

    const signer = new UserSigner(secretKey);

    beforeEach(() => {
        const dbPath = './test-api-settlements.json';
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        storage = new JsonSettlementStorage(dbPath);

        mockProvider = {
            simulateTransaction: vi.fn().mockResolvedValue({
                status: { status: 'success' }
            }),
            sendTransaction: vi.fn().mockResolvedValue('tx-hash'),
        };

        app = createServer({ provider: mockProvider, storage });
    });

    const createPayload = async (overrides: any = {}) => {
        const payload: any = {
            nonce: 1,
            value: '1000000',
            receiver: bobBech32,
            sender: aliceBech32,
            gasPrice: 1000000,
            gasLimit: 50000,
            chainID: 'D',
            version: 1,
            options: 0,
            ...overrides,
        };

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
            options: payload.options
        });

        const computer = new TransactionComputer();
        const bytesToSign = computer.computeBytesForSigning(tx);
        const signature = await signer.sign(bytesToSign);

        return { ...payload, signature: Buffer.from(signature).toString('hex') };
    };

    it('should return 400 for invalid verify request', async () => {
        const response = await request(app)
            .post('/verify')
            .send({});

        expect(response.status).toBe(400);
    });

    it('should verify a valid request', async () => {
        const payload = await createPayload();
        const response = await request(app)
            .post('/verify')
            .send({
                scheme: 'exact',
                payload,
                requirements: {
                    payTo: bobBech32,
                    amount: '1000000',
                    asset: 'EGLD',
                    network: 'multiversx:D'
                }
            });

        expect(response.status).toBe(200);
        expect(response.body.isValid).toBe(true);
    });

    it('should fail verification if amount is insufficient', async () => {
        const payload = await createPayload({ value: '500' });
        const response = await request(app)
            .post('/verify')
            .send({
                scheme: 'exact',
                payload,
                requirements: {
                    payTo: bobBech32,
                    amount: '1000000',
                    asset: 'EGLD',
                    network: 'multiversx:D'
                }
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Insufficient amount');
    });

    it('should settle a valid request', async () => {
        const payload = await createPayload();
        const response = await request(app)
            .post('/settle')
            .send({
                scheme: 'exact',
                payload,
                requirements: {
                    payTo: bobBech32,
                    amount: '1000000',
                    asset: 'EGLD',
                    network: 'multiversx:D'
                }
            });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.txHash).toBe('tx-hash');
    });
});
