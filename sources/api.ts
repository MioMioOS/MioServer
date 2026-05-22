import fastify from 'fastify';
import cors from '@fastify/cors';
import {
    serializerCompiler,
    validatorCompiler,
    type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { authRoutes } from '@/auth/authRoutes';
import { pairingRoutes } from '@/pairing/pairingRoutes';
import { devicesRoutes } from '@/devices/devicesRoutes';
import { sessionRoutes } from '@/session/sessionRoutes';
import { pushRoutes } from '@/push/pushRoutes';
import { blobRoutes } from '@/blob/blobRoutes';
import { capabilityRoutes } from '@/capabilities/capabilityRoutes';
import { subscriptionRoutes } from '@/subscription/subscriptionRoutes';
import { redeemRoutes } from '@/subscription/redeemRoutes';
import { pagesRoutes } from '@/pages/pagesRoutes';
// Control plane — machine registration + workroom/task/action/event/artifact APIs
import { machineRoutes } from '@/machines/machineRoutes';
import { workroomRoutes } from '@/control/workrooms/workroomRoutes';
import { taskRoutes } from '@/control/tasks/taskRoutes';
import { actionRoutes } from '@/control/actions/actionRoutes';
import { eventRoutes } from '@/control/events/eventRoutes';
import { artifactRoutes } from '@/control/artifacts/artifactRoutes';
import { summaryRoutes } from '@/control/workrooms/summaryRoutes';
import { sessionRoutes as controlSessionRoutes } from '@/control/sessions/sessionRoutes';
import { operatorWriteRoutes } from '@/control/operatorSessions/operatorWriteRoutes';
import { provisionCredentialStore } from '@/control/credentials/provisionCredentialStore';
import { config } from '@/config';

export async function startApi() {
    const app = fastify({
        bodyLimit: 10 * 1024 * 1024,
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(cors, {
        origin: '*',
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    // Request logging
    app.addHook('onRequest', async (request) => {
        console.log(`${request.method} ${request.url}`);
    });

    app.get('/health', async () => ({ status: 'ok' }));

    // CredentialStore (#75): provision ONCE at bootstrap, fail-closed. If CREDENTIAL_STORE_PROVIDER
    // is unset the result is undefined and the consume route fail-safes to needs_human (no store =
    // no resolution, never a fake success). If a provider is set but invalid for the env / not yet
    // implemented (ssm/kms/vault, blocked on #73) / missing its Keychain KEK (aesfile), this throws
    // here and the server refuses to start — it never serves requests with a half-broken store.
    const credentialStore = provisionCredentialStore();

    await app.register(authRoutes);
    await app.register(pairingRoutes);
    await app.register(devicesRoutes);
    await app.register(sessionRoutes);
    await app.register(pushRoutes);
    await app.register(blobRoutes);
    await app.register(capabilityRoutes);
    await app.register(subscriptionRoutes);
    await app.register(redeemRoutes);
    await app.register(pagesRoutes);
    // Control plane routes
    await app.register(machineRoutes);
    await app.register(workroomRoutes);
    await app.register(taskRoutes);
    await app.register(actionRoutes, { credentialStore });
    await app.register(operatorWriteRoutes);
    await app.register(eventRoutes);
    await app.register(artifactRoutes);
    await app.register(summaryRoutes);
    await app.register(controlSessionRoutes);

    await app.listen({ port: config.port, host: config.host });
    console.log(`CodeLight Server listening on port ${config.port}`);

    return app;
}
