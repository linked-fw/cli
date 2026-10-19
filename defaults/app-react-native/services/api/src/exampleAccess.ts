/**
 * Who may query the example data (the mobile app's PersonOverview screen) through the generic query plane: the
 * endpoints that run a query the client built, such as `/call/@_linked/server/createQuery`.
 *
 * Without a rule, the server requires a session for every write, and for every read once `rpcExposure` is
 * `'enforce'`. This template has no sign-in, so the example screen would answer `401 Authentication required`. The
 * rule built here is attached to the app's store in `linked.backend.storage.ts` with `withAccess`, and it is
 * deliberately narrow:
 *
 * - a signed-in session may run any query, as the default `'session'` rule allows;
 * - without a session, a query may READ only the example shapes, in every environment;
 * - without a session, a query may WRITE the example shapes only when `NODE_ENV` is exactly `development` (what
 *   `.env.example` sets for `npm run api`, and what the integration tests start the API with). `NODE_ENV=production`,
 *   any other value and an unset `NODE_ENV` refuse anonymous writes;
 * - any query that touches a shape outside the example falls back to requiring a session.
 *
 * Remove the rule together with the example, or replace it with your own rules once the app has sign-in. Note that
 * a rule belongs to a store, not to a shape: a query the rule admits can address any node in that store's dataset by
 * id, as long as it does so through the example shapes. That is acceptable for disposable example data in
 * development, and it is why the anonymous write is kept out of production.
 */

/** The parts of the server's `QueryAccessContext` this rule reads. */
export interface ExampleAccessContext {
  shapes: ReadonlySet<string>;
  linkedAuth?: { userAccount?: unknown } | null;
}

export type ExampleAccessRule = (ctx: ExampleAccessContext) => boolean;

/** Whether an anonymous caller may write the example shapes. Fails closed. */
export function allowsAnonymousExampleWrites(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development';
}

/**
 * The `read` and `write` rules for the app's store.
 *
 * @param exampleShapes the node shape IRIs of the example, including the super shapes that own inherited properties.
 * @param anonymousWrites from {@link allowsAnonymousExampleWrites}.
 */
export function exampleAccess(
  exampleShapes: ReadonlySet<string>,
  anonymousWrites: boolean,
): { read: ExampleAccessRule; write: ExampleAccessRule } {
  const hasSession = (ctx: ExampleAccessContext) => !!ctx.linkedAuth?.userAccount;
  const onlyExample = (ctx: ExampleAccessContext) =>
    ctx.shapes.size > 0 && [...ctx.shapes].every((id) => exampleShapes.has(id));
  return {
    read: (ctx) => hasSession(ctx) || onlyExample(ctx),
    write: (ctx) => hasSession(ctx) || (anonymousWrites && onlyExample(ctx)),
  };
}
