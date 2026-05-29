import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import jwt from 'jsonwebtoken';

const { decodeBase64 } = tweetnaclUtil;

export function verifySignature(
    messageBase64: string,
    signatureBase64: string,
    publicKeyBase64: string
): boolean {
    try {
        const message = decodeBase64(messageBase64);
        const signature = decodeBase64(signatureBase64);
        const publicKey = decodeBase64(publicKeyBase64);
        return nacl.sign.detached.verify(message, signature, publicKey);
    } catch {
        return false;
    }
}

export interface TokenPayload {
    deviceId: string;
    /**
     * Slice 7 (A5): the user identity this device is bound to at the moment
     * the JWT was minted. Optional in the type to keep `verifyToken` backwards-
     * compatible with legacy tokens that pre-date Slice 7 (those tokens are
     * still cryptographically valid until they naturally expire — they simply
     * lack `userId`, and downstream code must treat that as "user unknown,
     * device-only auth"). Newly-minted tokens always include it.
     */
    userId?: string;
    iat?: number;
}

export function createToken(
    deviceId: string,
    userId: string,
    secret: string,
    expiryDays: number = 30,
): string {
    return jwt.sign({ deviceId, userId }, secret, { expiresIn: `${expiryDays}d` });
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
    try {
        return jwt.verify(token, secret) as TokenPayload;
    } catch {
        return null;
    }
}
