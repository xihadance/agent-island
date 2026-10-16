`@discordjs/ws` 1.2.3 does not expose a WebSocket agent option. The patch forwards
the per-manager `islandAgent` to the Node `ws` constructor in both CJS and ESM.
`DiscordChannel` supplies it through `buildStrategy`; reconnects and resumptions
retain the same proxy. All heartbeat, rate limit and session logic stays in the SDK.

The dependency is pinned and `postinstall` applies the patch with `--error-on-fail`.
When upgrading discord.js or @discordjs/ws, run the local proxy/Gateway integration
tests and update or remove this patch if the SDK provides an official option.
