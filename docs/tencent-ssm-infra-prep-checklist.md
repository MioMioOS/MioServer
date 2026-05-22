# Tencent SSM Infra Prep Checklist (#73)

Status: operator checklist for Laurent / Tencent Cloud console owner.
Scope: prepare Tencent Cloud Secrets Manager (SSM) so MioServer can later run a real production `SsmCredentialStore` adapter.
Non-goals: implement the adapter, paste secret values into Slock, or change `mio.wdao.chat` production env today.

## 0. Current Guardrail

MioServer currently starts safely only when `CREDENTIAL_STORE_PROVIDER` is unset. Do not set it to `ssm` until the adapter exists and has been tested, because the current factory intentionally throws `not_implemented` for `ssm/kms/vault`.

This checklist only prepares cloud-side resources. It should not change the running server behavior.

## 1. Decisions Laurent Must Make

| Item | Recommended value | Why |
|---|---|---|
| Tencent Cloud region | Use the same region as the current CVM / Postgres box, unless Ops says otherwise | Avoid cross-region latency and policy confusion |
| SSM provider | Tencent Cloud Secrets Manager (SSM) | Matches current Tencent deployment; no KEK on box |
| Auth model | CVM-bound CAM role with read-only SSM policy | Avoids long-lived SecretId/SecretKey on the box |
| First secret kind | Harmless smoke-test credential only | Proves SSM read path before any real production credential |
| Secret value sharing | Never in Slock/public chat | Only secret names, regions, role names, and verification status are shared |

## 2. Create the Smoke-Test Secret

In Tencent Cloud Console:

1. Open Secrets Manager / SSM.
2. Activate the service if it is not already active.
3. Create one user-defined secret for the smoke test.

Recommended name:

```text
mio/prod/smoke/credential-store-read-test
```

Recommended content:

```json
{
  "purpose": "mio-credential-store-smoke",
  "created_by": "laurent",
  "value": "<random-high-entropy-test-string>"
}
```

Rules:

- This is a test secret, not a real API credential.
- Do not paste the secret value in `#slockai`.
- Record only the non-secret locator: region + secret name + version label.
- Use the active version label expected by Tencent SSM, normally `SSM_Current`.

## 3. Create the Read-Only CAM Policy

Create a custom CAM policy for the box role. Keep it read-only and scoped to the smoke secret first.

Policy intent:

- Allow `ssm:GetSecretValue` on the smoke secret.
- Optionally allow read-only describe/list actions only if the SDK or Ops verification needs them.
- Deny all create/update/delete/rotation actions by omission.

Template to adapt in the CAM policy editor:

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "ssm:GetSecretValue"
      ],
      "resource": [
        "qcs::ssm:<REGION>:uin/<ACCOUNT_UIN>:secret/creatorUin/<CREATOR_UIN>/mio/prod/smoke/credential-store-read-test"
      ]
    }
  ]
}
```

If Tencent Console rejects the exact resource string, use the console's generated resource selector for that secret and keep the action set unchanged. Do not broaden to `ssm:*`.

## 4. Bind Auth to the Prod Box

Preferred path:

1. Create a CAM role for CVM access, for example:

```text
MioServerSsmReadOnlyRole
```

2. Attach the read-only SSM policy from section 3.
3. Bind/modify the role on the CVM instance that runs `mio.wdao.chat`.
4. Do not create persistent SecretId/SecretKey if the CVM role works.

Fallback only if CVM role is impossible:

- Create a dedicated sub-account / CAM user with only the same read-only policy.
- Generate an access key only for that user.
- Deliver it to @运维 by an agreed private channel, never in `#slockai`.
- Plan immediate rotation/removal after the SSM adapter test.

## 5. What To Give @运维

Send only non-secret setup details in `#slockai` or the task thread:

```text
SSM prep done:
- region: <REGION>
- secret name: mio/prod/smoke/credential-store-read-test
- version: SSM_Current
- auth: CVM role <ROLE_NAME> bound to box <INSTANCE_ID>
- policy: read-only GetSecretValue scoped to this secret
```

If using fallback access keys, do not post the key. Tell @运维 which private channel contains it.

## 6. Ops Verification Checklist

@运维 should verify from the prod box, without printing the secret value publicly:

1. Confirm the instance can obtain Tencent Cloud credentials from the bound role, or that the fallback credential file exists with `0600` permissions.
2. Run a read of the smoke secret using Tencent CLI/SDK or a one-off Node script.
3. Print only:
   - success/failure;
   - secret name and version;
   - value length;
   - optional SHA-256 prefix of the smoke value for private comparison.
4. Confirm CloudAudit / SSM access log shows `GetSecretValue` from the expected role/user.
5. Leave `CREDENTIAL_STORE_PROVIDER` unset until the `SsmCredentialStore` adapter lands.

## 7. Acceptance Criteria For #73

Task #73 is unblocked when all of these are true:

- SSM service is active in the chosen region.
- Smoke secret exists and has an active version.
- A CVM-bound role or narrowly scoped fallback credential can call `GetSecretValue` for only that secret.
- The box has no broad SSM admin permission.
- No secret value was posted in Slock, committed to git, or placed in `.env`.
- @运维 has enough non-secret locator information to implement/test the adapter.

## 8. Anti-Patterns To Avoid

- Do not set `CREDENTIAL_STORE_PROVIDER=ssm` on prod before the adapter is implemented.
- Do not use `fixture` or `aesfile` in production.
- Do not put a KEK or SSM secret value in `.env`.
- Do not grant `ssm:*` to the box.
- Do not share SecretId/SecretKey or secret plaintext in public Slock channels.
- Do not start with real production credentials; prove the path with the smoke secret first.

## References

- [Tencent Cloud Secrets Manager product docs](https://www.tencentcloud.com/product/ssm): SSM stores/retrieves credentials, integrates with CAM, supports resource-level access authorization, and integrates with CloudAudit.
- [Tencent Cloud `GetSecretValue` API docs](https://www.tencentcloud.com/document/api/1078/38649): retrieves plaintext by secret name and version; the current version label is `SSM_Current`.
- [Tencent Cloud CVM instance role docs](https://www.tencentcloud.com/document/product/213/45917): CVM-bound CAM roles use periodically refreshed STS temporary credentials, avoiding persistent SecretId/SecretKey on the instance.
