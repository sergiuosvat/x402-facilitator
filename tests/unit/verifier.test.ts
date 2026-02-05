import { describe, it, expect, vi } from 'vitest';
import { Verifier } from '../../src/services/verifier';
import { X402Payload, X402Requirements } from '../../src/domain/types';
import { UserSigner, Address, UserSecretKey, Transaction, TransactionComputer } from '@multiversx/sdk-core';

describe('Verifier Service', () => {
    // Correctly derive Alice's address from her secret key
    const aliceHex = '01'.repeat(32);
    const secretKey = new UserSecretKey(Buffer.from(aliceHex, 'hex'));
    const aliceAddress = secretKey.generatePublicKey().toAddress();
    const aliceBech32 = aliceAddress.toBech32();

    // Bob can be any valid address
    const bobAddress = new Address(Buffer.alloc(32, 2));
    const bobBech32 = bobAddress.toBech32();

    const signer = new UserSigner(secretKey);

    const createPayload = async (overrides: Partial<X402Payload> = {}): Promise<X402Payload> => {
        const payload: Omit<X402Payload, 'signature'> = {
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
            gasPrice: BigInt(payload.gasPrice), // SDK v15 logic
            gasLimit: BigInt(payload.gasLimit),
            data: payload.data ? Buffer.from(payload.data) : undefined,
            chainID: payload.chainID,
            version: payload.version,
            options: payload.options,
            relayer: payload.relayer ? Address.newFromBech32(payload.relayer) : undefined
        });

        const computer = new TransactionComputer();
        const bytesToSign = computer.computeBytesForSigning(tx);
        const signature = await signer.sign(bytesToSign);

        return { ...payload, signature: Buffer.from(signature).toString('hex') };
    };

    const requirements: X402Requirements = {
        payTo: bobBech32,
        amount: '1000000',
        asset: 'EGLD',
        network: 'multiversx:D',
    };

    it('should verify a valid signed payload', async () => {
        const payload = await createPayload();
        const result = await Verifier.verify(payload, requirements);
        expect(result.isValid).toBe(true);
        expect(result.payer).toBe(aliceBech32);
    });

    it('should fail if signature is invalid', async () => {
        const payload = await createPayload();
        payload.signature = '0'.repeat(128);
        await expect(Verifier.verify(payload, requirements)).rejects.toThrow('Invalid signature');
    });

    it('should fail if expired', async () => {
        const payload = await createPayload({ validBefore: Math.floor(Date.now() / 1000) - 100 });
        await expect(Verifier.verify(payload, requirements)).rejects.toThrow('Transaction expired');
    });

    it('should fail if not yet valid', async () => {
        const payload = await createPayload({ validAfter: Math.floor(Date.now() / 1000) + 100 });
        await expect(Verifier.verify(payload, requirements)).rejects.toThrow('Transaction not yet valid');
    });

    it('should fail if receiver mismatch', async () => {
        const payload = await createPayload();
        const badReq = { ...requirements, payTo: aliceBech32 };
        await expect(Verifier.verify(payload, badReq)).rejects.toThrow('Receiver mismatch');
    });

    it('should fail if insufficient amount', async () => {
        const payload = await createPayload({ value: '500' });
        await expect(Verifier.verify(payload, requirements)).rejects.toThrow('Insufficient amount');
    });

    it('should pass if simulation succeeds', async () => {
        const payload = await createPayload();
        const mockProvider = {
            simulateTransaction: vi.fn().mockResolvedValue({
                execution: { result: 'success' }
            })
        };
        const result = await Verifier.verify(payload, requirements, mockProvider);
        expect(result.isValid).toBe(true);
        expect(mockProvider.simulateTransaction).toHaveBeenCalled();
    });

    it('should NOT skip simulation even if relayer field is present and should sign with relayer', async () => {
        const payload = await createPayload({ relayer: aliceBech32 });
        const mockProvider = {
            simulateTransaction: vi.fn().mockResolvedValue({
                execution: { result: 'success' }
            })
        };

        const mockRelayerSigner = {
            sign: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('relayer-sig-sim')))
        };

        const mockRelayerManager = {
            getSignerForUser: vi.fn().mockReturnValue(mockRelayerSigner)
        };

        const result = await Verifier.verify(payload, requirements, mockProvider as any, mockRelayerManager as any);
        expect(result.isValid).toBe(true);
        expect(mockProvider.simulateTransaction).toHaveBeenCalled();
        expect(mockRelayerManager.getSignerForUser).toHaveBeenCalledWith(payload.sender);

        const simulatedTx = mockProvider.simulateTransaction.mock.calls[0][0];
        expect(simulatedTx.relayerSignature).toBeDefined();
        expect(Buffer.from(simulatedTx.relayerSignature).toString()).toBe('relayer-sig-sim');
    });

    it('should handle malformed simulation response gracefully', async () => {
        const payload = await createPayload();
        const mockProvider = {
            // Returns object without execution property
            simulateTransaction: vi.fn().mockResolvedValue({ somethingElse: true })
        };
        // Should throw because result !== 'success' (undefined !== 'success')
        // The error handling code: simulationResult?.execution?.result !== 'success' -> throws 'Unknown error'
        await expect(Verifier.verify(payload, requirements, mockProvider as any)).rejects.toThrow('Simulation failed: Unknown error');
    });

    it('should fail if simulation fails', async () => {
        const payload = await createPayload();
        const mockProvider = {
            simulateTransaction: vi.fn().mockResolvedValue({
                execution: { result: 'fail', message: 'invalid nonce' }
            })
        };
        await expect(Verifier.verify(payload, requirements, mockProvider as any)).rejects.toThrow('Simulation failed: invalid nonce');
    });

    describe('ESDT Verification', () => {
        const esdtRequirements: X402Requirements = {
            payTo: bobBech32,
            amount: '5000',
            asset: 'TEST-abcd',
            network: 'multiversx:D',
        };

        it('should verify a valid ESDT MultiESDTNFTTransfer', async () => {
            // MultiESDTNFTTransfer data format:
            // MultiESDTNFTTransfer@receiverAddressHex@numTopics@tokenIdentifierHex@nonceHex@amountHex
            const receiverHex = bobAddress.valueOf().toString('hex');
            const tokenHex = Buffer.from('TEST-abcd').toString('hex');
            const data = `MultiESDTNFTTransfer@${receiverHex}@01@${tokenHex}@00@1388`; // 1388 hex is 5000

            const payload = await createPayload({
                data,
                value: '0',
                receiver: aliceBech32 // MultiESDTNFTTransfer receiver in tx is self
            });

            const result = await Verifier.verify(payload, esdtRequirements);
            expect(result.isValid).toBe(true);
        });

        it('should fail if ESDT amount is insufficient', async () => {
            const receiverHex = bobAddress.valueOf().toString('hex');
            const tokenHex = Buffer.from('TEST-abcd').toString('hex');
            const data = `MultiESDTNFTTransfer@${receiverHex}@01@${tokenHex}@00@03E8`; // 03E8 hex is 1000

            const payload = await createPayload({
                data,
                value: '0',
                receiver: aliceBech32
            });

            await expect(Verifier.verify(payload, esdtRequirements)).rejects.toThrow('Insufficient ESDT amount');
        });

        it('should fail if ESDT token mismatch', async () => {
            const receiverHex = bobAddress.valueOf().toString('hex');
            const tokenHex = Buffer.from('WRONG-token').toString('hex');
            const data = `MultiESDTNFTTransfer@${receiverHex}@01@${tokenHex}@00@1388`;

            const payload = await createPayload({
                data,
                value: '0',
                receiver: aliceBech32
            });

            await expect(Verifier.verify(payload, esdtRequirements)).rejects.toThrow('ESDT token mismatch');
        });
    });
});
