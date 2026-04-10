import { db } from '@/storage/db';
import { config } from '@/config';

export interface AccessCheck {
    allowed: boolean;
    reason: string;
    status: string;
    daysLeft?: number;
}

/** Start a 3-day trial for an iOS device. No-op if already trialing or paid. */
export async function startTrial(deviceId: string): Promise<void> {
    const device = await db.device.findUnique({ where: { id: deviceId } });
    if (!device || device.subscriptionStatus !== 'none') return;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.trialDays * 24 * 60 * 60 * 1000);

    await db.device.update({
        where: { id: deviceId },
        data: {
            subscriptionStatus: 'trial',
            trialStartedAt: now,
            trialExpiresAt: expiresAt,
        },
    });

    console.log(`[subscription] Trial started for device ${deviceId}, expires ${expiresAt.toISOString()}`);
}

/** Check whether a device is allowed to use the service. */
export async function checkAccess(deviceId: string): Promise<AccessCheck> {
    // Self-hosted servers skip all checks
    if (!config.enforceSubscription) {
        return { allowed: true, reason: 'subscription_not_enforced', status: 'none' };
    }

    const device = await db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
        return { allowed: false, reason: 'device_not_found', status: 'none' };
    }

    // Mac devices never need subscription
    if (device.kind === 'mac') {
        return { allowed: true, reason: 'mac_device', status: 'none' };
    }

    // Active (paid) subscription
    if (device.subscriptionStatus === 'active') {
        return { allowed: true, reason: 'paid', status: 'active' };
    }

    // Trial period
    if (device.subscriptionStatus === 'trial' && device.trialExpiresAt) {
        const now = new Date();
        if (device.trialExpiresAt > now) {
            const msLeft = device.trialExpiresAt.getTime() - now.getTime();
            const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
            return { allowed: true, reason: 'trial', status: 'trial', daysLeft };
        }
        // Trial expired — update status
        await db.device.update({
            where: { id: deviceId },
            data: { subscriptionStatus: 'expired' },
        });
        return { allowed: false, reason: 'trial_expired', status: 'expired' };
    }

    // No subscription at all
    if (device.subscriptionStatus === 'none') {
        return { allowed: false, reason: 'no_subscription', status: 'none' };
    }

    // Expired or revoked
    return { allowed: false, reason: device.subscriptionStatus, status: device.subscriptionStatus };
}

/** Verify payment from StoreKit 2 and activate the device. */
export async function verifyPayment(
    deviceId: string,
    originalTransactionId: string
): Promise<{ success: boolean; status: string }> {
    // Upsert subscription record
    const subscription = await db.subscription.upsert({
        where: { originalTransactionId },
        create: {
            originalTransactionId,
            status: 'active',
            paidAt: new Date(),
        },
        update: {
            status: 'active',
            paidAt: new Date(),
            revokedAt: null,
        },
    });

    // Link device to subscription
    await db.subscriptionDevice.upsert({
        where: {
            subscriptionId_deviceId: {
                subscriptionId: subscription.id,
                deviceId,
            },
        },
        create: {
            subscriptionId: subscription.id,
            deviceId,
        },
        update: {},
    });

    // Update device status
    await db.device.update({
        where: { id: deviceId },
        data: { subscriptionStatus: 'active' },
    });

    console.log(`[subscription] Payment verified for device ${deviceId}, txn=${originalTransactionId}`);
    return { success: true, status: 'active' };
}

/** Get the subscription linked to a device (if any). */
export async function getDeviceSubscription(deviceId: string) {
    const link = await db.subscriptionDevice.findFirst({
        where: { deviceId },
        include: { subscription: true },
        orderBy: { createdAt: 'desc' },
    });
    return link?.subscription ?? null;
}

/** Revoke a subscription (App Store refund). Returns number of affected devices. */
export async function revokeSubscription(originalTransactionId: string): Promise<number> {
    const subscription = await db.subscription.findUnique({
        where: { originalTransactionId },
        include: { devices: true },
    });

    if (!subscription) return 0;

    await db.subscription.update({
        where: { id: subscription.id },
        data: { status: 'revoked', revokedAt: new Date() },
    });

    // Mark all linked devices as expired
    const deviceIds = subscription.devices.map(d => d.deviceId);
    if (deviceIds.length > 0) {
        await db.device.updateMany({
            where: { id: { in: deviceIds }, subscriptionStatus: 'active' },
            data: { subscriptionStatus: 'expired' },
        });
    }

    console.log(`[subscription] Revoked txn=${originalTransactionId}, affected ${deviceIds.length} devices`);
    return deviceIds.length;
}

/** Check if trial is expiring within 24 hours (for push notification). */
export async function isTrialExpiringSoon(deviceId: string): Promise<boolean> {
    const device = await db.device.findUnique({ where: { id: deviceId } });
    if (!device || device.subscriptionStatus !== 'trial' || !device.trialExpiresAt) return false;

    const now = new Date();
    const msLeft = device.trialExpiresAt.getTime() - now.getTime();
    return msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000;
}

/** Expire all stale trials. Called from cleanup job. */
export async function expireStaleTrials(): Promise<number> {
    const result = await db.device.updateMany({
        where: {
            subscriptionStatus: 'trial',
            trialExpiresAt: { lt: new Date() },
        },
        data: { subscriptionStatus: 'expired' },
    });
    if (result.count > 0) {
        console.log(`[subscription] Expired ${result.count} stale trials`);
    }
    return result.count;
}

/** Find devices whose trial expires within 24h (for notification). */
export async function findExpiringTrials(): Promise<Array<{ id: string; trialExpiresAt: Date }>> {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const devices = await db.device.findMany({
        where: {
            subscriptionStatus: 'trial',
            trialExpiresAt: { gte: now, lte: in24h },
        },
        select: { id: true, trialExpiresAt: true },
    });
    return devices.filter((d): d is { id: string; trialExpiresAt: Date } => d.trialExpiresAt !== null);
}
