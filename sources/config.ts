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
    // #164: server-assist LLM explanation layer feature gate. Phase 1 = a SERVER CONFIG gate
    // (NOT per-org; per-org opt-in is a later DB-field upgrade). Default OFF.
    serverLlmExplanationEnabled: process.env.SERVER_LLM_EXPLANATION_ENABLED === 'true',
    // #169: 豆包 (Volcengine Ark) explanation provider config. The adapter is only constructed when
    // BOTH key AND model are set (getDoubaoProvider returns null otherwise → deterministic fallback,
    // so the default-OFF safety of #164 is preserved even if the feature flag is on but unconfigured).
    // SECURITY: doubaoApiKey is a low-privilege EXPLANATION-model key (NOT Claude/Codex execution
    // creds). Phase 1 reads it from env for pragmatism; long-term it should move off the .env/DB-dump
    // surface (like the credential-store KEK). It must NEVER appear in any response or log.
    doubaoApiKey: process.env.DOUBAO_API_KEY || '',
    doubaoBaseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    doubaoModel: process.env.DOUBAO_MODEL || '', // ep-xxx endpoint id or model name (e.g. doubao-lite-4k)
    doubaoMaxTokens: parseInt(process.env.DOUBAO_MAX_TOKENS || '120', 10), // explanation = short; cap cost
    doubaoTimeoutMs: parseInt(process.env.DOUBAO_TIMEOUT_MS || '6000', 10),
    // #169 eval finding: Doubao-Seed-2.0 models are reasoning ("深度思考") models — by default they
    // emit reasoning_content and take ~2.9s. Disabling thinking drops latency to ~1.0s with 0 reasoning
    // tokens (cost), and the explanation task needs no chain-of-thought. Default ON (disable thinking).
    doubaoDisableThinking: process.env.DOUBAO_DISABLE_THINKING !== 'false',
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
