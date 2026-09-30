/** The version of the on-disk document this build reads and writes. */
export const FORMAT_VERSION = 1;

/** The portable authorization-state document, as written to disk. */
export interface Document {
  readonly version: number;
  readonly tuples: readonly {
    readonly subject: string;
    readonly relation: string;
    readonly resource: string;
    readonly condition?: string;
    readonly context?: Readonly<Record<string, unknown>>;
  }[];
}
