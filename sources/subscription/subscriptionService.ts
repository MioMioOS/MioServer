import { db } from '@/storage/db';
import { config } from '@/config';
import { eventRouter } from '@/socket/socketServer';

export interface AccessCheck {
    allowed: boolean;
    reason: string;
    status: string;
    daysLeft?: number;
    expiresAt?: string; // ISO8601 — only set when access has a finite expiry (trial or redeemed)
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

    // Push to any Mac paired with this iPhone so its inherited-trial banner refreshes.
    await pushSubscriptionToLinkedMacs(deviceId);
}

/**
 * Find the longest still-valid trialExpiresAt among iPhones linked to the
 * given Mac via DeviceLink. Used by checkAccess() to let Macs inherit trial
 * state from any iPhone they're paired with. Returns null if there's no link
 * or no eligible iPhone trial.
 */
async function getLongestLinkedPhoneTrial(macDeviceId: string): Promise<Date | null> {
    const links = await db.deviceLink.findMany({
        where: {
            OR: [
                { sourceDeviceId: macDeviceId },
                { targetDeviceId: macDeviceId },
            ],
        },
        select: { sourceDeviceId: true, targetDeviceId: true },
    });
    if (links.length === 0) return null;

    const peerIds = links.map((l) =>
        l.sourceDeviceId === macDeviceId ? l.targetDeviceId : l.sourceDeviceId
    );

    const longest = await db.device.findFirst({
        where: {
            id: { in: peerIds },
            kind: 'ios',
            subscriptionStatus: { in: ['active', 'trial'] },
            trialExpiresAt: { gt: new Date() },
        },
        select: { trialExpiresAt: true },
        orderBy: { trialExpiresAt: 'desc' },
    });

    return longest?.trialExpiresAt ?? null;
}

/**
 * When an iPhone's subscription state changes (redeem, IAP, trial start,
 * unpair, refund), notify all Macs paired to that iPhone so they can refresh
 * their inherited-trial banner without polling.
 *
 * For each linked Mac we compute its EFFECTIVE post-change state via
 * checkAccess() and emit that — not just the iPhone's raw state — so the Mac
 * sees the right number even when multiple linked iPhones contribute.
 *
 * Best-effort: errors are swallowed (don't break the parent action that
 * triggered this push).
 */
export async function pushSubscriptionToLinkedMacs(phoneDeviceId: string): Promise<void> {
    try {
        const links = await db.deviceLink.findMany({
            where: {
                OR: [
                    { sourceDeviceId: phoneDeviceId },
                    { targetDeviceId: phoneDeviceId },
                ],
            },
            select: { sourceDeviceId: true, targetDeviceId: true },
        });

        for (const link of links) {
            const peerId =
                link.sourceDeviceId === phoneDeviceId ? link.targetDeviceId : link.sourceDeviceId;
            const peer = await db.device.findUnique({
                where: { id: peerId },
                select: { kind: true },
            });
            if (peer?.kind !== 'mac') continue;

            const access = await checkAccess(peerId);
            const source =
                access.reason === 'inherited_from_phone'
                    ? 'inherited'
                    : access.reason === 'mac_redeemed'
                      ? 'redeem_code'
                      : null;
            eventRouter.emitToDevice(peerId, 'subscription-updated', {
                status: access.status,
                expiresAt: access.expiresAt ?? null,
                source,
                daysLeft: access.daysLeft ?? null,
            });
        }
    } catch (err) {
        console.error(`[subscription] pushSubscriptionToLinkedMacs failed for ${phoneDeviceId}:`, err);
    }
}

/** Check whether a device is allowed to use the service. */
export async function checkAccess(deviceId: string): Promise<AccessCheck> {
    if (!config.enforceSubscription) {
        return { allowed: true, reason: 'subscription_not_enforced', status: 'none' };
    }

    const device = await db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
        return { allowed: false, reason: 'device_not_found', status: 'none' };
    }

    if (device.kind === 'mac') {
        // Mac is always allowed access (the gate is on iPhones).
        // What status the Mac surfaces:
        //   1. Mac's own active trial (set by /v1/pairing/redeem-code), OR
        //   2. The longest valid trial among all paired iPhones (inheritance).
        // We pick whichever runs longer. This avoids the product red line where
        // an iPhone with 14 days paired to a Mac with no trial would surface as
        // "未激活" on the Mac while iPhone shows "试用 14 天" — same user,
        // same server, two different numbers.
        const now = new Date();
        let bestExpiry: Date | null = null;
        let inheritedFromPhone = false;

        // 1. Mac's own active trial (if not yet expired).
        if (device.subscriptionStatus === 'active' && device.trialExpiresAt) {
            if (device.trialExpiresAt > now) {
                bestExpiry = device.trialExpiresAt;
            } else {
                // Lapsed self-trial — housekeeping flip. Doesn't affect access
                // because Mac is always allowed; just keeps the row honest.
                await db.device.updateMany({
                    where: { id: deviceId, subscriptionStatus: 'active' },
                    data: { subscriptionStatus: 'expired' },
                });
            }
        }

        // 2. Linked iPhone fallback / extension. Always probe — even if Mac has
        // its own trial — so a longer iPhone trial wins when present.
        const inheritedExpiry = await getLongestLinkedPhoneTrial(deviceId);
        if (inheritedExpiry && (!bestExpiry || inheritedExpiry > bestExpiry)) {
            bestExpiry = inheritedExpiry;
            inheritedFromPhone = true;
        }

        if (bestExpiry) {
            const msLeft = bestExpiry.getTime() - now.getTime();
            const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
            return {
                allowed: true,
                reason: inheritedFromPhone ? 'inherited_from_phone' : 'mac_redeemed',
                status: 'trial',
                daysLeft,
                expiresAt: bestExpiry.toISOString(),
            };
        }
        return { allowed: true, reason: 'mac_device', status: 'none' };
    }

    if (device.subscriptionStatus === 'active') {
        // 兑换码用户有到期时间，永久付费用户没有
        if (device.trialExpiresAt) {
            const now = new Date();
            if (device.trialExpiresAt > now) {
                const msLeft = device.trialExpiresAt.getTime() - now.getTime();
                const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
                return { allowed: true, reason: 'redeemed', status: 'active', daysLeft, expiresAt: device.trialExpiresAt.toISOString() };
            }
            // 兑换码到期
            await db.device.updateMany({
                where: { id: deviceId, subscriptionStatus: 'active' },
                data: { subscriptionStatus: 'expired' },
            });
            return { allowed: false, reason: 'access_expired', status: 'expired' };
        }
        return { allowed: true, reason: 'paid', status: 'active' };
    }

    if (device.subscriptionStatus === 'trial' && device.trialExpiresAt) {
        const now = new Date();
        if (device.trialExpiresAt > now) {
            const msLeft = device.trialExpiresAt.getTime() - now.getTime();
            const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
            return { allowed: true, reason: 'trial', status: 'trial', daysLeft, expiresAt: device.trialExpiresAt.toISOString() };
        }
        // FIX #4: 加条件防止竞态，只更新仍为 trial 状态的记录
        await db.device.updateMany({
            where: { id: deviceId, subscriptionStatus: 'trial' },
            data: { subscriptionStatus: 'expired' },
        });
        return { allowed: false, reason: 'trial_expired', status: 'expired' };
    }

    if (device.subscriptionStatus === 'none') {
        return { allowed: false, reason: 'no_subscription', status: 'none' };
    }

    return { allowed: false, reason: device.subscriptionStatus, status: device.subscriptionStatus };
}

/**
 * Verify payment from StoreKit 2 and activate the device.
 *
 * FIX #2: 调用 Apple App Store Server API 验证 transactionId 真实性。
 * 如果 APPLE_ISSUER_ID 未配置，退化为信任客户端（适用于开发/测试阶段）。
 */
export async function verifyPayment(
    deviceId: string,
    originalTransactionId: string
): Promise<{ success: boolean; status: string; error?: string }> {
    // Fail-closed: production enforcement requires Apple API keys.
    // Without them a jailbroken client could fake any transactionId.
    if (config.appleApiKeyId) {
        const isValid = await verifyWithApple(originalTransactionId);
        if (!isValid) {
            console.warn(`[subscription] Apple verification failed for txn=${originalTransactionId}`);
            return { success: false, status: 'invalid', error: 'apple_verification_failed' };
        }
    } else if (config.enforceSubscription) {
        console.error('[subscription] APPLE_API_KEY_ID not configured but ENFORCE_SUBSCRIPTION=true — rejecting payment to prevent bypass');
        return { success: false, status: 'invalid', error: 'server_misconfigured' };
    } else {
        console.warn('[subscription] APPLE_API_KEY_ID not set, skipping Apple verification (dev/self-hosted mode)');
    }

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

    await db.device.update({
        where: { id: deviceId },
        data: {
            subscriptionStatus: 'active',
            trialExpiresAt: null,  // clear trial expiry — paid users have permanent access
        },
    });

    console.log(`[subscription] Payment verified for device ${deviceId}, txn=${originalTransactionId}`);

    // Push to linked Macs — note paid users have null trialExpiresAt so Mac
    // inherited banner won't show "trial" anymore (Mac shows nothing for
    // permanent paid status, which is correct since Mac has no IAP concept).
    await pushSubscriptionToLinkedMacs(deviceId);

    return { success: true, status: 'active' };
}

/**
 * 调用 Apple App Store Server API 验证 transaction。
 * 需要环境变量: APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_PRIVATE_KEY
 * 参考: https://developer.apple.com/documentation/appstoreserverapi
 */
async function verifyWithApple(originalTransactionId: string): Promise<boolean> {
    try {
        const { SignJWT, importPKCS8 } = await import('jose');

        const keyId = config.appleApiKeyId!;
        const issuerId = config.appleApiIssuerId!;
        const privateKeyBase64 = config.appleApiPrivateKey!;

        // 构建 JWT token 用于 Apple API 认证
        const privateKeyPem = Buffer.from(privateKeyBase64, 'base64').toString('utf-8');
        const key = await importPKCS8(privateKeyPem, 'ES256');

        const token = await new SignJWT({})
            .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
            .setIssuer(issuerId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .setAudience('appstoreconnect-v1')
            .sign(key);

        const isProduction = process.env.NODE_ENV === 'production';
        const baseUrl = isProduction
            ? 'https://api.storekit.itunes.apple.com'
            : 'https://api.storekit-sandbox.itunes.apple.com';

        const response = await fetch(
            `${baseUrl}/inApps/v1/transactions/${originalTransactionId}`,
            {
                headers: { Authorization: `Bearer ${token}` },
            }
        );

        if (response.status === 200) {
            console.log(`[subscription] Apple API confirmed txn=${originalTransactionId}`);
            return true;
        }

        console.warn(`[subscription] Apple API rejected txn=${originalTransactionId}, status=${response.status}`);
        return false;
    } catch (err) {
        console.error(`[subscription] Apple API verification error:`, err);
        return false;
    }
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

    const deviceIds = subscription.devices.map(d => d.deviceId);
    if (deviceIds.length > 0) {
        await db.device.updateMany({
            where: { id: { in: deviceIds }, subscriptionStatus: 'active' },
            data: { subscriptionStatus: 'expired' },
        });

        // Notify and disconnect any currently connected sockets
        for (const deviceId of deviceIds) {
            eventRouter.emitToDevice(deviceId, 'subscription-required', {
                reason: 'revoked',
                status: 'expired',
            });
            // Push to linked Macs so their inherited-trial banner clears.
            await pushSubscriptionToLinkedMacs(deviceId);
        }
    }

    console.log(`[subscription] Revoked txn=${originalTransactionId}, affected ${deviceIds.length} devices`);
    return deviceIds.length;
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

/**
 * Find devices whose trial expires within 24h and haven't been notified yet
 * (or were last notified >23h ago). Marks them as notified atomically to
 * prevent sending 48 pushes over the 24h window.
 */
export async function findExpiringTrials(): Promise<Array<{ id: string; trialExpiresAt: Date }>> {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const notifyThreshold = new Date(now.getTime() - 23 * 60 * 60 * 1000);

    const devices = await db.device.findMany({
        where: {
            subscriptionStatus: 'trial',
            trialExpiresAt: { gte: now, lte: in24h },
            OR: [
                { trialExpireNotifiedAt: null },
                { trialExpireNotifiedAt: { lt: notifyThreshold } },
            ],
        },
        select: { id: true, trialExpiresAt: true },
    });

    const eligible = devices.filter((d): d is { id: string; trialExpiresAt: Date } =>
        d.trialExpiresAt !== null
    );

    if (eligible.length > 0) {
        await db.device.updateMany({
            where: { id: { in: eligible.map(d => d.id) } },
            data: { trialExpireNotifiedAt: now },
        });
    }

    return eligible;
}
