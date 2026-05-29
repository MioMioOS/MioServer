import fastify from 'fastify';
import cors from '@fastify/cors';
import {
    serializerCompiler,
    validatorCompiler,
    type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { authRoutes } from '@/auth/authRoutes';
import { userSessionRoutes } from '@/auth/userSession/userSessionRoutes';
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
import { channelRoutes } from '@/control/channels/channelRoutes';
import { messageRoutes } from '@/control/messages/messageRoutes';
import { memberRoutes } from '@/control/members/memberRoutes';
import { agentRoutes } from '@/control/agents/agentRoutes';
import { searchRoutes } from '@/control/search/searchRoutes';
import { taskRoutes } from '@/control/tasks/taskRoutes';
import { slockTaskRoutes } from '@/control/tasks/slockTaskRoutes';
import { actionRoutes } from '@/control/actions/actionRoutes';
import { eventRoutes } from '@/control/events/eventRoutes';
import { artifactRoutes } from '@/control/artifacts/artifactRoutes';
import { summaryRoutes } from '@/control/workrooms/summaryRoutes';
import { workspaceMembershipRoutes } from '@/control/workrooms/workspaceMembershipRoutes';
import { friendRoutes } from '@/control/friends/friendRoutes';
import { sessionRoutes as controlSessionRoutes } from '@/control/sessions/sessionRoutes';
import { operatorWriteRoutes } from '@/control/operatorSessions/operatorWriteRoutes';
import { machineEnrollmentRoutes } from '@/control/operatorSessions/machineEnrollmentRoutes';
import { explanationRoutes } from '@/control/llm/explanationRoutes';
import { agentApiRoutes } from '@/control/agentApi/agentApiRoutes';
import { agentApiTasks } from '@/control/agentApi/agentApiTasks';
import { agentApiReminders } from '@/control/agentApi/agentApiReminders';
import { agentApiChannels } from '@/control/agentApi/agentApiChannels';
import { agentApiReactions } from '@/control/agentApi/agentApiReactions';
import { agentApiAttachments } from '@/control/attachments/agentApiAttachments';
import { userAttachments } from '@/control/attachments/userAttachments';
import { agentApiPreparedActions } from '@/control/actions/agentApiPreparedActions';
import { preparedActionOperatorRoutes } from '@/control/actions/preparedActionOperatorRoutes';
import { agentApiProfile } from '@/control/profile/agentApiProfile';
import { agentApiTyping } from '@/control/agentApi/agentApiTyping';
import { agentApiStatus } from '@/control/agentApi/agentApiStatus';
import { agentApiThreads } from '@/control/agentApi/agentApiThreads';
import { registerEmptyJsonBodyParser } from '@/jsonBodyParser';
import { provisionCredentialStore } from '@/control/credentials/provisionCredentialStore';
import { config } from '@/config';

export async function startApi() {
    const app = fastify({
        bodyLimit: 10 * 1024 * 1024,
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // #156: accept an empty application/json body as {} (clients needn't send a literal `{}`).
    registerEmptyJsonBodyParser(app);

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
    await app.register(userSessionRoutes);
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
    await app.register(workspaceMembershipRoutes);
    await app.register(channelRoutes);
    await app.register(friendRoutes);
    await app.register(messageRoutes);
    await app.register(memberRoutes);
    await app.register(agentRoutes);
    await app.register(searchRoutes);
    await app.register(taskRoutes);
await app.register(slockTaskRoutes);
    await app.register(actionRoutes, { credentialStore });
    await app.register(operatorWriteRoutes);
    await app.register(machineEnrollmentRoutes);
    await app.register(explanationRoutes);
    await app.register(eventRoutes);
    await app.register(artifactRoutes);
    await app.register(summaryRoutes);
    await app.register(controlSessionRoutes);
    await app.register(agentApiRoutes);
    await app.register(agentApiTasks);
    await app.register(agentApiReminders);
    await app.register(agentApiChannels);
    await app.register(agentApiReactions);
    await app.register(agentApiAttachments);
    await app.register(userAttachments);
    await app.register(agentApiPreparedActions);
    await app.register(preparedActionOperatorRoutes);
    await app.register(agentApiProfile);
    await app.register(agentApiTyping);
    await app.register(agentApiStatus);
    await app.register(agentApiThreads);

    await app.listen({ port: config.port, host: config.host });
    console.log(`CodeLight Server listening on port ${config.port}`);

    return app;
}
