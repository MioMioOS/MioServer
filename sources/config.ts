export const config = {
    port: parseInt(process.env.PORT || '3005', 10),
    masterSecret: process.env.MASTER_SECRET || '',
    databaseUrl: process.env.DATABASE_URL || '',
    tokenExpiryDays: parseInt(process.env.TOKEN_EXPIRY_DAYS || '30', 10),
    // Subscription / trial
    trialDays: parseInt(process.env.TRIAL_DAYS || '3', 10),
    maxConcurrentDevices: parseInt(process.env.MAX_CONCURRENT_DEVICES || '1', 10),
    enforceSubscription: process.env.ENFORCE_SUBSCRIPTION !== 'false', // default true
} as const;
