const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const SESSION_DAYS = 30;
const MAX_MESSAGE_BYTES = 9000000;
const MAX_ATTACHMENT_CIPHERTEXT_BYTES = 9000000;

const PERMISSIONS = [
  "view_channel",
  "send_messages",
  "send_media",
  "create_topics",
  "manage_topics",
  "manage_messages",
  "manage_channels",
  "manage_members",
  "manage_roles",
  "manage_group"
];

const CHANNEL_PERMISSIONS = [
  "view_channel",
  "send_messages",
  "send_media",
  "create_topics",
  "manage_topics",
  "manage_messages"
];

const DEFAULT_ROLE_PERMISSIONS = [
  "view_channel",
  "send_messages",
  "send_media",
  "create_topics"
];

const ADMIN_ROLE_PERMISSIONS = [...PERMISSIONS];

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "talkie.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    number TEXT,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    key_salt TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    banner TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    pronouns TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ephemeral_public_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    sender_ephemeral_public_key TEXT NOT NULL,
    sender_iv TEXT NOT NULL,
    sender_ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS call_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL UNIQUE,
    caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'ringing',
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages(sender_id, recipient_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_inbox
    ON messages(recipient_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
    ON user_blocks(blocked_id);
  CREATE INDEX IF NOT EXISTS idx_call_history_pair
    ON call_history(caller_id, callee_id, id);
  CREATE INDEX IF NOT EXISTS idx_call_history_callee
    ON call_history(callee_id, caller_id, id);

  CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    invite_code TEXT COLLATE NOCASE,
    topic_style TEXT NOT NULL DEFAULT 'chips',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#5eb5f7',
    permissions TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(group_id, name)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES group_roles(id) ON DELETE SET NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(group_id, name)
  );

  CREATE TABLE IF NOT EXISTS channel_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES group_roles(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    allow TEXT NOT NULL DEFAULT '[]',
    deny TEXT NOT NULL DEFAULT '[]'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_permissions_role
    ON channel_permissions(channel_id, role_id) WHERE role_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_permissions_user
    ON channel_permissions(channel_id, user_id) WHERE user_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS group_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    emoji TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(channel_id, name)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'text',
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_message_keys (
    message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ephemeral_public_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_reads (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES group_topics(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id, topic_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_members_user
    ON group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_group_channels_group
    ON group_channels(group_id, position);
  CREATE INDEX IF NOT EXISTS idx_group_topics_channel
    ON group_topics(channel_id, id);
  CREATE INDEX IF NOT EXISTS idx_group_messages_topic
    ON group_messages(topic_id, id);
  CREATE INDEX IF NOT EXISTS idx_group_messages_group
    ON group_messages(group_id, id);
`);

const groupColumns = db.prepare("PRAGMA table_info(chat_groups)").all();
if (!groupColumns.some((column) => column.name === "visibility")) {
  db.exec(
    "ALTER TABLE chat_groups ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"
  );
}
if (!groupColumns.some((column) => column.name === "invite_code")) {
  db.exec(
    "ALTER TABLE chat_groups ADD COLUMN invite_code TEXT COLLATE NOCASE"
  );
}
if (!groupColumns.some((column) => column.name === "topic_style")) {
  db.exec(
    "ALTER TABLE chat_groups ADD COLUMN topic_style TEXT NOT NULL DEFAULT 'chips'"
  );
}
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_groups_invite " +
    "ON chat_groups(invite_code) WHERE invite_code IS NOT NULL"
);

const topicColumns = db.prepare("PRAGMA table_info(group_topics)").all();
if (!topicColumns.some((column) => column.name === "emoji")) {
  db.exec(
    "ALTER TABLE group_topics ADD COLUMN emoji TEXT NOT NULL DEFAULT ''"
  );
}

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((column) => column.name === "number")) {
  db.exec("ALTER TABLE users ADD COLUMN number TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_number ON users(number)");

const app = express();
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; " +
      "script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws: wss:; media-src 'self' blob:; " +
      "object-src 'none'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(self), display-capture=(self), geolocation=()"
  });
  next();
});

app.use(express.json({ limit: "18mb" }));
app.use(express.static(path.join(__dirname, "public")));

const socketsByUser = new Map();

function sendToUser(userId, payload) {
  const sockets = socketsByUser.get(userId);
  if (!sockets || sockets.size === 0) return;
  const text = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(text);
    } catch {
      // Ignore connections that dropped while sending.
    }
  }
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
const IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const B64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const selectUserByName = db.prepare("SELECT * FROM users WHERE username = ?");
const selectUserByDigits = db.prepare(`
  SELECT * FROM users
  WHERE REPLACE(REPLACE(REPLACE(number, '+', ''), ' ', ''), '-', '') = ?
`);
const selectUserById = db.prepare("SELECT * FROM users WHERE id = ?");
const insertUser = db.prepare(`
  INSERT INTO users
    (username, number, password_salt, password_hash, public_key,
     encrypted_private_key, key_salt, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateUserNumber = db.prepare("UPDATE users SET number = ? WHERE id = ?");
const updateProfile = db.prepare(`
  UPDATE users
  SET avatar = ?, banner = ?, bio = ?, pronouns = ?, status = ?, links = ?
  WHERE id = ?
`);
const insertSession = db.prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const selectSessionUser = db.prepare(`
  SELECT u.*, s.expires_at AS session_expires_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);
const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
const deleteExpiredSessions = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
const insertMessage = db.prepare(`
  INSERT INTO messages
    (sender_id, recipient_id, ephemeral_public_key, iv, ciphertext,
     sender_ephemeral_public_key, sender_iv, sender_ciphertext, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectMessageForDelete = db.prepare(
  "SELECT id, sender_id, recipient_id FROM messages WHERE id = ?"
);
const deleteMessageById = db.prepare("DELETE FROM messages WHERE id = ?");
const selectPairAfter = db.prepare(`
  SELECT * FROM messages
  WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
    AND id > ?
  ORDER BY id ASC
  LIMIT 500
`);
const selectPairLatest = db.prepare(`
  SELECT * FROM (
    SELECT * FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY id DESC
    LIMIT 300
  ) ORDER BY id ASC
`);
const markConversationRead = db.prepare(`
  UPDATE messages SET read_at = ?
  WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL
`);
const selectConversationRows = db.prepare(`
  SELECT last.*,
    u.id AS user_id,
    u.username AS user_username,
    u.number AS user_number,
    u.public_key AS user_public_key,
    u.avatar AS user_avatar,
    u.banner AS user_banner,
    u.bio AS user_bio,
    u.pronouns AS user_pronouns,
    u.status AS user_status,
    u.links AS user_links,
    u.created_at AS user_created_at
  FROM (
    SELECT m.*,
      CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END AS other_id,
      CASE WHEN m.sender_id = ? THEN 1 ELSE 0 END AS from_me,
      ROW_NUMBER() OVER (
        PARTITION BY CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
        ORDER BY m.id DESC
      ) AS rn
    FROM messages m
    WHERE m.sender_id = ? OR m.recipient_id = ?
  ) AS last
  JOIN users u ON u.id = last.other_id
  WHERE last.rn = 1
  ORDER BY last.id DESC
`);
const selectUnreadCounts = db.prepare(`
  SELECT sender_id AS other_id, COUNT(*) AS total
  FROM messages
  WHERE recipient_id = ? AND read_at IS NULL
  GROUP BY sender_id
`);
const insertCallHistory = db.prepare(`
  INSERT OR IGNORE INTO call_history
    (call_id, caller_id, callee_id, status, started_at)
  VALUES (?, ?, ?, 'ringing', ?)
`);
const selectCallHistory = db.prepare(
  "SELECT * FROM call_history WHERE call_id = ?"
);
const markCallHistoryAnswered = db.prepare(`
  UPDATE call_history
  SET status = 'answered', answered_at = ?
  WHERE call_id = ? AND answered_at IS NULL
`);
const markCallHistoryEnded = db.prepare(`
  UPDATE call_history
  SET status = ?, ended_at = ?, duration_seconds = ?
  WHERE call_id = ? AND ended_at IS NULL
`);
const selectCallHistoryPair = db.prepare(`
  SELECT * FROM (
    SELECT * FROM call_history
    WHERE ((caller_id = ? AND callee_id = ?)
      OR (caller_id = ? AND callee_id = ?))
      AND ended_at IS NOT NULL
    ORDER BY id DESC
    LIMIT 200
  ) ORDER BY id ASC
`);
const selectBlock = db.prepare(
  "SELECT 1 AS blocked FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?"
);
const insertBlock = db.prepare(`
  INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at)
  VALUES (?, ?, ?)
`);
const deleteBlock = db.prepare(
  "DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?"
);
const selectBlockedUsers = db.prepare(`
  SELECT u.*, b.created_at AS blocked_at
  FROM user_blocks b
  JOIN users u ON u.id = b.blocked_id
  WHERE b.blocker_id = ?
  ORDER BY b.created_at DESC
`);
const selectBlockedIds = db.prepare(
  "SELECT blocked_id FROM user_blocks WHERE blocker_id = ?"
);
const selectBlockerIds = db.prepare(
  "SELECT blocker_id FROM user_blocks WHERE blocked_id = ?"
);

const selectGroupById = db.prepare("SELECT * FROM chat_groups WHERE id = ?");
const selectGroupMember = db.prepare(
  "SELECT * FROM group_members WHERE group_id = ? AND user_id = ?"
);
const selectGroupMembers = db.prepare(`
  SELECT u.*, gm.role_id AS group_role_id, gm.joined_at AS member_joined_at
  FROM group_members gm
  JOIN users u ON u.id = gm.user_id
  WHERE gm.group_id = ?
  ORDER BY gm.joined_at ASC, u.username COLLATE NOCASE ASC
`);
const selectGroupMemberIds = db.prepare(
  "SELECT user_id FROM group_members WHERE group_id = ?"
);
const selectGroupRoles = db.prepare(`
  SELECT * FROM group_roles
  WHERE group_id = ?
  ORDER BY position DESC, id ASC
`);
const selectGroupRole = db.prepare(
  "SELECT * FROM group_roles WHERE id = ? AND group_id = ?"
);
const selectDefaultRole = db.prepare(
  "SELECT * FROM group_roles WHERE group_id = ? AND is_default = 1"
);
const selectGroupChannels = db.prepare(`
  SELECT * FROM group_channels
  WHERE group_id = ?
  ORDER BY position ASC, id ASC
`);
const selectGroupChannel = db.prepare(
  "SELECT * FROM group_channels WHERE id = ? AND group_id = ?"
);
const selectGroupTopics = db.prepare(`
  SELECT * FROM group_topics
  WHERE channel_id = ?
  ORDER BY id ASC
`);
const selectGroupTopic = db.prepare(
  "SELECT * FROM group_topics WHERE id = ? AND group_id = ?"
);
const selectChannelOverrides = db.prepare(
  "SELECT * FROM channel_permissions WHERE channel_id = ? ORDER BY id ASC"
);
const selectChannelOverrideRole = db.prepare(
  "SELECT * FROM channel_permissions WHERE channel_id = ? AND role_id = ?"
);
const selectChannelOverrideUser = db.prepare(
  "SELECT * FROM channel_permissions WHERE channel_id = ? AND user_id = ?"
);
const insertGroup = db.prepare(`
  INSERT INTO chat_groups
    (name, description, avatar, visibility, invite_code, topic_style,
     owner_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateGroup = db.prepare(`
  UPDATE chat_groups
  SET name = ?, description = ?, avatar = ?, visibility = ?,
      invite_code = ?, topic_style = ?
  WHERE id = ?
`);
const selectGroupByInviteCode = db.prepare(
  "SELECT * FROM chat_groups WHERE invite_code = ? COLLATE NOCASE"
);
const deleteGroup = db.prepare("DELETE FROM chat_groups WHERE id = ?");
const insertGroupRole = db.prepare(`
  INSERT INTO group_roles
    (group_id, name, color, permissions, is_default, position, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateGroupRole = db.prepare(`
  UPDATE group_roles SET name = ?, color = ?, permissions = ? WHERE id = ?
`);
const deleteGroupRole = db.prepare("DELETE FROM group_roles WHERE id = ?");
const insertGroupMember = db.prepare(`
  INSERT INTO group_members (group_id, user_id, role_id, joined_at)
  VALUES (?, ?, ?, ?)
`);
const updateGroupMemberRole = db.prepare(`
  UPDATE group_members SET role_id = ? WHERE group_id = ? AND user_id = ?
`);
const deleteGroupMember = db.prepare(
  "DELETE FROM group_members WHERE group_id = ? AND user_id = ?"
);
const insertGroupChannel = db.prepare(`
  INSERT INTO group_channels
    (group_id, name, description, kind, position, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateGroupChannel = db.prepare(`
  UPDATE group_channels SET name = ?, description = ?, kind = ? WHERE id = ?
`);
const deleteGroupChannel = db.prepare(
  "DELETE FROM group_channels WHERE id = ?"
);
const insertGroupTopic = db.prepare(`
  INSERT INTO group_topics
    (group_id, channel_id, name, emoji, created_by, closed, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateGroupTopic = db.prepare(
  "UPDATE group_topics SET name = ?, emoji = ?, closed = ? WHERE id = ?"
);
const deleteGroupTopic = db.prepare("DELETE FROM group_topics WHERE id = ?");
const insertChannelPermission = db.prepare(`
  INSERT INTO channel_permissions (channel_id, role_id, user_id, allow, deny)
  VALUES (?, ?, ?, ?, ?)
`);
const deleteChannelPermissions = db.prepare(
  "DELETE FROM channel_permissions WHERE channel_id = ?"
);
const insertGroupMessage = db.prepare(`
  INSERT INTO group_messages
    (group_id, channel_id, topic_id, sender_id, kind, iv, ciphertext, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertGroupMessageKey = db.prepare(`
  INSERT INTO group_message_keys
    (message_id, user_id, ephemeral_public_key, iv, ciphertext)
  VALUES (?, ?, ?, ?, ?)
`);
const selectGroupMessageForDelete = db.prepare(`
  SELECT id, group_id, channel_id, topic_id, sender_id
  FROM group_messages WHERE id = ?
`);
const deleteGroupMessageById = db.prepare(
  "DELETE FROM group_messages WHERE id = ?"
);
const selectGroupMessageById = db.prepare(`
  SELECT gm.*,
    u.username AS sender_username,
    u.number AS sender_number,
    u.avatar AS sender_avatar,
    k.ephemeral_public_key AS key_ephemeral_public_key,
    k.iv AS key_iv,
    k.ciphertext AS key_ciphertext
  FROM group_messages gm
  JOIN users u ON u.id = gm.sender_id
  LEFT JOIN group_message_keys k
    ON k.message_id = gm.id AND k.user_id = ?
  WHERE gm.id = ?
`);
const selectGroupTopicMessagesLatest = db.prepare(`
  SELECT * FROM (
    SELECT gm.*,
      u.username AS sender_username,
      u.number AS sender_number,
      u.avatar AS sender_avatar,
      k.ephemeral_public_key AS key_ephemeral_public_key,
      k.iv AS key_iv,
      k.ciphertext AS key_ciphertext
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    LEFT JOIN group_message_keys k
      ON k.message_id = gm.id AND k.user_id = ?
    WHERE gm.topic_id = ?
    ORDER BY gm.id DESC
    LIMIT 300
  ) ORDER BY id ASC
`);
const selectGroupTopicMessagesAfter = db.prepare(`
  SELECT gm.*,
    u.username AS sender_username,
    u.number AS sender_number,
    u.avatar AS sender_avatar,
    k.ephemeral_public_key AS key_ephemeral_public_key,
    k.iv AS key_iv,
    k.ciphertext AS key_ciphertext
  FROM group_messages gm
  JOIN users u ON u.id = gm.sender_id
  LEFT JOIN group_message_keys k
    ON k.message_id = gm.id AND k.user_id = ?
  WHERE gm.topic_id = ? AND gm.id > ?
  ORDER BY gm.id ASC
  LIMIT 500
`);
const upsertGroupRead = db.prepare(`
  INSERT INTO group_reads
    (user_id, group_id, channel_id, topic_id, last_read_message_id, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, channel_id, topic_id) DO UPDATE SET
    last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
    updated_at = excluded.updated_at
`);
const selectGroupRead = db.prepare(`
  SELECT * FROM group_reads
  WHERE user_id = ? AND channel_id = ? AND topic_id = ?
`);
const selectGroupReads = db.prepare(
  "SELECT * FROM group_reads WHERE user_id = ? AND group_id = ?"
);

function formatUserNumber(digits) {
  return `+${digits.slice(0, 3)} ${digits.slice(3, 7)}-${digits.slice(7, 11)}`;
}

function generateUserNumber() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const digits =
      String(crypto.randomInt(100, 1000)) +
      String(crypto.randomInt(0, 10000)).padStart(4, "0") +
      String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (!selectUserByDigits.get(digits)) return formatUserNumber(digits);
  }
  throw new Error("Could not generate a user number.");
}

for (const row of db
  .prepare("SELECT id FROM users WHERE number IS NULL OR number = ''")
  .all()) {
  updateUserNumber.run(generateUserNumber(), row.id);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowISO() {
  return new Date().toISOString();
}

function parseLinks(text) {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item) =>
        item &&
        typeof item.label === "string" &&
        typeof item.url === "string"
    );
  } catch {
    return [];
  }
}

function serializeUser(row) {
  return {
    id: row.id,
    username: row.username,
    number: row.number,
    publicKey: row.public_key,
    avatar: row.avatar || "",
    banner: row.banner || "",
    bio: row.bio || "",
    pronouns: row.pronouns || "",
    status: row.status || "",
    links: parseLinks(row.links),
    createdAt: row.created_at
  };
}

function serializeMessage(row, userId) {
  const fromMe = row.sender_id === userId;
  return {
    id: row.id,
    fromMe,
    ephemeralPublicKey: fromMe
      ? row.sender_ephemeral_public_key
      : row.ephemeral_public_key,
    iv: fromMe ? row.sender_iv : row.iv,
    ciphertext: fromMe ? row.sender_ciphertext : row.ciphertext,
    read: Boolean(row.read_at),
    createdAt: row.created_at
  };
}

function serializeCallHistory(row, userId) {
  const fromMe = row.caller_id === userId;
  let status = row.status;
  if (status === "canceled" && !fromMe) status = "missed";
  if (status === "missed" && fromMe) status = "no-answer";
  return {
    id: row.id,
    callId: row.call_id,
    fromMe,
    direction: fromMe ? "outgoing" : "incoming",
    status,
    durationSeconds: Number(row.duration_seconds) || 0,
    createdAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at
  };
}

function parsePermissionList(text, allowed = PERMISSIONS) {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item) => allowed.includes(item)))];
  } catch {
    return [];
  }
}

function normalizePermissions(value, allowed = PERMISSIONS) {
  if (!Array.isArray(value)) return null;
  const result = [...new Set(value)];
  if (
    result.some(
      (permission) =>
        typeof permission !== "string" || !allowed.includes(permission)
    )
  ) {
    return null;
  }
  return result;
}

function serializeRole(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    permissions: parsePermissionList(row.permissions),
    isDefault: Boolean(row.is_default),
    position: row.position
  };
}

function serializeGroupMember(row, group) {
  return {
    ...serializeUser(row),
    roleId: row.group_role_id,
    joinedAt: row.member_joined_at,
    isOwner: row.id === group.owner_id
  };
}

function roleForMember(member, roles) {
  if (member.role_id) {
    return roles.find((role) => role.id === member.role_id) || null;
  }
  return roles.find((role) => role.isDefault) || null;
}

function groupPermissionsFor(group, member, roles) {
  if (group.owner_id === member.user_id) return new Set(PERMISSIONS);
  const role = roleForMember(member, roles);
  return new Set(role ? role.permissions : []);
}

function applyChannelOverride(permissions, override) {
  if (!override) return;
  for (const permission of override.allow) permissions.add(permission);
  for (const permission of override.deny) permissions.delete(permission);
}

function channelPermissionsFor(group, member, roles, channelRow) {
  if (group.owner_id === member.user_id) return new Set(PERMISSIONS);
  const permissions = groupPermissionsFor(group, member, roles);
  const role = roleForMember(member, roles);
  const roleOverride = role
    ? selectChannelOverrideRole.get(channelRow.id, role.id)
    : null;
  const userOverride = selectChannelOverrideUser.get(
    channelRow.id,
    member.user_id
  );

  if (roleOverride) {
    applyChannelOverride(permissions, {
      allow: parsePermissionList(roleOverride.allow, CHANNEL_PERMISSIONS),
      deny: parsePermissionList(roleOverride.deny, CHANNEL_PERMISSIONS)
    });
  }
  if (userOverride) {
    applyChannelOverride(permissions, {
      allow: parsePermissionList(userOverride.allow, CHANNEL_PERMISSIONS),
      deny: parsePermissionList(userOverride.deny, CHANNEL_PERMISSIONS)
    });
  }
  return permissions;
}

function getGroupDetails(groupId, userId) {
  const group = selectGroupById.get(groupId);
  if (!group) return null;
  const member = selectGroupMember.get(groupId, userId);
  if (!member) return null;

  const roles = selectGroupRoles.all(groupId).map(serializeRole);
  const groupPermissions = [...groupPermissionsFor(group, member, roles)];
  const canManageChannels = groupPermissions.includes("manage_channels");
  const channels = [];

  for (const channelRow of selectGroupChannels.all(groupId)) {
    const permissions = [
      ...channelPermissionsFor(group, member, roles, channelRow)
    ];
    if (!permissions.includes("view_channel") && !canManageChannels) {
      continue;
    }

    const channel = {
      id: channelRow.id,
      name: channelRow.name,
      description: channelRow.description,
      kind: channelRow.kind,
      position: channelRow.position,
      createdAt: channelRow.created_at,
      permissions,
      topics: selectGroupTopics.all(channelRow.id).map((topic) => ({
        id: topic.id,
        name: topic.name,
        emoji: topic.emoji || "",
        closed: Boolean(topic.closed),
        createdBy: topic.created_by,
        createdAt: topic.created_at
      }))
    };

    if (canManageChannels) {
      channel.overrides = selectChannelOverrides
        .all(channelRow.id)
        .map((row) => ({
          id: row.id,
          roleId: row.role_id,
          userId: row.user_id,
          allow: parsePermissionList(row.allow, CHANNEL_PERMISSIONS),
          deny: parsePermissionList(row.deny, CHANNEL_PERMISSIONS)
        }));
    }

    channels.push(channel);
  }

  return {
    id: group.id,
    name: group.name,
    description: group.description,
    avatar: group.avatar,
    visibility: group.visibility || "private",
    inviteCode:
      (group.visibility || "private") === "public"
        ? group.invite_code || null
        : null,
    topicStyle: group.topic_style || "chips",
    ownerId: group.owner_id,
    createdAt: group.created_at,
    permissions: groupPermissions,
    canManageGroup: groupPermissions.includes("manage_group"),
    canManageChannels,
    canManageMembers: groupPermissions.includes("manage_members"),
    canManageRoles: groupPermissions.includes("manage_roles"),
    roles,
    members: selectGroupMembers
      .all(groupId)
      .map((row) => serializeGroupMember(row, group)),
    channels
  };
}

function serializeGroupMessage(row, userId) {
  return {
    id: row.id,
    groupId: row.group_id,
    channelId: row.channel_id,
    topicId: row.topic_id,
    kind: row.kind,
    fromMe: row.sender_id === userId,
    sender: {
      id: row.sender_id,
      username: row.sender_username,
      number: row.sender_number,
      avatar: row.sender_avatar || ""
    },
    key: row.key_ephemeral_public_key
      ? {
          ephemeralPublicKey: row.key_ephemeral_public_key,
          iv: row.key_iv,
          ciphertext: row.key_ciphertext
        }
      : null,
    iv: row.iv,
    ciphertext: row.ciphertext,
    createdAt: row.created_at
  };
}

function getGroupUnread(groupId, userId, channelIds) {
  if (!channelIds.length) return 0;
  const placeholders = channelIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM group_messages gm
       LEFT JOIN group_reads gr
         ON gr.user_id = ? AND gr.channel_id = gm.channel_id
        AND gr.topic_id = gm.topic_id
       WHERE gm.group_id = ? AND gm.sender_id <> ?
         AND gm.id > COALESCE(gr.last_read_message_id, 0)
         AND gm.channel_id IN (${placeholders})`
    )
    .get(userId, groupId, userId, ...channelIds);
  return Number(row.total);
}

function getGroupLastMessage(groupId, userId, channelIds) {
  if (!channelIds.length) return null;
  const placeholders = channelIds.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT gm.*,
           u.username AS sender_username,
           u.number AS sender_number,
           u.avatar AS sender_avatar,
           k.ephemeral_public_key AS key_ephemeral_public_key,
           k.iv AS key_iv,
           k.ciphertext AS key_ciphertext
         FROM group_messages gm
         JOIN users u ON u.id = gm.sender_id
         LEFT JOIN group_message_keys k
           ON k.message_id = gm.id AND k.user_id = ?
         WHERE gm.group_id = ? AND gm.channel_id IN (${placeholders})
         ORDER BY gm.id DESC
         LIMIT 1`
      )
      .get(userId, groupId, ...channelIds) || null
  );
}

function getGroupSummary(groupRow, userId) {
  const details = getGroupDetails(groupRow.id, userId);
  if (!details) return null;
  const channelIds = details.channels.map((channel) => channel.id);
  const lastRow = getGroupLastMessage(groupRow.id, userId, channelIds);
  let lastMessage = null;

  if (lastRow) {
    lastMessage = serializeGroupMessage(lastRow, userId);
    const channel = details.channels.find(
      (item) => item.id === lastRow.channel_id
    );
    const topic = channel
      ? channel.topics.find((item) => item.id === lastRow.topic_id)
      : null;
    lastMessage.channelName = channel ? channel.name : "";
    lastMessage.topicName = topic ? topic.name : "";
  }

  return {
    id: details.id,
    name: details.name,
    description: details.description,
    avatar: details.avatar,
    visibility: details.visibility,
    topicStyle: details.topicStyle,
    ownerId: details.ownerId,
    createdAt: details.createdAt,
    permissions: details.permissions,
    memberCount: details.members.length,
    unread: getGroupUnread(groupRow.id, userId, channelIds),
    lastMessage
  };
}

function loadGroupAccess(groupId, userId) {
  const group = selectGroupById.get(groupId);
  if (!group) return null;
  const member = selectGroupMember.get(groupId, userId);
  if (!member) return null;
  const roles = selectGroupRoles.all(groupId).map(serializeRole);
  return {
    group,
    member,
    roles,
    permissions: groupPermissionsFor(group, member, roles)
  };
}

function findUserByIdentifier(identifier) {
  const value = String(identifier || "")
    .trim()
    .replace(/^[@#]+/, "");
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return (
    selectUserByName.get(value) ||
    (digits ? selectUserByDigits.get(digits) : null) ||
    null
  );
}

function blockStatus(viewerId, otherId) {
  return {
    blockedByMe: Boolean(selectBlock.get(viewerId, otherId)),
    blockedMe: Boolean(selectBlock.get(otherId, viewerId))
  };
}

function positiveInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function decodeB64url(value, maxChars) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    !B64URL_PATTERN.test(value)
  ) {
    return null;
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

function validUsername(value) {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) return null;
  return trimmed;
}

const INVITE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

function normalizeInviteCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return INVITE_CODE_PATTERN.test(code) ? code : null;
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex");
}

function uniqueInviteCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateInviteCode();
    if (!selectGroupByInviteCode.get(code)) return code;
  }
  return crypto.randomBytes(8).toString("hex");
}

function validImage(value, maxLength) {
  return (
    value === "" ||
    (typeof value === "string" &&
      value.length <= maxLength &&
      IMAGE_PATTERN.test(value))
  );
}

function normalizeLinks(value) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > 8) return { ok: false };
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { ok: false };
    const label = cleanText(item.label, 40);
    const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
    if (!label || rawUrl.length > 500) return { ok: false };
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false };
    }
    result.push({ label, url: parsed.toString() });
  }
  return { ok: true, value: result };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
  deleteExpiredSessions.run(created.toISOString());
  insertSession.run(
    sha256(token),
    userId,
    created.toISOString(),
    expires.toISOString()
  );
  return token;
}

function unauthorized(res) {
  return res.status(401).json({ error: "Invalid or expired session." });
}

function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return unauthorized(res);
  const token = header.slice(7).trim();
  if (token.length < 20 || token.length > 200) return unauthorized(res);
  const tokenHash = sha256(token);
  const row = selectSessionUser.get(tokenHash);
  if (!row) return unauthorized(res);
  if (row.session_expires_at < nowISO()) {
    deleteSession.run(tokenHash);
    return unauthorized(res);
  }
  req.user = row;
  req.tokenHash = tokenHash;
  next();
}

const loginAttempts = new Map();

function loginKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

function loginBlocked(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > 10 * 60 * 1000) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= 10;
}

function registerFailure(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > 10 * 60 * 1000) {
    loginAttempts.set(key, { first: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

app.post("/api/register", (req, res) => {
  const { username, authHash, publicKey, encryptedPrivateKey, keySalt } =
    req.body || {};

  if (!validUsername(username)) {
    return res.status(400).json({
      error: "Invalid username. Use 3 to 24 letters, numbers, _ or -."
    });
  }

  const authBytes = decodeB64url(authHash, 200);
  if (!authBytes || authBytes.length !== 32) {
    return res.status(400).json({ error: "Invalid credential." });
  }

  const publicBytes = decodeB64url(publicKey, 200);
  if (!publicBytes || publicBytes.length !== 65 || publicBytes[0] !== 4) {
    return res.status(400).json({ error: "Invalid public key." });
  }

  const keySaltBytes = decodeB64url(keySalt, 100);
  if (!keySaltBytes || keySaltBytes.length !== 16) {
    return res.status(400).json({ error: "Invalid key salt." });
  }

  const privateBytes = decodeB64url(encryptedPrivateKey, 4000);
  if (
    !privateBytes ||
    privateBytes.length < 40 ||
    privateBytes.length > 3000
  ) {
    return res.status(400).json({ error: "Invalid encrypted private key." });
  }

  if (selectUserByName.get(username)) {
    return res.status(409).json({ error: "That username is already taken." });
  }

  const passwordSalt = crypto.randomBytes(16).toString("base64url");
  const passwordHash = crypto
    .scryptSync(authHash, passwordSalt, 64)
    .toString("hex");

  const number = generateUserNumber();

  let info;
  try {
    info = insertUser.run(
      username,
      number,
      passwordSalt,
      passwordHash,
      publicKey,
      encryptedPrivateKey,
      keySalt,
      nowISO()
    );
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That username is already taken." });
    }
    throw error;
  }

  const user = selectUserById.get(Number(info.lastInsertRowid));
  const token = createSession(user.id);

  res.status(201).json({
    token,
    user: serializeUser(user),
    publicKey: user.public_key,
    encryptedPrivateKey: user.encrypted_private_key,
    keySalt: user.key_salt
  });
});

app.post("/api/login", (req, res) => {
  const { username, authHash } = req.body || {};

  if (!validUsername(username)) {
    return res.status(400).json({ error: "Invalid username or password." });
  }

  const authBytes = decodeB64url(authHash, 200);
  if (!authBytes || authBytes.length !== 32) {
    return res.status(400).json({ error: "Invalid username or password." });
  }

  const key = loginKey(req, username);

  if (loginBlocked(key)) {
    return res.status(429).json({
      error: "Too many attempts. Wait a few minutes."
    });
  }

  const user = selectUserByName.get(username);

  if (!user) {
    registerFailure(key);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const expected = Buffer.from(user.password_hash, "hex");
  const actual = crypto.scryptSync(authHash, user.password_salt, 64);

  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    registerFailure(key);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  loginAttempts.delete(key);
  const token = createSession(user.id);

  res.json({
    token,
    user: serializeUser(user),
    publicKey: user.public_key,
    encryptedPrivateKey: user.encrypted_private_key,
    keySalt: user.key_salt
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  deleteSession.run(req.tokenHash);
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ user: serializeUser(req.user) });
});

app.put("/api/me", requireAuth, (req, res) => {
  const body = req.body || {};

  const bio = cleanText(body.bio ?? "", 500);
  const pronouns = cleanText(body.pronouns ?? "", 40);
  const status = cleanText(body.status ?? "", 80);
  const avatar = typeof body.avatar === "string" ? body.avatar.trim() : "";
  const banner = typeof body.banner === "string" ? body.banner.trim() : "";

  if (bio === null || pronouns === null || status === null) {
    return res.status(400).json({ error: "Invalid profile data." });
  }

  if (!validImage(avatar, 700000)) {
    return res.status(400).json({ error: "Invalid or too large photo." });
  }

  if (!validImage(banner, 1700000)) {
    return res.status(400).json({ error: "Invalid or too large banner." });
  }

  const links = normalizeLinks(body.links);
  if (!links.ok) {
    return res.status(400).json({ error: "One of the links is invalid." });
  }

  updateProfile.run(
    avatar,
    banner,
    bio,
    pronouns,
    status,
    JSON.stringify(links.value),
    req.user.id
  );

  const user = selectUserById.get(req.user.id);
  res.json({ user: serializeUser(user) });
});

app.get("/api/users", requireAuth, (req, res) => {
  const rawQuery =
    typeof req.query.q === "string" ? req.query.q.trim().slice(0, 40) : "";
  const query = rawQuery.replace(/^[@#]+/, "").trim();

  let rows;

  if (query) {
    const escaped = query.replace(/[\\%_]/g, (ch) => "\\" + ch);
    const digits = query.replace(/\D/g, "");

    if (digits) {
      rows = db
        .prepare(
          "SELECT * FROM users WHERE id <> ? " +
            "AND (username LIKE ? ESCAPE '\\' " +
            "OR REPLACE(REPLACE(REPLACE(number, '+', ''), ' ', ''), '-', '') " +
            "LIKE ? ESCAPE '\\') " +
            "ORDER BY username COLLATE NOCASE LIMIT 50"
        )
        .all(req.user.id, `%${escaped}%`, `%${digits}%`);
    } else {
      rows = db
        .prepare(
          "SELECT * FROM users WHERE id <> ? " +
            "AND username LIKE ? ESCAPE '\\' " +
            "ORDER BY username COLLATE NOCASE LIMIT 50"
        )
        .all(req.user.id, `%${escaped}%`);
    }
  } else {
    rows = db
      .prepare(
        "SELECT * FROM users WHERE id <> ? " +
          "ORDER BY username COLLATE NOCASE LIMIT 50"
      )
      .all(req.user.id);
  }

  res.set("Cache-Control", "no-store");
  res.json({
    users: rows.map((row) => ({
      ...serializeUser(row),
      ...blockStatus(req.user.id, row.id)
    }))
  });
});

app.get("/api/users/:identifier", requireAuth, (req, res) => {
  const identifier = req.params.identifier.replace(/^[@#]+/, "").trim();
  const digits = identifier.replace(/\D/g, "");
  const user =
    selectUserByName.get(identifier) ||
    (digits ? selectUserByDigits.get(digits) : null);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }
  res.set("Cache-Control", "no-store");
  res.json({
    user: {
      ...serializeUser(user),
      ...blockStatus(req.user.id, user.id)
    }
  });
});

app.get("/api/blocks", requireAuth, (req, res) => {
  const rows = selectBlockedUsers.all(req.user.id);
  res.set("Cache-Control", "no-store");
  res.json({ users: rows.map(serializeUser) });
});

app.post("/api/users/:identifier/block", requireAuth, (req, res) => {
  const target = findUserByIdentifier(req.params.identifier);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: "You cannot block yourself." });
  }

  insertBlock.run(req.user.id, target.id, nowISO());
  sendToUser(target.id, {
    type: "block-update",
    blocked: true,
    by: { id: req.user.id, username: req.user.username }
  });

  for (const [callId, call] of activeCalls) {
    const involvesTarget =
      (call.callerId === req.user.id && call.calleeId === target.id) ||
      (call.callerId === target.id && call.calleeId === req.user.id);
    if (!involvesTarget) continue;
    activeCalls.delete(callId);
    closeCallHistory(callId, "blocked");
    for (const userId of [call.callerId, call.calleeId]) {
      sendToUser(userId, {
        type: "call-end",
        callId,
        reason: "User blocked."
      });
    }
  }

  res.json({
    blocked: true,
    user: {
      ...serializeUser(target),
      blockedByMe: true,
      blockedMe: Boolean(selectBlock.get(target.id, req.user.id))
    }
  });
});

app.delete("/api/users/:identifier/block", requireAuth, (req, res) => {
  const target = findUserByIdentifier(req.params.identifier);
  if (!target) {
    return res.status(404).json({ error: "User not found." });
  }
  deleteBlock.run(req.user.id, target.id);
  sendToUser(target.id, {
    type: "block-update",
    blocked: false,
    by: { id: req.user.id, username: req.user.username }
  });
  res.json({
    blocked: false,
    user: {
      ...serializeUser(target),
      blockedByMe: false,
      blockedMe: Boolean(selectBlock.get(target.id, req.user.id))
    }
  });
});

app.get("/api/conversations", requireAuth, (req, res) => {
  const rows = selectConversationRows.all(
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id
  );

  const unread = new Map(
    selectUnreadCounts
      .all(req.user.id)
      .map((row) => [row.other_id, Number(row.total)])
  );
  const blockedByMe = new Set(
    selectBlockedIds.all(req.user.id).map((row) => row.blocked_id)
  );
  const blockedMe = new Set(
    selectBlockerIds.all(req.user.id).map((row) => row.blocker_id)
  );

  const chats = rows.map((row) => {
    const fromMe = Boolean(row.from_me);
    return {
      user: {
        id: row.user_id,
        username: row.user_username,
        number: row.user_number,
        publicKey: row.user_public_key,
        avatar: row.user_avatar || "",
        banner: row.user_banner || "",
        bio: row.user_bio || "",
        pronouns: row.user_pronouns || "",
        status: row.user_status || "",
        links: parseLinks(row.user_links),
        createdAt: row.user_created_at,
        blockedByMe: blockedByMe.has(row.user_id),
        blockedMe: blockedMe.has(row.user_id)
      },
      lastMessage: {
        id: row.id,
        fromMe,
        ephemeralPublicKey: fromMe
          ? row.sender_ephemeral_public_key
          : row.ephemeral_public_key,
        iv: fromMe ? row.sender_iv : row.iv,
        ciphertext: fromMe ? row.sender_ciphertext : row.ciphertext,
        read: Boolean(row.read_at),
        createdAt: row.created_at
      },
      unread: unread.get(row.user_id) || 0
    };
  });

  res.set("Cache-Control", "no-store");
  res.json({ chats });
});

app.get("/api/messages/:username", requireAuth, (req, res) => {
  const identifier = req.params.username.replace(/^[@#]+/, "").trim();
  const digits = identifier.replace(/\D/g, "");
  const other =
    selectUserByName.get(identifier) ||
    (digits ? selectUserByDigits.get(digits) : null);
  if (!other) {
    return res.status(404).json({ error: "User not found." });
  }

  const after = Number.parseInt(req.query.after, 10);
  let rows;

  if (Number.isSafeInteger(after) && after > 0) {
    rows = selectPairAfter.all(
      req.user.id,
      other.id,
      other.id,
      req.user.id,
      after
    );
  } else {
    rows = selectPairLatest.all(
      req.user.id,
      other.id,
      other.id,
      req.user.id
    );
  }

  const readInfo = markConversationRead.run(nowISO(), req.user.id, other.id);
  if (Number(readInfo.changes) > 0) {
    sendToUser(other.id, { type: "read", by: serializeUser(req.user) });
  }

  const blocks = blockStatus(req.user.id, other.id);
  const calls = selectCallHistoryPair.all(
    req.user.id,
    other.id,
    other.id,
    req.user.id
  );
  res.set("Cache-Control", "no-store");
  res.json({
    user: {
      ...serializeUser(other),
      ...blocks
    },
    messages: rows.map((row) => serializeMessage(row, req.user.id)),
    calls: calls.map((row) => serializeCallHistory(row, req.user.id)),
    ...blocks
  });
});

app.post("/api/messages", requireAuth, (req, res) => {
  const body = req.body || {};
  const to = typeof body.to === "string" ? body.to.trim() : "";

  if (!to || to.length > 40) {
    return res.status(400).json({ error: "Invalid recipient." });
  }

  const digits = to.replace(/\D/g, "");
  const recipient =
    selectUserByName.get(to) ||
    (digits ? selectUserByDigits.get(digits) : null);
  if (!recipient) {
    return res.status(404).json({ error: "Recipient not found." });
  }

  if (recipient.id === req.user.id) {
    return res.status(400).json({ error: "Choose another recipient." });
  }

  if (selectBlock.get(req.user.id, recipient.id)) {
    return res
      .status(403)
      .json({ error: "Unblock this user before sending messages." });
  }
  if (selectBlock.get(recipient.id, req.user.id)) {
    return res.status(403).json({ error: "This user has blocked you." });
  }

  const ephemeral = decodeB64url(body.ephemeralPublicKey, 200);
  const iv = decodeB64url(body.iv, 100);
  const ciphertext = decodeB64url(body.ciphertext, MAX_MESSAGE_BYTES);
  const senderEphemeral = decodeB64url(body.senderEphemeralPublicKey, 200);
  const senderIv = decodeB64url(body.senderIv, 100);
  const senderCiphertext = decodeB64url(
    body.senderCiphertext,
    MAX_MESSAGE_BYTES
  );

  const validKey = (bytes) =>
    bytes && bytes.length === 65 && bytes[0] === 4;

  if (
    !validKey(ephemeral) ||
    !validKey(senderEphemeral) ||
    !iv ||
    iv.length !== 12 ||
    !senderIv ||
    senderIv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < 16 ||
    !senderCiphertext ||
    senderCiphertext.length < 16
  ) {
    return res.status(400).json({ error: "Invalid message data." });
  }

  const createdAt = nowISO();
  const info = insertMessage.run(
    req.user.id,
    recipient.id,
    body.ephemeralPublicKey,
    body.iv,
    body.ciphertext,
    body.senderEphemeralPublicKey,
    body.senderIv,
    body.senderCiphertext,
    createdAt
  );
  const messageId = Number(info.lastInsertRowid);

  sendToUser(recipient.id, {
    type: "message",
    messageId,
    from: serializeUser(req.user),
    createdAt
  });

  res.status(201).json({ id: messageId, createdAt });
});

app.delete("/api/messages/:id", requireAuth, (req, res) => {
  const messageId = positiveInt(req.params.id);
  if (!messageId) {
    return res.status(400).json({ error: "Invalid message." });
  }

  const message = selectMessageForDelete.get(messageId);
  if (
    !message ||
    (message.sender_id !== req.user.id && message.recipient_id !== req.user.id)
  ) {
    return res.status(404).json({ error: "Message not found." });
  }
  if (message.sender_id !== req.user.id) {
    return res.status(403).json({ error: "You can only delete your own messages." });
  }

  deleteMessageById.run(messageId);
  const event = {
    type: "message-deleted",
    scope: "direct",
    messageId,
    senderId: message.sender_id,
    recipientId: message.recipient_id
  };
  sendToUser(message.sender_id, event);
  sendToUser(message.recipient_id, event);
  res.json({ success: true });
});

app.post("/api/groups", requireAuth, (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name, 80);
  const description = cleanText(body.description ?? "", 500);
  const avatar = typeof body.avatar === "string" ? body.avatar.trim() : "";
  const visibility = body.visibility === "public" ? "public" : "private";
  const topicStyle = body.topicStyle === "list" ? "list" : "chips";
  let inviteCode = null;

  if (!name || description === null) {
    return res.status(400).json({ error: "Invalid group name or description." });
  }
  if (!validImage(avatar, 700000)) {
    return res.status(400).json({ error: "Invalid or too large group photo." });
  }
  if (visibility === "public") {
    const requested =
      body.inviteCode === undefined || body.inviteCode === null
        ? ""
        : String(body.inviteCode).trim();
    if (requested) {
      inviteCode = normalizeInviteCode(requested);
      if (!inviteCode) {
        return res.status(400).json({
          error:
            "Invite code must be 3-32 characters using letters, numbers, - or _."
        });
      }
      if (selectGroupByInviteCode.get(inviteCode)) {
        return res.status(409).json({ error: "That invite code is already in use." });
      }
    } else {
      inviteCode = uniqueInviteCode();
    }
  }

  const createdAt = nowISO();
  db.exec("BEGIN");
  try {
    const groupInfo = insertGroup.run(
      name,
      description,
      avatar,
      visibility,
      inviteCode,
      topicStyle,
      req.user.id,
      createdAt
    );
    const groupId = Number(groupInfo.lastInsertRowid);
    const defaultInfo = insertGroupRole.run(
      groupId,
      "Member",
      "#8a9aa8",
      JSON.stringify(DEFAULT_ROLE_PERMISSIONS),
      1,
      0,
      createdAt
    );
    const defaultRoleId = Number(defaultInfo.lastInsertRowid);
    insertGroupRole.run(
      groupId,
      "Admin",
      "#5eb5f7",
      JSON.stringify(ADMIN_ROLE_PERMISSIONS),
      0,
      10,
      createdAt
    );
    insertGroupMember.run(groupId, req.user.id, defaultRoleId, createdAt);
    const channelInfo = insertGroupChannel.run(
      groupId,
      "general",
      "General discussion",
      "text",
      0,
      createdAt
    );
    const channelId = Number(channelInfo.lastInsertRowid);
    insertGroupTopic.run(
      groupId,
      channelId,
      "General",
      "",
      req.user.id,
      0,
      createdAt
    );
    db.exec("COMMIT");
    res.status(201).json({ group: getGroupDetails(groupId, req.user.id) });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});

app.get("/api/groups", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT g.* FROM chat_groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ?
       ORDER BY g.id DESC`
    )
    .all(req.user.id);
  const groups = rows
    .map((row) => getGroupSummary(row, req.user.id))
    .filter(Boolean);
  res.set("Cache-Control", "no-store");
  res.json({ groups });
});

function findPublicInvite(code) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  const group = selectGroupByInviteCode.get(normalized);
  if (!group || group.visibility !== "public" || !group.invite_code) return null;
  return group;
}

app.get("/api/invites/:code", (req, res) => {
  const group = findPublicInvite(req.params.code);
  if (!group) {
    return res.status(404).json({ error: "Invite not found or group is private." });
  }
  res.set("Cache-Control", "no-store");
  res.json({
    invite: {
      code: group.invite_code,
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        avatar: group.avatar,
        memberCount: selectGroupMembers.all(group.id).length,
        createdAt: group.created_at
      }
    }
  });
});

app.post("/api/invites/:code/join", requireAuth, (req, res) => {
  const group = findPublicInvite(req.params.code);
  if (!group) {
    return res.status(404).json({ error: "Invite not found or group is private." });
  }
  if (selectGroupMember.get(group.id, req.user.id)) {
    return res.json({ group: getGroupDetails(group.id, req.user.id) });
  }
  const defaultRole = selectDefaultRole.get(group.id);
  insertGroupMember.run(
    group.id,
    req.user.id,
    defaultRole ? defaultRole.id : null,
    nowISO()
  );
  res.status(201).json({ group: getGroupDetails(group.id, req.user.id) });
});

app.get("/invite/:code", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "invite.html"));
});

app.get("/api/groups/:id", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const group = getGroupDetails(groupId, req.user.id);
  if (!group) return res.status(404).json({ error: "Group not found." });
  res.set("Cache-Control", "no-store");
  res.json({ group });
});

app.put("/api/groups/:id", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_group")) {
    return res.status(403).json({ error: "You cannot manage this group." });
  }

  const body = req.body || {};
  const name =
    body.name === undefined ? access.group.name : cleanText(body.name, 80);
  const description =
    body.description === undefined
      ? access.group.description
      : cleanText(body.description, 500);
  const avatar =
    body.avatar === undefined
      ? access.group.avatar
      : typeof body.avatar === "string"
        ? body.avatar.trim()
        : null;
  const visibility =
    body.visibility === undefined
      ? access.group.visibility
      : body.visibility === "public" || body.visibility === "private"
        ? body.visibility
        : null;
  const topicStyle =
    body.topicStyle === undefined
      ? access.group.topic_style
      : body.topicStyle === "list" || body.topicStyle === "chips"
        ? body.topicStyle
        : null;

  if (
    !name ||
    description === null ||
    avatar === null ||
    !visibility ||
    !topicStyle
  ) {
    return res.status(400).json({ error: "Invalid group data." });
  }
  if (!validImage(avatar, 700000)) {
    return res.status(400).json({ error: "Invalid or too large group photo." });
  }

  let inviteCode = null;
  if (visibility === "public") {
    const current = access.group.invite_code;
    if (body.inviteCode !== undefined) {
      const requested = String(body.inviteCode || "").trim();
      if (requested) {
        inviteCode = normalizeInviteCode(requested);
        if (!inviteCode) {
          return res.status(400).json({
            error:
              "Invite code must be 3-32 characters using letters, numbers, - or _."
          });
        }
        const existing = selectGroupByInviteCode.get(inviteCode);
        if (existing && existing.id !== groupId) {
          return res.status(409).json({
            error: "That invite code is already in use."
          });
        }
      } else {
        inviteCode = current || uniqueInviteCode();
      }
    } else {
      inviteCode = current || uniqueInviteCode();
    }
  }

  updateGroup.run(
    name,
    description,
    avatar,
    visibility,
    inviteCode,
    topicStyle,
    groupId
  );
  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.delete("/api/groups/:id", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (access.group.owner_id !== req.user.id) {
    return res.status(403).json({ error: "Only the owner can delete the group." });
  }
  deleteGroup.run(groupId);
  res.json({ success: true });
});

app.post("/api/groups/:id/members", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_members")) {
    return res.status(403).json({ error: "You cannot manage members." });
  }

  const body = req.body || {};
  const user = findUserByIdentifier(body.identifier);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (selectGroupMember.get(groupId, user.id)) {
    return res.status(409).json({ error: "That user is already a member." });
  }

  const defaultRole = selectDefaultRole.get(groupId);
  const roleId =
    body.roleId === undefined || body.roleId === null
      ? defaultRole
        ? defaultRole.id
        : null
      : positiveInt(body.roleId);
  if (roleId && !selectGroupRole.get(roleId, groupId)) {
    return res.status(400).json({ error: "Invalid role." });
  }

  insertGroupMember.run(groupId, user.id, roleId, nowISO());
  sendToUser(user.id, { type: "group-added", groupId });
  res.status(201).json({ group: getGroupDetails(groupId, req.user.id) });
});

app.put("/api/groups/:id/members/:userId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const targetId = positiveInt(req.params.userId);
  if (!groupId || !targetId) {
    return res.status(400).json({ error: "Invalid member." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_members")) {
    return res.status(403).json({ error: "You cannot manage members." });
  }
  if (targetId === access.group.owner_id) {
    return res.status(400).json({ error: "The owner role cannot be changed." });
  }
  if (!selectGroupMember.get(groupId, targetId)) {
    return res.status(404).json({ error: "Member not found." });
  }

  const roleId = positiveInt((req.body || {}).roleId);
  const role = roleId ? selectGroupRole.get(roleId, groupId) : null;
  if (!role) return res.status(400).json({ error: "Invalid role." });

  if (access.group.owner_id !== req.user.id) {
    const rolePermissions = parsePermissionList(role.permissions);
    if (rolePermissions.some((permission) => !access.permissions.has(permission))) {
      return res.status(403).json({
        error: "You cannot grant permissions you do not have."
      });
    }
  }

  updateGroupMemberRole.run(role.id, groupId, targetId);
  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.delete("/api/groups/:id/members/:userId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const targetId = positiveInt(req.params.userId);
  if (!groupId || !targetId) {
    return res.status(400).json({ error: "Invalid member." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (targetId === access.group.owner_id) {
    return res.status(400).json({ error: "The owner cannot be removed." });
  }
  if (targetId !== req.user.id && !access.permissions.has("manage_members")) {
    return res.status(403).json({ error: "You cannot manage members." });
  }
  if (!selectGroupMember.get(groupId, targetId)) {
    return res.status(404).json({ error: "Member not found." });
  }

  deleteGroupMember.run(groupId, targetId);
  if (targetId !== req.user.id) {
    sendToUser(targetId, { type: "group-removed", groupId });
  }
  res.json({ success: true, left: targetId === req.user.id });
});

app.post("/api/groups/:id/leave", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (access.group.owner_id === req.user.id) {
    return res.status(400).json({ error: "The owner cannot leave the group." });
  }
  deleteGroupMember.run(groupId, req.user.id);
  res.json({ success: true });
});

app.post("/api/groups/:id/roles", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_roles")) {
    return res.status(403).json({ error: "You cannot manage roles." });
  }

  const body = req.body || {};
  const name = cleanText(body.name, 40);
  const color =
    typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)
      ? body.color
      : null;
  const permissions = normalizePermissions(body.permissions);
  if (!name || !color || !permissions) {
    return res.status(400).json({ error: "Invalid role data." });
  }
  if (
    access.group.owner_id !== req.user.id &&
    permissions.some((permission) => !access.permissions.has(permission))
  ) {
    return res.status(403).json({
      error: "You cannot grant permissions you do not have."
    });
  }

  try {
    insertGroupRole.run(
      groupId,
      name,
      color,
      JSON.stringify(permissions),
      0,
      0,
      nowISO()
    );
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That role name is already in use." });
    }
    throw error;
  }

  res.status(201).json({ group: getGroupDetails(groupId, req.user.id) });
});

app.put("/api/groups/:id/roles/:roleId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const roleId = positiveInt(req.params.roleId);
  if (!groupId || !roleId) {
    return res.status(400).json({ error: "Invalid role." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_roles")) {
    return res.status(403).json({ error: "You cannot manage roles." });
  }

  const role = selectGroupRole.get(roleId, groupId);
  if (!role) return res.status(404).json({ error: "Role not found." });

  const body = req.body || {};
  const name = cleanText(body.name ?? role.name, 40);
  const color =
    body.color === undefined
      ? role.color
      : typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)
        ? body.color
        : null;
  const permissions =
    body.permissions === undefined
      ? parsePermissionList(role.permissions)
      : normalizePermissions(body.permissions);

  if (!name || !color || !permissions) {
    return res.status(400).json({ error: "Invalid role data." });
  }
  if (
    access.group.owner_id !== req.user.id &&
    permissions.some((permission) => !access.permissions.has(permission))
  ) {
    return res.status(403).json({
      error: "You cannot grant permissions you do not have."
    });
  }

  try {
    updateGroupRole.run(name, color, JSON.stringify(permissions), roleId);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That role name is already in use." });
    }
    throw error;
  }

  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.delete("/api/groups/:id/roles/:roleId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const roleId = positiveInt(req.params.roleId);
  if (!groupId || !roleId) {
    return res.status(400).json({ error: "Invalid role." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_roles")) {
    return res.status(403).json({ error: "You cannot manage roles." });
  }

  const role = selectGroupRole.get(roleId, groupId);
  if (!role) return res.status(404).json({ error: "Role not found." });
  if (role.is_default) {
    return res.status(400).json({ error: "The default role cannot be deleted." });
  }

  const defaultRole = selectDefaultRole.get(groupId);
  db.exec("BEGIN");
  try {
    if (defaultRole) {
      db.prepare(
        "UPDATE group_members SET role_id = ? WHERE group_id = ? AND role_id = ?"
      ).run(defaultRole.id, groupId, roleId);
    }
    deleteGroupRole.run(roleId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.post("/api/groups/:id/channels", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  if (!groupId) return res.status(400).json({ error: "Invalid group." });
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_channels")) {
    return res.status(403).json({ error: "You cannot manage channels." });
  }

  const body = req.body || {};
  const name = cleanText(body.name, 40);
  const description = cleanText(body.description ?? "", 300);
  const kind = body.kind === "announcement" ? "announcement" : "text";
  if (!name || description === null) {
    return res.status(400).json({ error: "Invalid channel data." });
  }

  const createdAt = nowISO();
  db.exec("BEGIN");
  try {
    const info = insertGroupChannel.run(
      groupId,
      name,
      description,
      kind,
      0,
      createdAt
    );
    const channelId = Number(info.lastInsertRowid);
    insertGroupTopic.run(
      groupId,
      channelId,
      "General",
      "",
      req.user.id,
      0,
      createdAt
    );
    if (kind === "announcement") {
      const defaultRole = selectDefaultRole.get(groupId);
      if (defaultRole) {
        insertChannelPermission.run(
          channelId,
          defaultRole.id,
          null,
          JSON.stringify(["view_channel"]),
          JSON.stringify(["send_messages", "send_media", "create_topics"])
        );
      }
    }
    db.exec("COMMIT");
    res.status(201).json({ group: getGroupDetails(groupId, req.user.id) });
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That channel name is already in use." });
    }
    throw error;
  }
});

app.put("/api/groups/:id/channels/:channelId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const channelId = positiveInt(req.params.channelId);
  if (!groupId || !channelId) {
    return res.status(400).json({ error: "Invalid channel." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  if (!access.permissions.has("manage_channels")) {
    return res.status(403).json({ error: "You cannot manage channels." });
  }
  const channel = selectGroupChannel.get(channelId, groupId);
  if (!channel) return res.status(404).json({ error: "Channel not found." });

  const body = req.body || {};
  const name = cleanText(body.name ?? channel.name, 40);
  const description = cleanText(
    body.description === undefined ? channel.description : body.description,
    300
  );
  const kind =
    body.kind === undefined
      ? channel.kind
      : body.kind === "announcement"
        ? "announcement"
        : "text";
  if (!name || description === null) {
    return res.status(400).json({ error: "Invalid channel data." });
  }

  try {
    updateGroupChannel.run(name, description, kind, channelId);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That channel name is already in use." });
    }
    throw error;
  }

  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.delete(
  "/api/groups/:id/channels/:channelId",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    if (!groupId || !channelId) {
      return res.status(400).json({ error: "Invalid channel." });
    }
    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    if (!access.permissions.has("manage_channels")) {
      return res.status(403).json({ error: "You cannot manage channels." });
    }
    const channel = selectGroupChannel.get(channelId, groupId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    if (selectGroupChannels.all(groupId).length <= 1) {
      return res.status(400).json({ error: "Keep at least one channel." });
    }

    deleteGroupChannel.run(channelId);
    res.json({ group: getGroupDetails(groupId, req.user.id) });
  }
);

app.put(
  "/api/groups/:id/channels/:channelId/permissions",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    if (!groupId || !channelId) {
      return res.status(400).json({ error: "Invalid channel." });
    }
    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    if (!access.permissions.has("manage_channels")) {
      return res.status(403).json({ error: "You cannot manage channels." });
    }
    if (!selectGroupChannel.get(channelId, groupId)) {
      return res.status(404).json({ error: "Channel not found." });
    }

    const body = req.body || {};
    const items = Array.isArray(body.overrides)
      ? body.overrides
      : [body];
    if (items.length > 500) {
      return res.status(400).json({ error: "Too many permission entries." });
    }

    const normalized = [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        return res.status(400).json({ error: "Invalid permission entry." });
      }
      const roleId =
        item.roleId === undefined || item.roleId === null
          ? null
          : positiveInt(item.roleId);
      const userId =
        item.userId === undefined || item.userId === null
          ? null
          : positiveInt(item.userId);
      if ((roleId && userId) || (!roleId && !userId)) {
        return res.status(400).json({
          error: "Each entry must target one role or one user."
        });
      }
      if (roleId && !selectGroupRole.get(roleId, groupId)) {
        return res.status(400).json({ error: "Invalid role." });
      }
      if (userId && !selectGroupMember.get(groupId, userId)) {
        return res.status(400).json({ error: "Invalid member." });
      }
      const allow = normalizePermissions(
        item.allow || [],
        CHANNEL_PERMISSIONS
      );
      const deny = normalizePermissions(item.deny || [], CHANNEL_PERMISSIONS);
      if (!allow || !deny) {
        return res.status(400).json({ error: "Invalid permission list." });
      }
      if (allow.length || deny.length) {
        normalized.push({ roleId, userId, allow, deny });
      }
    }

    db.exec("BEGIN");
    try {
      deleteChannelPermissions.run(channelId);
      for (const item of normalized) {
        insertChannelPermission.run(
          channelId,
          item.roleId,
          item.userId,
          JSON.stringify(item.allow),
          JSON.stringify(item.deny)
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    res.json({ group: getGroupDetails(groupId, req.user.id) });
  }
);

app.post(
  "/api/groups/:id/channels/:channelId/topics",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    if (!groupId || !channelId) {
      return res.status(400).json({ error: "Invalid channel." });
    }
    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    const channel = selectGroupChannel.get(channelId, groupId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const permissions = channelPermissionsFor(
      access.group,
      access.member,
      access.roles,
      channel
    );
    if (
      !permissions.has("create_topics") &&
      !permissions.has("manage_topics")
    ) {
      return res.status(403).json({ error: "You cannot create topics here." });
    }

    const body = req.body || {};
    const name = cleanText(body.name, 60);
    const emoji = cleanText(body.emoji ?? "", 8);
    if (!name || emoji === null) {
      return res.status(400).json({ error: "Invalid topic name or emoji." });
    }

    try {
      insertGroupTopic.run(
        groupId,
        channelId,
        name,
        emoji,
        req.user.id,
        0,
        nowISO()
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "That topic name is already in use." });
      }
      throw error;
    }

    res.status(201).json({ group: getGroupDetails(groupId, req.user.id) });
  }
);

app.put("/api/groups/:id/topics/:topicId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const topicId = positiveInt(req.params.topicId);
  if (!groupId || !topicId) {
    return res.status(400).json({ error: "Invalid topic." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  const topic = selectGroupTopic.get(topicId, groupId);
  if (!topic) return res.status(404).json({ error: "Topic not found." });
  const channel = selectGroupChannel.get(topic.channel_id, groupId);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  const permissions = channelPermissionsFor(
    access.group,
    access.member,
    access.roles,
    channel
  );
  const canManage =
    permissions.has("manage_topics") ||
    (topic.created_by === req.user.id && permissions.has("create_topics"));
  if (!canManage) {
    return res.status(403).json({ error: "You cannot manage this topic." });
  }

  const body = req.body || {};
  const name = cleanText(body.name ?? topic.name, 60);
  const emoji = cleanText(body.emoji ?? topic.emoji, 8);
  const closed =
    body.closed === undefined ? Boolean(topic.closed) : Boolean(body.closed);
  if (!name || emoji === null) {
    return res.status(400).json({ error: "Invalid topic name or emoji." });
  }

  try {
    updateGroupTopic.run(name, emoji, closed ? 1 : 0, topicId);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That topic name is already in use." });
    }
    throw error;
  }

  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.delete("/api/groups/:id/topics/:topicId", requireAuth, (req, res) => {
  const groupId = positiveInt(req.params.id);
  const topicId = positiveInt(req.params.topicId);
  if (!groupId || !topicId) {
    return res.status(400).json({ error: "Invalid topic." });
  }
  const access = loadGroupAccess(groupId, req.user.id);
  if (!access) return res.status(404).json({ error: "Group not found." });
  const topic = selectGroupTopic.get(topicId, groupId);
  if (!topic) return res.status(404).json({ error: "Topic not found." });
  const channel = selectGroupChannel.get(topic.channel_id, groupId);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  const permissions = channelPermissionsFor(
    access.group,
    access.member,
    access.roles,
    channel
  );
  if (!permissions.has("manage_topics")) {
    return res.status(403).json({ error: "You cannot manage topics." });
  }
  if (selectGroupTopics.all(topic.channel_id).length <= 1) {
    return res.status(400).json({ error: "Keep at least one topic in a channel." });
  }

  deleteGroupTopic.run(topicId);
  res.json({ group: getGroupDetails(groupId, req.user.id) });
});

app.get(
  "/api/groups/:id/channels/:channelId/topics/:topicId/messages",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    const topicId = positiveInt(req.params.topicId);
    if (!groupId || !channelId || !topicId) {
      return res.status(400).json({ error: "Invalid conversation." });
    }
    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    const channel = selectGroupChannel.get(channelId, groupId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const topic = selectGroupTopic.get(topicId, groupId);
    if (!topic || topic.channel_id !== channelId) {
      return res.status(404).json({ error: "Topic not found." });
    }
    const permissions = channelPermissionsFor(
      access.group,
      access.member,
      access.roles,
      channel
    );
    if (!permissions.has("view_channel")) {
      return res.status(403).json({ error: "You cannot view this channel." });
    }

    const after = Number.parseInt(req.query.after, 10);
    const rows =
      Number.isSafeInteger(after) && after > 0
        ? selectGroupTopicMessagesAfter.all(req.user.id, topicId, after)
        : selectGroupTopicMessagesLatest.all(req.user.id, topicId);
    const lastId = rows.length ? rows[rows.length - 1].id : after || 0;
    if (lastId > 0) {
      upsertGroupRead.run(
        req.user.id,
        groupId,
        channelId,
        topicId,
        lastId,
        nowISO()
      );
    }

    res.set("Cache-Control", "no-store");
    res.json({
      messages: rows.map((row) => serializeGroupMessage(row, req.user.id)),
      channel: {
        id: channel.id,
        name: channel.name,
        kind: channel.kind
      },
      topic: { id: topic.id, name: topic.name, closed: Boolean(topic.closed) }
    });
  }
);

app.post(
  "/api/groups/:id/channels/:channelId/topics/:topicId/messages",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    const topicId = positiveInt(req.params.topicId);
    if (!groupId || !channelId || !topicId) {
      return res.status(400).json({ error: "Invalid conversation." });
    }
    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    const channel = selectGroupChannel.get(channelId, groupId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const topic = selectGroupTopic.get(topicId, groupId);
    if (!topic || topic.channel_id !== channelId) {
      return res.status(404).json({ error: "Topic not found." });
    }
    if (topic.closed) {
      return res.status(403).json({ error: "This topic is closed." });
    }
    const permissions = channelPermissionsFor(
      access.group,
      access.member,
      access.roles,
      channel
    );
    if (!permissions.has("view_channel")) {
      return res.status(403).json({ error: "You cannot view this channel." });
    }

    const body = req.body || {};
    const kind = ["text", "image", "file", "audio"].includes(body.kind)
      ? body.kind
      : "text";
    if (kind === "text" && !permissions.has("send_messages")) {
      return res.status(403).json({ error: "You cannot send messages here." });
    }
    if (kind !== "text" && !permissions.has("send_media")) {
      return res.status(403).json({ error: "You cannot send media here." });
    }

    const iv = decodeB64url(body.iv, 100);
    const ciphertext = decodeB64url(body.ciphertext, MAX_MESSAGE_BYTES);
    if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length < 16) {
      return res.status(400).json({ error: "Invalid message data." });
    }

    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0 || keys.length > 500) {
      return res.status(400).json({ error: "Invalid message keys." });
    }

    const normalizedKeys = [];
    const seen = new Set();
    for (const key of keys) {
      if (!key || typeof key !== "object") {
        return res.status(400).json({ error: "Invalid message key." });
      }
      const userId = positiveInt(key.userId);
      if (!userId || seen.has(userId)) continue;
      if (!selectGroupMember.get(groupId, userId)) {
        return res.status(400).json({ error: "Invalid key recipient." });
      }
      const ephemeral = decodeB64url(key.ephemeralPublicKey, 200);
      const keyIv = decodeB64url(key.iv, 100);
      const keyCiphertext = decodeB64url(key.ciphertext, 3000);
      if (
        !ephemeral ||
        ephemeral.length !== 65 ||
        ephemeral[0] !== 4 ||
        !keyIv ||
        keyIv.length !== 12 ||
        !keyCiphertext ||
        keyCiphertext.length < 16
      ) {
        return res.status(400).json({ error: "Invalid message key." });
      }
      seen.add(userId);
      normalizedKeys.push({
        userId,
        ephemeralPublicKey: key.ephemeralPublicKey,
        iv: key.iv,
        ciphertext: key.ciphertext
      });
    }
    if (!seen.has(req.user.id)) {
      return res.status(400).json({ error: "The sender key is required." });
    }

    const createdAt = nowISO();
    let messageId;
    db.exec("BEGIN");
    try {
      const info = insertGroupMessage.run(
        groupId,
        channelId,
        topicId,
        req.user.id,
        kind,
        body.iv,
        body.ciphertext,
        createdAt
      );
      messageId = Number(info.lastInsertRowid);
      for (const key of normalizedKeys) {
        insertGroupMessageKey.run(
          messageId,
          key.userId,
          key.ephemeralPublicKey,
          key.iv,
          key.ciphertext
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const from = serializeUser(req.user);
    for (const row of selectGroupMemberIds.all(groupId)) {
      sendToUser(row.user_id, {
        type: "group-message",
        groupId,
        channelId,
        topicId,
        messageId,
        from,
        kind,
        createdAt
      });
    }

    res.status(201).json({ id: messageId, createdAt });
  }
);

app.delete(
  "/api/groups/:id/channels/:channelId/topics/:topicId/messages/:messageId",
  requireAuth,
  (req, res) => {
    const groupId = positiveInt(req.params.id);
    const channelId = positiveInt(req.params.channelId);
    const topicId = positiveInt(req.params.topicId);
    const messageId = positiveInt(req.params.messageId);
    if (!groupId || !channelId || !topicId || !messageId) {
      return res.status(400).json({ error: "Invalid message." });
    }

    const access = loadGroupAccess(groupId, req.user.id);
    if (!access) return res.status(404).json({ error: "Group not found." });
    const channel = selectGroupChannel.get(channelId, groupId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });
    const topic = selectGroupTopic.get(topicId, groupId);
    if (!topic || topic.channel_id !== channelId) {
      return res.status(404).json({ error: "Topic not found." });
    }

    const permissions = channelPermissionsFor(
      access.group,
      access.member,
      access.roles,
      channel
    );
    if (!permissions.has("view_channel")) {
      return res.status(403).json({ error: "You cannot view this channel." });
    }

    const message = selectGroupMessageForDelete.get(messageId);
    if (
      !message ||
      message.group_id !== groupId ||
      message.channel_id !== channelId ||
      message.topic_id !== topicId
    ) {
      return res.status(404).json({ error: "Message not found." });
    }
    if (
      message.sender_id !== req.user.id &&
      !permissions.has("manage_messages")
    ) {
      return res.status(403).json({ error: "You cannot delete this message." });
    }

    deleteGroupMessageById.run(messageId);
    const event = {
      type: "message-deleted",
      scope: "group",
      groupId,
      channelId,
      topicId,
      messageId
    };
    for (const row of selectGroupMemberIds.all(groupId)) {
      sendToUser(row.user_id, event);
    }
    res.json({ success: true });
  }
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.use((error, _req, res, _next) => {
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ error: "File or request too large." });
  }
  if (error instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON." });
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 65536 });

wss.on("connection", (socket, request) => {
  let token = "";
  try {
    token = new URL(request.url, "http://localhost").searchParams.get("token") || "";
  } catch {
    token = "";
  }

  const row =
    token.length >= 20 && token.length <= 200
      ? selectSessionUser.get(sha256(token))
      : null;

  if (!row || row.session_expires_at < nowISO()) {
    socket.close(4001, "unauthorized");
    return;
  }

  const userId = row.id;
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(socket);
  socket.isAlive = true;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  let signalCount = 0;
  let signalWindow = Date.now() + 1000;
  socket.on("message", (raw) => {
    const now = Date.now();
    if (now > signalWindow) {
      signalCount = 0;
      signalWindow = now + 1000;
    }
    signalCount += 1;
    if (signalCount > 200) return;

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleCallSignal(socket, userId, row, data);
  });

  socket.on("close", () => {
    endCallsForSocket(socket, userId);
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) socketsByUser.delete(userId);
  });

  socket.on("error", () => {});

  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ type: "ready" }));
  }
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Talkie running at http://${HOST}:${PORT}`);
});

const activeCalls = new Map();
const CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

function findCallForUser(userId) {
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.calleeId === userId) return call;
  }
  return null;
}

function callPeerId(call, userId) {
  return call.callerId === userId ? call.calleeId : call.callerId;
}

function callSdp(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 30000
    ? value
    : "";
}

function callSignalCandidate(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.candidate !== "string" || value.candidate.length > 2000) {
    return null;
  }
  if (value.sdpMid != null && typeof value.sdpMid !== "string") return null;
  if (
    value.sdpMLineIndex != null &&
    (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)
  ) {
    return null;
  }
  return {
    candidate: value.candidate,
    sdpMid: typeof value.sdpMid === "string" ? value.sdpMid.slice(0, 64) : null,
    sdpMLineIndex:
      value.sdpMLineIndex == null ? null : Number(value.sdpMLineIndex),
    usernameFragment:
      typeof value.usernameFragment === "string"
        ? value.usernameFragment.slice(0, 256)
        : null
  };
}

function beginCallHistory(callId, callerId, calleeId) {
  try {
    insertCallHistory.run(callId, callerId, calleeId, nowISO());
  } catch {
    // Call history must never block signaling.
  }
}

function answerCallHistory(callId) {
  try {
    markCallHistoryAnswered.run(nowISO(), callId);
  } catch {
    // Ignore history failures.
  }
}

function closeCallHistory(callId, status) {
  try {
    const row = selectCallHistory.get(callId);
    if (!row || row.ended_at) return;
    const endedAt = nowISO();
    const answered = Boolean(row.answered_at);
    const finalStatus = answered ? "completed" : status;
    let duration = 0;
    if (answered) {
      const started = Date.parse(row.answered_at);
      const ended = Date.parse(endedAt);
      if (Number.isFinite(started) && Number.isFinite(ended)) {
        duration = Math.max(0, Math.round((ended - started) / 1000));
      }
    }
    markCallHistoryEnded.run(finalStatus, endedAt, duration, callId);
  } catch {
    // Ignore history failures.
  }
}

function handleCallSignal(socket, userId, userRow, data) {
  if (!data || typeof data.type !== "string") return;
  if (!data.type.startsWith("call-")) return;

  const callId =
    typeof data.callId === "string" && CALL_ID_PATTERN.test(data.callId)
      ? data.callId
      : "";
  if (!callId) return;

  if (data.type === "call-offer") {
    if (activeCalls.has(callId)) return;

    const to =
      typeof data.to === "string"
        ? data.to.trim().replace(/^[@#]+/, "").slice(0, 40)
        : "";
    const target = to ? selectUserByName.get(to) : null;
    if (!target || target.id === userId) {
      sendToUser(userId, {
        type: "call-unavailable",
        callId,
        reason: "User not found."
      });
      return;
    }

    if (
      selectBlock.get(userId, target.id) ||
      selectBlock.get(target.id, userId)
    ) {
      sendToUser(userId, {
        type: "call-unavailable",
        callId,
        reason: "This user is unavailable for calls."
      });
      return;
    }

    const sdp = callSdp(data.sdp);
    if (!sdp) return;

    if (!socketsByUser.has(target.id)) {
      sendToUser(userId, {
        type: "call-unavailable",
        callId,
        reason: "User is offline."
      });
      return;
    }

    if (findCallForUser(userId) || findCallForUser(target.id)) {
      sendToUser(userId, {
        type: "call-busy",
        callId,
        reason: "One of the participants is already in a call."
      });
      return;
    }

    const call = {
      id: callId,
      callerId: userId,
      calleeId: target.id,
      callerSocket: socket,
      calleeSocket: null,
      calleeSockets: new Set(socketsByUser.get(target.id) || []),
      createdAt: Date.now()
    };
    activeCalls.set(callId, call);
    beginCallHistory(callId, userId, target.id);
    sendToUser(target.id, {
      type: "call-offer",
      callId,
      from: serializeUser(userRow),
      sdp
    });
    return;
  }

  const call = activeCalls.get(callId);
  if (!call) return;
  if (call.callerId !== userId && call.calleeId !== userId) return;

  if (data.type === "call-answer") {
    if (userId !== call.calleeId) return;
    const sdp = callSdp(data.sdp);
    if (!sdp) return;
    call.calleeSocket = socket;
    answerCallHistory(callId);
    sendToUser(call.callerId, { type: "call-answer", callId, sdp });
    return;
  }

  if (data.type === "call-ice") {
    const candidate = callSignalCandidate(data.candidate);
    if (!candidate) return;
    sendToUser(callPeerId(call, userId), {
      type: "call-ice",
      callId,
      candidate
    });
    return;
  }

  if (data.type === "call-renegotiate") {
    const sdp = callSdp(data.sdp);
    if (!sdp) return;
    sendToUser(callPeerId(call, userId), {
      type: "call-renegotiate",
      callId,
      sdp
    });
    return;
  }

  if (data.type === "call-renegotiate-answer") {
    const sdp = callSdp(data.sdp);
    if (!sdp) return;
    sendToUser(callPeerId(call, userId), {
      type: "call-renegotiate-answer",
      callId,
      sdp
    });
    return;
  }

  if (data.type === "call-reject") {
    activeCalls.delete(callId);
    closeCallHistory(callId, "declined");
    const reason = cleanText(data.reason ?? "", 120) || "Call declined.";
    sendToUser(callPeerId(call, userId), {
      type: "call-reject",
      callId,
      reason
    });
    return;
  }

  if (data.type === "call-end") {
    activeCalls.delete(callId);
    closeCallHistory(callId, "canceled");
    sendToUser(callPeerId(call, userId), { type: "call-end", callId });
  }
}

function endCallsForSocket(socket, userId) {
  for (const [callId, call] of activeCalls) {
    let ended = false;
    if (call.callerSocket === socket || call.calleeSocket === socket) {
      ended = true;
    } else if (!call.calleeSocket && call.calleeSockets) {
      call.calleeSockets.delete(socket);
      if (call.calleeSockets.size === 0) ended = true;
    }
    if (!ended) continue;
    activeCalls.delete(callId);
    closeCallHistory(
      callId,
      userId === call.callerId ? "canceled" : "missed"
    );
    sendToUser(callPeerId(call, userId), { type: "call-end", callId });
  }
}
