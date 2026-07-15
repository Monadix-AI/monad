# Interactions Zod Contract Design

## Goal

Make `@monad/protocol` the only source of runtime schemas for the interactions HTTP surface. Monad application code must not define interaction contracts with Elysia's TypeBox-backed `t` builder.

## Design

`packages/protocol/src/interaction.ts` owns the interaction path-parameter and request-body schemas. These schemas compose existing interaction domain schemas such as `interactionPresenterCapabilitiesSchema` and a shared cancellation-reason schema.

`apps/monad/src/transports/http/interactions.ts` passes the protocol Zod schemas directly to Elysia through Standard Schema support. Route handlers continue to receive inferred, validated inputs without performing a second parse.

`@sinclair/typebox` is not declared directly by a Monad workspace. Elysia 1.4 still requires and imports it at runtime, so the package can remain in the resolved dependency tree as Elysia's peer. No Monad-owned business schema uses TypeBox.

## Verification

Protocol tests cover valid and invalid HTTP payloads. TypeScript verifies Elysia's route inference, and Knip verifies that schema exports and dependencies remain intentional.
