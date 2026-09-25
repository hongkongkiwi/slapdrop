import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

export const apps = sqliteTable(
  'apps',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    packageName: text('package_name'),
    passcodeHash: text('passcode_hash'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('apps_slug_unique').on(table.slug)],
)

export const builds = sqliteTable(
  'builds',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    versionName: text('version_name').notNull(),
    versionCode: integer('version_code').notNull(),
    r2Key: text('r2_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    commitSha: text('commit_sha'),
    notes: text('notes'),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: text('uploaded_at').notNull().default(now),
    downloads: integer('downloads').notNull().default(0),
  },
  (table) => [
    uniqueIndex('builds_r2_key_unique').on(table.r2Key),
    uniqueIndex('builds_app_version_code_unique').on(table.appId, table.versionCode),
    index('builds_app_uploaded_at_idx').on(table.appId, table.uploadedAt),
  ],
)

export const passcodeAttempts = sqliteTable(
  'passcode_attempts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    clientKey: text('client_key').notNull(),
    failures: integer('failures').notNull().default(0),
    windowStartedAt: text('window_started_at').notNull(),
    lockedUntil: text('locked_until'),
  },
  (table) => [uniqueIndex('passcode_attempts_app_client_unique').on(table.appId, table.clientKey)],
)

export const uploadIntents = sqliteTable(
  'upload_intents',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    expectedSizeBytes: integer('expected_size_bytes').notNull(),
    versionName: text('version_name'),
    versionCode: integer('version_code'),
    notes: text('notes'),
    commitSha: text('commit_sha'),
    uploader: text('uploader').notNull(),
    state: text('state').notNull().default('pending'),
    buildId: text('build_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('upload_intents_expires_at_idx').on(table.expiresAt)],
)
