import { defineModel, defineType, relation } from 'tsbouncer';
import { describe, expect, it } from 'vitest';
import { createDefaultAuthz, isPersistent } from '../src/defaults.js';

const model = defineModel({
  types: {
    user: defineType({}),
    doc: defineType({ relations: { owner: relation(['user']) } }),
  },
});

describe('createDefaultAuthz', () => {
  it('uses an in-memory store when no file is given', async () => {
    const authz = createDefaultAuthz({ model });
    expect(isPersistent(authz.store)).toBe(false);
    await authz.grant({ subject: 'user:a', relation: 'owner', resource: 'doc:1' });
    expect(await authz.can('user:a', 'doc.owner', 'doc:1')).toBe(true);
  });

  it('uses a JSON file when one is given', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(
      mkdtempSync(join(tmpdir(), 'tsbouncer-default-')),
      'tsbouncer.json',
    );

    const authz = createDefaultAuthz({ model, file });
    expect(isPersistent(authz.store)).toBe(true);
    await authz.grant({ subject: 'user:a', relation: 'owner', resource: 'doc:1' });

    // A fresh client over the same file sees it.
    const reopened = createDefaultAuthz({ model, file });
    expect(await reopened.can('user:a', 'doc.owner', 'doc:1')).toBe(true);
  });

  it('passes limits through', async () => {
    const authz = createDefaultAuthz({ model, limits: { maxNodes: 1 } });
    const result = await authz.explain({
      subject: 'user:a',
      permission: 'doc.owner',
      resource: 'doc:1',
    });
    expect(result.allowed).toBe(false);
  });
});
