import "dotenv/config";
import { defineConfig, env } from "prisma/config";

const datasource = {
  url: env("DATABASE_URL"),
  ...(process.env.DIRECT_DATABASE_URL
    ? { directUrl: process.env.DIRECT_DATABASE_URL }
    : {}),
  ...(process.env.SHADOW_DATABASE_URL
    ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
    : {}),
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource,
});
