import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/db/schema.ts',
  out: './drizzle'
});
