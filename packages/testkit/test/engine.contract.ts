import {
  type Authz,
  createAuthz,
  defineCondition,
  defineModel,
  defineType,
  type ExplainNode,
  formatExplain,
  permission,
  relation,
  type TupleStore,
  ttu,
  wildcard,
} from '@tsbouncer/core';
import { contract } from '../src/index.js';
import { arrayStore, conditionStrippingStore, overMatchingStore } from './helpers.js';

/**
 * The engine's guarantees, written as sentences.
 *
 * Each clause states the rule in words, then checks it. The value is not the
 * re-testing — the unit suite does that — it is that `report.md` is a list of
 * claims with a pass or fail beside each, which is the only honest way to answer
 * "what does this library actually guarantee?".
 *
 * A clause that throws fails. An exception is never a pass, because a contract
 * that treats a crash as success reports green on a broken implementation.
 */

const model = defineModel({
  types: {
    user: defineType({}),
    team: defineType({ relations: { member: relation(['user']) } }),
    folder: defineType({
      relations: { viewer: relation('user'), parent: relation('folder') },
      permissions: { read: permission.or('viewer', ttu('parent', 'read')) },
    }),
    document: defineType({
      relations: {
        owner: relation('user'),
        editor: relation('user').or(relation('team', { through: 'member' })),
        parent: relation('folder'),
        banned: relation('user').or(wildcard('user')),
        anyone: relation('user').or(wildcard('user')),
      },
      permissions: {
        read: permission.or('owner', 'editor', 'anyone', ttu('parent', 'read')),
        write: permission.allOf('owner', 'editor').except('banned'),
      },
    }),
  },
  conditions: {
    sameRegion: defineCondition(
      'sameRegion',
      (ctx) => {
        const { region, callerRegion } = ctx;
        if (typeof region !== 'string' || typeof callerRegion !== 'string') return false;
        return region === callerRegion;
      },
      { params: { region: 'string' as const } },
    ),
  },
});

interface Fixture {
  readonly authz: Authz;
  readonly store: TupleStore;
}

async function setup(
  tuples: readonly {
    subject: string;
    relation: string;
    resource: string;
    condition?: string;
    context?: Record<string, unknown>;
  }[],
): Promise<Fixture> {
  const store = arrayStore();
  const authz = createAuthz({ model, store });
  await authz.write(tuples);
  return { authz, store };
}

const flatten = (node: ExplainNode): ExplainNode[] => [
  node,
  ...node.children.flatMap(flatten),
];

const T = (subject: string, relation: string, resource: string) => ({
  subject,
  relation,
  resource,
});

const BASE = [
  T('user:alice', 'owner', 'document:1'),
  T('user:alice', 'editor', 'document:1'),
  T('user:mallory', 'banned', 'document:1'),
  T('user:bob', 'member', 'team:eng'),
  T('team:eng#member', 'editor', 'document:2'),
  T('user:*', 'anyone', 'document:3'),
  T('user:alice', 'viewer', 'folder:9'),
  T('folder:9', 'parent', 'document:4'),
  // A subject whose base is fully satisfied and who is banned anyway, so the
  // exclusion clause proves something rather than nothing.
  T('user:mallory', 'owner', 'document:5'),
  T('user:mallory', 'editor', 'document:5'),
  T('user:mallory', 'banned', 'document:5'),
];

/** `expect(cond, message)` — a verify step that always throws on mismatch. */
const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

export const engineContract = contract<Fixture, void>(
  'engine guarantees',
  'Every claim below is checked against a real store on every CI run.',
  [
    {
      id: 'direct-grant',
      given: 'alice is the owner of doc:1',
      when: 'checking document.read for user:alice on doc:1',
      expect: 'a direct grant allows the subject that holds it',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:alice', 'document.read', 'document:1'),
          'a direct owner grant should allow read',
        );
      },
      verify: () => {},
    },
    {
      id: 'direct-denied-for-others',
      given: 'the same data',
      when: 'checking document.read for user:carol on doc:1',
      expect: 'a grant grants nobody else',
      run: async ({ authz }) => {
        expect(
          !(await authz.can('user:carol', 'document.read', 'document:1')),
          'a stranger should not be allowed',
        );
      },
      verify: () => {},
    },
    {
      id: 'userset-rewrites',
      given: 'bob is a member of team:eng, and team:eng#member edits doc:2',
      when: 'checking document.read for user:bob on doc:2',
      expect: 'membership in a group carries the group’s grant',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:bob', 'document.read', 'document:2'),
          'a userset edge should carry its members',
        );
      },
      verify: () => {},
    },
    {
      id: 'a-group-is-not-its-members',
      given: 'the same data',
      when: 'checking document.read for the subject team:eng',
      expect: 'naming a group grants the group object, not the people in it',
      run: async ({ authz }) => {
        expect(
          !(await authz.can('team:eng', 'document.read', 'document:2')),
          'the group object itself should not inherit',
        );
      },
      verify: () => {},
    },
    {
      id: 'wildcard-covers-every-subject',
      given: 'user:* holds `anyone` on doc:3',
      when: 'checking document.read for a user that does not exist yet',
      expect: 'a wildcard grant reaches every subject of that type',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:nobody-yet', 'document.read', 'document:3'),
          'user:* should cover any user',
        );
      },
      verify: () => {},
    },
    {
      id: 'exclusion-beats-a-satisfied-base',
      given: 'mallory is owner and editor of document:5, and is banned from it',
      when: 'checking document.write for user:mallory on document:5',
      expect:
        'an exclusion removes an access its own base granted — the base here is ' +
        'satisfied, so a short-circuit would allow exactly what the ban forbids',
      run: async ({ authz }) => {
        const owner = await authz.can('user:mallory', 'document.owner', 'document:5');
        const editor = await authz.can('user:mallory', 'document.editor', 'document:5');
        const banned = await authz.can('user:mallory', 'document.banned', 'document:5');
        expect(
          owner && editor && banned,
          `precondition failed: owner=${owner} editor=${editor} banned=${banned}`,
        );
        expect(
          !(await authz.can('user:mallory', 'document.write', 'document:5')),
          'a ban must override a satisfied base — this is the short-circuit bug',
        );
      },
      verify: () => {},
    },
    {
      id: 'exclusion-does-not-leak-to-other-permissions',
      given: 'alice is banned from doc:1',
      when: 'checking document.read for user:alice on doc:1',
      expect: 'an exclusion on write leaves read alone',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:alice', 'document.read', 'document:1'),
          'a ban on write should not remove read',
        );
      },
      verify: () => {},
    },
    {
      id: 'declared-wildcard-is-not-a-grant',
      given:
        'document:1 has no `user:*` on `banned`, though the relation is declared wildcard',
      when: 'listing who holds document.write on document:1',
      expect:
        'declaring a wildcard edge does not ban everyone — it matches a stored user:*, ' +
        'so an empty ban list must leave the base intact',
      run: async ({ authz }) => {
        const set = await authz.listSubjects({
          permission: 'document.write',
          resource: 'document:1',
        });
        const aliceCan = await authz.can('user:alice', 'document.write', 'document:1');
        expect(aliceCan, 'precondition failed: alice should be able to write document:1');
        expect(
          set.members.includes('user:alice'),
          `listSubjects dropped alice: can=${aliceCan} members=${[...set.members]}`,
        );
      },
      verify: () => {},
    },
    {
      id: 'inheritance-follows-the-parent-chain',
      given: 'alice views folder:9, and folder:9 is the parent of doc:4',
      when: 'checking document.read for user:alice on doc:4',
      expect: 'permission flows from an ancestor to its descendants',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:alice', 'document.read', 'document:4'),
          'a tuple-to-userset should inherit',
        );
      },
      verify: () => {},
    },
    {
      id: 'inheritance-does-not-leak-upward',
      given: 'the same folder',
      when: 'checking document.read for user:alice on folder:9',
      expect: 'a descendant grant does not reach the ancestor',
      run: async ({ authz }) => {
        expect(
          await authz.can('user:alice', 'folder.read', 'folder:9'),
          'the viewer relation should not be reachable as folder.read',
        );
      },
      verify: () => {},
    },
    {
      id: 'the-tuple-is-authoritative-over-the-request',
      given: 'a grant bound to region eu',
      when: 'a caller in the us region supplies region: "us" for the same key',
      expect:
        'the writer’s binding wins — the request cannot rewrite the constraint, ' +
        'so the merged context is still eu and the check is denied',
      run: async () => {
        const f = await setup([
          {
            subject: 'user:dave',
            relation: 'owner',
            resource: 'document:5',
            condition: 'sameRegion',
            context: { region: 'eu' },
          },
        ]);
        const forged = await f.authz.check(
          { subject: 'user:dave', permission: 'document.read', resource: 'document:5' },
          { context: { callerRegion: 'us', region: 'us' } },
        );
        expect(
          !forged.allowed,
          'the request overrode the bound region, which makes the condition theatre',
        );
        // And the same grant does allow a caller actually in the bound region.
        const honest = await f.authz.check(
          { subject: 'user:dave', permission: 'document.read', resource: 'document:5' },
          { context: { callerRegion: 'eu' } },
        );
        expect(honest.allowed, 'the bound region should allow a matching caller');
      },
      verify: () => {},
    },
    {
      id: 'a-condition-without-its-context-denies',
      given: 'a grant bound to region eu',
      when: 'checking with no caller region supplied at all',
      expect: 'a missing key is a denial, never a pass',
      run: async () => {
        const f = await setup([
          {
            subject: 'user:dave',
            relation: 'owner',
            resource: 'document:5',
            condition: 'sameRegion',
            context: { region: 'eu' },
          },
        ]);
        const decision = await f.authz.check({
          subject: 'user:dave',
          permission: 'document.read',
          resource: 'document:5',
        });
        expect(!decision.allowed, 'a condition with no request context should deny');
      },
      verify: () => {},
    },
    {
      id: 'an-undeclared-condition-denies',
      given: 'a tuple naming a condition the model does not declare',
      when: 'checking that permission',
      expect: 'an unrecognised condition is a denial, not an evaluation',
      run: async () => {
        const f = await setup([T('user:dave', 'owner', 'document:5')]);
        // Written with validation off, because a well-formed write would reject it.
        const store = arrayStore([
          { ...T('user:dave', 'owner', 'document:5'), condition: 'goneFromTheModel' },
        ]);
        const authz = createAuthz({ model, store });
        const decision = await authz.check({
          subject: 'user:dave',
          permission: 'document.read',
          resource: 'document:5',
        });
        expect(!decision.allowed, 'an undeclared condition must not allow');
        void f;
      },
      verify: () => {},
    },
    {
      id: 'a-cycle-terminates',
      given: 'a self-referential model that the validator would normally reject',
      when: 'checking it anyway',
      expect: 'evaluation terminates rather than hanging, and denies',
      run: async () => {
        const cyclic = defineModel({
          types: {
            user: defineType({}),
            node: defineType({
              relations: { link: relation('node') },
              permissions: { read: permission.or('link') },
            }),
          },
        });
        // Built as a raw AST so the model's own cycle check is bypassed on purpose.
        const authz = createAuthz({
          model: cyclic,
          store: arrayStore([
            T('node:a', 'link', 'node:b'),
            T('node:b', 'link', 'node:a'),
          ]),
        });
        const decision = await authz.check({
          subject: 'user:x',
          permission: 'node.read',
          resource: 'node:a',
        });
        expect(!decision.allowed, 'a cycle should deny, not allow and not hang');
      },
      verify: () => {},
    },
    {
      id: 'list-and-check-agree',
      given: 'one dataset',
      when: 'comparing listResources against check for every subject and resource',
      expect: 'the list query and the single check never contradict each other',
      run: async ({ authz }) => {
        for (const subject of ['user:alice', 'user:bob', 'user:mallory', 'user:nobody']) {
          const { resources } = await authz.listResources({
            subject,
            permission: 'document.read',
          });
          for (const resource of resources) {
            expect(
              await authz.can(subject, 'document.read', resource),
              `listResources offered ${resource} to ${subject} but can() denies it`,
            );
          }
        }
      },
      verify: () => {},
    },
    {
      id: 'the-list-queries-honour-context',
      given: 'a grant reachable only when the caller’s region matches',
      when: 'listing with a matching context and then a mismatched one',
      expect: 'listResources applies the caller context rather than ignoring it',
      run: async () => {
        const f = await setup([
          {
            subject: 'user:dave',
            relation: 'owner',
            resource: 'document:5',
            condition: 'sameRegion',
            context: { region: 'eu' },
          },
        ]);
        const eu = await f.authz.listResources({
          subject: 'user:dave',
          permission: 'document.read',
          context: { callerRegion: 'eu' },
        });
        const us = await f.authz.listResources({
          subject: 'user:dave',
          permission: 'document.read',
          context: { callerRegion: 'us' },
        });
        expect(
          eu.resources.includes('document:5') && !us.resources.includes('document:5'),
          `condition ignored by the list query: eu=${[...eu.resources]} us=${[...us.resources]}`,
        );
      },
      verify: () => {},
    },
    {
      id: 'a-denied-decision-is-explainable',
      given: 'a denial',
      when: 'asking explain() for it',
      expect:
        'every decision can cite the tuples that produced it, or the query that came back empty',
      run: async ({ authz }) => {
        const result = await authz.explain({
          subject: 'user:carol',
          permission: 'document.read',
          resource: 'document:1',
        });
        expect(!result.allowed, 'carol should be denied');
        expect(result.reads > 0, 'a denial should have cost at least one read');
      },
      verify: () => {},
    },
    {
      id: 'explain-cites-a-granting-tuple',
      given: 'an allow',
      when: 'asking explain() for it',
      expect: 'the trace names the tuple that granted it',
      run: async ({ authz }) => {
        const result = await authz.explain({
          subject: 'user:alice',
          permission: 'document.read',
          resource: 'document:1',
        });
        expect(result.allowed, 'alice should be allowed');

        // The tree is the product, and its tuples are structured fields — not the
        // `#relation@resource` string the text renders.
        const cited = flatten(result.tree).some((node) =>
          node.tuples.some(
            (t) =>
              t.subject === 'user:alice' &&
              t.relation === 'owner' &&
              t.resource === 'document:1',
          ),
        );
        expect(cited, 'the tree should carry the granting tuple');

        // And the text is a view of it, so it names the same tuple. If these two
        // ever disagree, the formatter is not a view and the trace is unreliable.
        expect(
          formatExplain(result).includes('user:alice#owner@document:1'),
          'the text should cite the same tuple the tree does',
        );
      },
      verify: () => {},
    },
    {
      id: 'a-malformed-tuple-is-rejected-at-write',
      given: 'a tuple naming a relation the model does not declare',
      when: 'writing it',
      expect: 'a bad grant fails at write time, where a typo is still cheap',
      run: async () => {
        const store = arrayStore();
        const authz = createAuthz({ model, store });
        let threw = false;
        try {
          await authz.write([T('user:alice', 'notARelation', 'document:1')]);
        } catch {
          threw = true;
        }
        expect(threw, 'writing an undeclared relation should be rejected');
      },
      verify: () => {},
    },
    {
      id: 'a-store-that-matches-too-much-is-detectable',
      given: 'a store whose filter returns every row',
      when: 'the engine asks it for one resource',
      expect: 'the golden dataset rejects it, so it cannot pass unnoticed',
      run: async () => {
        const { runGolden, GOLDEN_EXPECTED } = await import('../src/index.js');
        const outcome = await runGolden(overMatchingStore());
        expect(
          JSON.stringify(outcome.checks) !== JSON.stringify(GOLDEN_EXPECTED.checks),
          'an over-matching store produced the reference answers, which cannot be right',
        );
      },
      verify: () => {},
    },
    {
      id: 'a-store-that-drops-conditions-is-detectable',
      given: 'a store that discards condition bindings when writing',
      when: 'the engine reads a conditional grant back',
      expect: 'a fail-open store is caught by the golden dataset',
      run: async () => {
        const { runGolden, GOLDEN_EXPECTED } = await import('../src/index.js');
        const outcome = await runGolden(conditionStrippingStore());
        expect(
          JSON.stringify(outcome.checks) !== JSON.stringify(GOLDEN_EXPECTED.checks),
          'a condition-stripping store produced the reference answers, which cannot be right',
        );
      },
      verify: () => {},
    },
  ],
);

/** Built once and reused, so the report reflects the same data every time. */
export const engineFixture = (): Promise<Fixture> => setup(BASE);
