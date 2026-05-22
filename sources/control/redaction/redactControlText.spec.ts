/**
 * redactControlText unit tests (#141).
 * Locks the server-side no-leak patterns (kept in lockstep with CodeLight ControlPlaneRedactor).
 */
import { describe, it, expect } from 'vitest';
import { redactControlText } from './redactControlText';

describe('redactControlText (#141 server-side no-leak)', () => {
  it('passes through null/undefined unchanged', () => {
    expect(redactControlText(null)).toBeNull();
    expect(redactControlText(undefined)).toBeUndefined();
  });

  it('leaves clean text unchanged', () => {
    const s = '上传完成，等待人工确认是否继续分发。';
    expect(redactControlText(s)).toBe(s);
  });

  it('redacts token shapes: dev_ctl_ / op_sess_ / act_tok_', () => {
    expect(redactControlText('t dev_ctl_AbC-123_xyz done')).toBe('t [REDACTED] done');
    expect(redactControlText('op_sess_Zz9-_aaa')).toBe('[REDACTED]');
    expect(redactControlText('act_tok_QQ__--11')).toBe('[REDACTED]');
  });

  it('redacts 64-hex machine token / sha256 shape', () => {
    const hex = 'a'.repeat(64);
    expect(redactControlText(`hash=${hex}!`)).toBe('hash=[REDACTED]!');
    // does not over-match a short hex / git sha (40)
    const sha = 'b'.repeat(40);
    expect(redactControlText(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it('redacts daemon secret file paths (/tmp/mio-* and /var/folders/.../T/mio-*)', () => {
    expect(redactControlText('cleared /tmp/mio-secret-abc.token now')).toBe('cleared [REDACTED] now');
    expect(redactControlText('rm /var/folders/zz/qm0n/T/mio-secret-tmp-abc123 ok')).toBe('rm [REDACTED] ok');
    // a generic non-daemon path is NOT a secret-shape and is left alone
    const generic = '/Users/demo/project/file.txt';
    expect(redactControlText(generic)).toBe(generic);
  });

  it('redacts PEM blocks, storage_ref, and alias identifiers', () => {
    expect(redactControlText('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----')).toBe('[REDACTED]');
    expect(redactControlText('"storage_ref":"ssm://x/y"')).toContain('[REDACTED]');
    expect(redactControlText('alias:vercel_token')).toBe('[REDACTED]');
  });

  it('redacts the seed fixture sample (fake dev_ctl_ + daemon path) fully', () => {
    const s = '已轮换调试 token dev_ctl_FAKE0000000000000000000000000000 并清理 /var/folders/zz/qm0n/T/mio-secret-tmp-abc123，等待复核。';
    const out = redactControlText(s);
    expect(out).not.toContain('dev_ctl_FAKE');
    expect(out).not.toContain('/var/folders');
    expect(out).toContain('[REDACTED]');
  });
});
