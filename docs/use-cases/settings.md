# Settings and preferences

Argsbarg does not load settings or own a database. Call `resolveConfigDir(appKey, override?)` only when the app needs a writable config directory:

```typescript
const dir = await resolveConfigDir("reports");
```

The complete absolute override wins. Otherwise argsbarg selects the native macOS, Windows, or XDG/Linux per-user location and creates it recursively. Invalid paths and filesystem errors fail closed.

The app owns file names, schema, writes, permissions, migration, and validation. Resolve owner settings before building fixed declarations. Read per-user preferences in guards so disabling an operation does not remove it from discovery.

## Policy examples

- **Terms required:** a guard checks the accepted terms version before side effects.
- **User disables export:** the operation remains listed, but its guard denies that caller.
- **Owner excludes export:** omit its declarations before `argsbarg()` is constructed, then restart.

CLI and stdio read process-local env. HTTP reads request headers. Settings code must not bridge one source to another implicitly.
