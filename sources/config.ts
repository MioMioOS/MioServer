export const config = {
    port: parseInt(process.env.PORT || '3005', 10),
    // Bind address. Default '0.0.0.0' (all interfaces) for local dev.
    // Set HOST=127.0.0.1 in production when behind nginx to avoid direct
    // public access on the port (defense-in-depth beyond cloud SG rules).
    host: process.env.HOST ?? '0.0.0.0',
    masterSecret: process.env.MASTER_SECRET || '',
    databaseUrl: process.env.DATABASE_URL || '',
    tokenExpiryDays: parseInt(process.env.TOKEN_EXPIRY_DAYS || '30', 10),
    // Subscription / trial
    trialDays: parseInt(process.env.TRIAL_DAYS || '3', 10),
    maxConcurrentDevices: parseInt(process.env.MAX_CONCURRENT_DEVICES || '1', 10),
    enforceSubscription: process.env.ENFORCE_SUBSCRIPTION !== 'false', // default true
    // Apple App Store Server API (用于验证 transactionId 真实性)
    appleApiKeyId: process.env.APPLE_API_KEY_ID || '',
    appleApiIssuerId: process.env.APPLE_API_ISSUER_ID || '',
    appleApiPrivateKey: process.env.APPLE_API_PRIVATE_KEY || '', // base64-encoded .p8
    // 退款回调共享密钥（防伪造）
    revokeSharedSecret: process.env.REVOKE_SHARED_SECRET || '',
    // CredentialStore selection (#72/#75). These are NON-secret selectors only.
    // The AesFile KEK is NEVER here (and never in .env) — it is loaded from the OS Keychain
    // at bootstrap (invariant 5: KEK must not share the .env/DB dump surface).
    // Unset provider → no store provisioned → consume route fail-safe to needs_human.
    credentialStoreProvider: (process.env.CREDENTIAL_STORE_PROVIDER ?? '').trim(),
    credentialStoreAesFilePath: (process.env.CREDENTIAL_STORE_AESFILE_PATH ?? '').trim(),
} as const;
