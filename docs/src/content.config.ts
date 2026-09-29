import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * One collection, so the sidebar, the table of contents, and the snippet checker
 * all read the same frontmatter. `order` is explicit rather than alphabetical:
 * a docs site whose navigation reorders when a file is renamed is a docs site
 * nobody trusts.
 */
const docs = defineCollection({
  loader: glob({ base: './src/content/docs', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** Sidebar group. Omit to place the page at the top level. */
    section: z.string().optional(),
    order: z.number().default(100),
    /** Omit from the sidebar — for pages reachable only by link. */
    hidden: z.boolean().default(false),
    /** The status of the thing being documented. Pre-1.0 things should say so. */
    status: z.enum(['stable', 'preview', 'planned']).default('stable'),
    /** Set on recipe pages so the sidebar can badge them. */
    kind: z.enum(['guide', 'reference', 'recipe']).default('guide'),
  }),
});

export const collections = { docs };
