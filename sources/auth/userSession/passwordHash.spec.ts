import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './passwordHash';

describe('passwordHash', () => {
    it('hashes and verifies a known password', async () => {
        const h = await hashPassword('correcthorsebatterystaple');
        expect(h).toMatch(/^\$2[aby]\$/);                       // bcrypt prefix
        expect(await verifyPassword('correcthorsebatterystaple', h)).toBe(true);
    });
    it('rejects wrong password', async () => {
        const h = await hashPassword('a');
        expect(await verifyPassword('b', h)).toBe(false);
    });
    it('uses cost factor >= 12', async () => {
        const h = await hashPassword('x');
        expect(h.split('$')[2]).toBe('12');                     // bcrypt-cost segment
    });
});
