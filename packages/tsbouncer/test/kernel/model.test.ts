import { describe, expect, it } from 'vitest';
import { ModelDefinitionError } from '../../src/kernel/errors.js';
import { createAuthz, type Tuple } from '../../src/kernel/index.js';
import {
  defineCondition,
  defineModel,
  defineType,
  permission,
  permissionsOf,
  relation,
  relationsOf,
  ttu,
  typeNames,
  wildcard,
} from '../../src/kernel/model.js';
import { testStore } from './store.js';

const base = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    folder: defineType({
      relations: { viewer: relation(['user', 'team']) },
      permissions: { read: permission.or('viewer') },
    }),
    document: defineType({
      relations: {
        owner: relation(['user']),
        editor: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', ttu('parent', 'read')),
        write: permission.allOf('owner', 'editor').except('banned'),
      },
    }),
  },
});

describe('defineModel', () => {
  it('builds a model with every declared type', () => {
    expect(Object.keys(base.types).sort()).toEqual([
      'document',
      'folder',
      'team',
      'user',
    ]);
  });

  it('keeps relations and permissions separate', () => {
    expect(Object.keys(base.types.document?.relations ?? {})).toEqual([
      'owner',
      'editor',
      'parent',
      'banned',
    ]);
    expect(Object.keys(base.types.document?.permissions ?? {})).toEqual([
      'read',
      'write',
    ]);
  });

  it('expands a multi-type relation into a union of direct nodes', () => {
    expect(base.types.folder?.relations.viewer).toEqual({
      kind: 'union',
      children: [
        { kind: 'direct', type: 'user', wildcard: false },
        { kind: 'direct', type: 'team', wildcard: false },
      ],
    });
  });

  it('represents a through-relation as a userset node', () => {
    expect(base.types.document?.relations.editor).toEqual({
      kind: 'union',
      children: [
        { kind: 'direct', type: 'user', wildcard: false },
        { kind: 'userset', type: 'team', relation: 'member' },
      ],
    });
  });

  it('represents a chained rewrite as nested binary nodes', () => {
    expect(base.types.document?.permissions.write).toEqual({
      kind: 'exclusion',
      base: {
        kind: 'intersection',
        children: [
          { kind: 'computed', name: 'owner' },
          { kind: 'computed', name: 'editor' },
        ],
      },
      subtract: { kind: 'computed', name: 'banned' },
    });
  });

  it('records tuple-to-userset as a ttu node', () => {
    const read = base.types.document?.permissions.read;
    expect(read).toMatchObject({
      kind: 'union',
      children: expect.arrayContaining([
        { kind: 'ttu', through: 'parent', target: 'read' },
      ]),
    });
  });

  it('freezes the model', () => {
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.types)).toBe(true);
  });

  it('accepts a model with no relations at all', () => {
    expect(() => defineModel({ types: { user: defineType({}) } })).not.toThrow();
  });
});

describe('defineModel validation', () => {
  it('rejects a model with no types', () => {
    expect(() => defineModel({ types: {} })).toThrow(ModelDefinitionError);
  });

  it('rejects a config that forgot the types key', () => {
    expect(() => defineModel({} as unknown as { types: Record<string, never> })).toThrow(
      /at least one type/,
    );
  });

  it('rejects an invalid type name', () => {
    expect(() => defineModel({ types: { Document: defineType({}) } })).toThrow(
      /invalid type name/,
    );
  });

  it('rejects a name declared as both relation and permission', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: { read: relation(['user']) },
            permissions: { read: permission.or('read') },
          }),
        },
      }),
    ).toThrow(/both a relation and a permission/);
  });

  it('rejects a computed reference to an unknown name', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({ permissions: { read: permission.or('nope') } }),
        },
      }),
    ).toThrow(/not a relation or permission/);
  });

  it('rejects a relation to an undeclared subject type', () => {
    expect(() =>
      defineModel({
        types: { doc: defineType({ relations: { owner: relation('user') } }) },
      }),
    ).toThrow(/does not declare/);
  });

  it('rejects a userset naming a relation the target does not have', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          team: defineType({}),
          doc: defineType({
            relations: { owner: relation('team', { through: 'missing' }) },
          }),
        },
      }),
    ).toThrow(/not a relation on/);
  });

  it('rejects a ttu whose target is not on the related type', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          folder: defineType({}),
          doc: defineType({
            relations: { owner: relation(['user']) },
            permissions: { read: permission.or(ttu('owner', 'read')) },
          }),
        },
      }),
    ).toThrow(/neither a relation nor a permission/);
  });

  it('rejects a ttu that traverses a name which is not a relation', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          folder: defineType({ relations: { viewer: relation(['user']) } }),
          doc: defineType({
            relations: { parent: relation('folder') },
            permissions: { read: permission.or(ttu('nope', 'viewer')) },
          }),
        },
      }),
    ).toThrow(/traverses/);
  });

  it('rejects a ttu whose target is not on the related type', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          folder: defineType({}),
          doc: defineType({
            relations: { parent: relation('folder') },
            permissions: { read: permission.or(ttu('parent', 'missing')) },
          }),
        },
      }),
    ).toThrow(/neither a relation nor a permission/);
  });

  it('resolves references to types declared later', () => {
    expect(() =>
      defineModel({
        types: {
          doc: defineType({ relations: { owner: relation('user') } }),
          user: defineType({}),
        },
      }),
    ).not.toThrow();
  });

  it('rejects a userset naming an undeclared type', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: { owner: relation('ghost', { through: 'member' }) },
          }),
        },
      }),
    ).toThrow(/not a declared type/);
  });

  it('rejects a ttu that traverses a userset edge, which yields no object', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          team: defineType({ relations: { member: relation(['user']) } }),
          doc: defineType({
            relations: { via: relation('team', { through: 'member' }) },
            permissions: { read: permission.or(ttu('via', 'member')) },
          }),
        },
      }),
    ).toThrow(/no direct target type/);
  });

  it('accepts a ttu through a multi-type relation', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          folder: defineType({ relations: { viewer: relation(['user']) } }),
          doc: defineType({ relations: { viewer: relation(['user']) } }),
          item: defineType({
            relations: { parent: relation(['folder', 'doc']) },
            permissions: { read: permission.or(ttu('parent', 'viewer')) },
          }),
        },
      }),
    ).not.toThrow();
  });
});

describe('introspection', () => {
  it('lists type names', () => {
    expect(typeNames(base).sort()).toEqual(['document', 'folder', 'team', 'user']);
  });

  it('lists relations of a type', () => {
    expect(relationsOf(base, 'document')).toEqual([
      'owner',
      'editor',
      'parent',
      'banned',
    ]);
  });

  it('lists permissions of a type', () => {
    expect(permissionsOf(base, 'document')).toEqual(['read', 'write']);
  });

  it('returns empty lists for a type with neither', () => {
    expect(relationsOf(base, 'user')).toEqual([]);
    expect(permissionsOf(base, 'user')).toEqual([]);
  });

  it('throws for an unknown type', () => {
    expect(() => relationsOf(base, 'nope')).toThrow(/unknown type/);
    expect(() => permissionsOf(base, 'nope')).toThrow(/unknown type/);
  });
});

describe('cycle detection', () => {
  it('rejects a permission that references itself', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({ permissions: { read: permission.or('read') } }),
        },
      }),
    ).toThrow(/cycle/);
  });

  it('rejects a two-node permission cycle', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            permissions: { read: permission.or('write'), write: permission.or('read') },
          }),
        },
      }),
    ).toThrow(/cycle/);
  });

  it('rejects a cycle that runs through an exclusion branch', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            permissions: {
              read: permission.or('banned'),
              banned: permission.or('read'),
            },
          }),
        },
      }),
    ).toThrow(/cycle/);
  });

  it('allows a diamond, which is not a cycle', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: { owner: relation(['user']), editor: relation(['user']) },
            permissions: {
              read: permission.or('owner', 'editor', 'write'),
              write: permission.allOf('owner', 'editor'),
            },
          }),
        },
      }),
    ).not.toThrow();
  });
});

describe('defineCondition', () => {
  it('registers a named predicate', () => {
    const condition = defineCondition('inRegion', (ctx) => ctx.tier === 'pro');
    const model = defineModel({
      types: { user: {} },
      conditions: { inRegion: condition },
    });
    expect(model.conditions.inRegion?.name).toBe('inRegion');
    expect(model.conditions.inRegion?.predicate({ tier: 'pro' })).toBe(true);
  });

  it('rejects an invalid condition name', () => {
    expect(() => defineCondition('InRegion', () => true)).toThrow(
      /invalid condition name/,
    );
  });

  it('rejects a non-function predicate', () => {
    expect(() => defineCondition('x', 'nope' as unknown as () => boolean)).toThrow(
      /must be a function/,
    );
  });

  it('rejects a condition registered under a mismatched name', () => {
    expect(() =>
      defineModel({
        types: { user: {} },
        conditions: { other: defineCondition('inRegion', () => true) },
      }),
    ).toThrow(/registered under a different name/);
  });
});

describe('builders', () => {
  it('rejects a relation with no types', () => {
    expect(() => relation([])).toThrow(ModelDefinitionError);
  });

  it('rejects a relation given a non-name', () => {
    expect(() => relation(42 as unknown as string)).toThrow(ModelDefinitionError);
  });

  it('nests unions under .or()', () => {
    const node = relation('user').or(relation('user'), relation('user')).node;
    expect(node).toMatchObject({ kind: 'union' });
  });

  it('nests intersections under .and()', () => {
    const node = relation('user').and(relation('user')).node;
    expect(node).toMatchObject({ kind: 'intersection' });
  });

  it('accepts string names in combinators', () => {
    expect(permission.or('owner').and('editor').except('banned').node).toEqual({
      kind: 'exclusion',
      base: {
        kind: 'intersection',
        children: [
          { kind: 'union', children: [{ kind: 'computed', name: 'owner' }] },
          { kind: 'computed', name: 'editor' },
        ],
      },
      subtract: { kind: 'computed', name: 'banned' },
    });
  });

  it('rejects an empty type name inside an array', () => {
    expect(() => relation(['user', ''])).toThrow(/non-empty strings/);
  });

  it('rejects a non-config model', () => {
    expect(() =>
      defineModel(null as unknown as { types: Record<string, never> }),
    ).toThrow(/expects a config object/);
  });

  it('rejects an invalid relation name', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({ relations: { Read: relation(['user']) } }),
        },
      }),
    ).toThrow(/invalid relation name/);
  });

  it('rejects an invalid permission name', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({ permissions: { 'read-all': permission.or('read') } }),
        },
      }),
    ).toThrow(/invalid permission name/);
  });
});

describe('a model with no permissions', () => {
  it('builds, and answers against a relation directly', async () => {
    const bare = defineModel({
      types: {
        user: defineType({}),
        doc: defineType({ relations: { owner: relation(['user']) } }),
      },
    });
    const authz = createAuthz({
      model: bare,
      store: testStore([
        { subject: 'user:alice', relation: 'owner', resource: 'doc:1' } as Tuple,
      ]),
    });
    expect(await authz.can('user:alice', 'doc.owner', 'doc:1')).toBe(true);
    expect(authz.permissions('doc')).toEqual([]);
    expect(authz.relations('doc')).toEqual(['owner']);
  });
});

describe('a permission that references a direct edge is rejected at build time', () => {
  it('names the edge, because tuples are only written against relations', () => {
    expect(() =>
      defineModel({
        types: {
          user: defineType({}),
          doc: defineType({
            relations: { owner: relation(['user']) },
            permissions: { read: permission.or(relation(['user'])) },
          }),
        },
      }),
    ).toThrow(/tuples are only written against relations/);
  });
});
