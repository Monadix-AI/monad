# macOS Startup Item Logo Design

## Goal

Show the Monad logo for the `Monad` background item in macOS System Settings > General > Login Items without changing startup behavior on Windows or Linux.

## Current behavior

The macOS fallback registration creates a branded wrapper app at `~/.monad/startup/Monad.app`. Its bundle metadata already declares the Monad name, bundle identifier, and `MonadIcon`, and the LaunchAgent executes the wrapper app's launcher. The generated LaunchAgent does not declare which app bundle owns the job, so Background Task Management records it as a legacy agent with an unknown parent and may omit its logo.

Windows already writes a startup shortcut with `IconLocation`. Linux already writes an XDG autostart entry with `Icon=`. They are outside this change.

## Design

Add `AssociatedBundleIdentifiers` to the generated macOS LaunchAgent plist. The array contains the bundle identifier of the wrapper app generated for the same startup identity:

- Release: `ai.monad.monad.startup`
- Development: `ai.monad.monad-dev.startup`

macOS documents this launchd key as the association used by the System Settings Login Items UI for legacy plists. Background Task Management can then resolve the existing wrapper app metadata and icon while the daemon continues to launch through the same command, environment, and log paths.

The bundle identifier must be derived once from `StartupIdentity` and passed to both the wrapper app Info.plist and LaunchAgent renderer. The two files must not construct independent identifiers that can drift.

## Registration flow

1. Enabling launch at login creates or refreshes the branded wrapper app and its icon.
2. The daemon writes the LaunchAgent with the wrapper executable and its bundle identifier association.
3. macOS registers the legacy agent and attributes its Login Items presentation to the wrapper app.
4. Disabling launch at login removes the LaunchAgent as today and retains the wrapper app metadata for future re-enablement.

If a bundled native registrar is available, the existing registrar path remains unchanged because the owning app bundle supplies its own branding.

## Tests

Extend the startup settings unit coverage to assert the user-visible branding contract:

- A release LaunchAgent associates with `ai.monad.monad.startup`.
- A development LaunchAgent associates with `ai.monad.monad-dev.startup`.
- The associated identifier matches the wrapper app's `CFBundleIdentifier`.

Tests should not assert whether a specific machine produced an ICNS or SVG fallback path; that conversion detail is environment-dependent and is not the macOS ownership contract.

Run the focused startup settings tests, then the applicable daemon typecheck and lint scopes. On macOS, refresh the local startup setting and inspect Background Task Management to confirm the item is associated with Monad rather than `Unknown Developer`.

## Non-goals

- Migrating registration to `SMAppService`.
- Changing daemon launch, restart, or logging behavior.
- Reworking Windows shortcuts or Linux desktop entries.
- Resetting the user's Background Task Management database.
