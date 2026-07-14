---
targets: ["*"]
description: "Bun-only runtime rules and Bun-native frontend patterns"
globs: ["**/*"]
---

# Runtime: Bun only

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` / `yarn install` / `pnpm install`
- Use `bun run <script>` instead of `npm run` / `yarn run` / `pnpm run`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env`, so don't use `dotenv`.
- Prefer Bun-native APIs: `Bun.serve`, `bun:sqlite`, `Bun.redis`, `Bun.sql`,
  built-in `WebSocket`, `Bun.file`, and `Bun.$`.
- Gate environment-specific code on plain `NODE_ENV` checks so bundlers can
  dead-code-eliminate unused branches.

# Frontend runtime

Use HTML imports with `Bun.serve()` for Bun-native frontends. Don't use Vite in new
Bun-served surfaces. HTML files can import `.tsx`, `.jsx`, `.js`, and CSS directly:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

```sh
bun --hot ./index.ts
```
