# Talkie

Talkie is a small end-to-end encrypted chat application with a Telegram-style
interface. It runs on Node.js, stores users and messages in SQLite, and keeps
message contents encrypted in the browser before they ever reach the server.

## Features

- Username and password registration and login
- Automatic unique user number in the format `+432 3443-4343`
- Start a conversation by username, formatted number, or plain digits
- Telegram-style dark interface with a chat list and conversation panel
- One-to-one text messages
- File, image, and recorded audio attachments
- Custom voice-message player with waveform, seek, and per-direction colors
- Group chats with channels, topics, roles, and per-channel permissions
- Public groups with custom `/invite/<code>` links and private invite-only groups
- Topic emoji, topic management for admins, and chip or list topic layouts
- End-to-end encryption using ECDH P-256 and AES-256-GCM
- Encrypted copy of each message for both sender and recipient
- Encrypted group message keys for every current member
- Profile photo, banner, bio, pronouns, status, and up to 8 links
- Real-time message and read-receipt notifications over WebSocket
- Private peer-to-peer audio and video calls with screen sharing and fullscreen
- Microphone and speaker mute, call volume, configurable screen FPS and resolution
- Call history in direct chats with status and duration
- One-way user blocking for direct messages and calls
- Notification sound generated with the Web Audio API
- Unread counters and message read indicators
- SQLite persistence with WAL mode

## Requirements

- Node.js 20 or newer (the project uses `better-sqlite3`)
- A modern browser with Web Crypto and WebSocket support
- `localhost` or HTTPS. Web Crypto is not available on plain HTTP for
  non-localhost origins.

## Quick start

```bash
npm install
npm start
```

Open <http://127.0.0.1:3000>.

For development with automatic restarts:

```bash
npm run dev
```

Environment variables:

| Variable | Default     | Description          |
| -------- | ----------- | -------------------- |
| `PORT`   | `3000`      | HTTP/WebSocket port  |
| `HOST`   | `127.0.0.1` | Address to bind      |

## User numbers

When an account is created, the server generates a unique number in the format:

```text
+XXX XXXX-XXXX
```

For example: `+432 3443-4343`.

Users can be found by:

- username: `alice`
- formatted number: `+432 3443-4343`
- digits only: `43234434343`
- with a leading `@` or `#`: `@alice`, `#43234434343`

## Project structure

```text
talkie/
  index.js            Express server, SQLite database, REST API, WebSocket
  package.json
  data/
    talkie.db         Created automatically at runtime
  public/
    index.html        Application shell and modals
    app.js            UI, client-side cryptography, WebSocket client
    invite.html       Standalone public group invite page
    invite.js         Invite page logic and join flow
    styles.css        Telegram-inspired dark theme
  README.md
```

## How end-to-end encryption works

### Registration

1. The browser derives an authentication hash from the password with PBKDF2
   (210,000 iterations, SHA-256). The password itself is never sent.
2. The browser generates a random 16-byte key salt and derives a key-encryption
   key (KEK) from the password with PBKDF2 (260,000 iterations, SHA-256).
3. The browser generates an ECDH P-256 key pair.
4. The private key is exported as JWK, encrypted with AES-256-GCM using the KEK,
   and sent to the server together with the public key.
5. The server hashes the authentication hash with scrypt and stores the result.
   It never receives the password or the plaintext private key.

### Login

1. The browser sends the PBKDF2 authentication hash.
2. The server verifies it against the stored scrypt hash.
3. The server returns the encrypted private key blob and key salt.
4. The browser derives the KEK from the password, decrypts the private key
   locally, and imports it as a non-extractable Web Crypto key.

### Sending a message

1. The sender fetches the recipient's public key.
2. For every message, the sender generates a new ephemeral ECDH P-256 key pair.
3. ECDH derives a one-time AES-256 key.
4. The plaintext is encrypted with AES-256-GCM and a random 12-byte IV.
5. The process is repeated to create a second encrypted copy for the sender, so
   sent messages can be read later on another device.
6. Only ciphertext, the ephemeral public key, and the IV are stored by the
   server.

### Receiving a message

The recipient fetches the ciphertext and decrypts it locally with their private
key. The server cannot read message contents.

### Attachments and voice messages

Attachments are encrypted with the same message envelope as text. The payload
inside the ciphertext is JSON:

```json
{
  "text": "Optional caption",
  "attachment": {
    "name": "photo.jpg",
    "type": "image/jpeg",
    "size": 123456,
    "data": "<base64>"
  }
}
```

- Files are limited to 2 MB before encryption.
- Images are resized in the browser to at most 1600px and re-encoded as JPEG.
- The microphone button records up to 120 seconds with `MediaRecorder` and
  attaches the result as an audio message.
- Voice messages use a custom player with play/pause, seek, elapsed and total
  time, a waveform-style progress bar, and different accent colors for incoming
  and outgoing bubbles.
- The server enforces a 9 MB ciphertext limit and an 18 MB JSON body limit.
- Blob URLs are created locally for display; the server only stores ciphertext.

### Private calls

Calls are one-to-one and use WebRTC directly between the two browsers. Media
never passes through the Talkie server; the WebSocket only relays call offers,
answers, ICE candidates, renegotiation, and hang-up signals. WebRTC encrypts
media in transit with DTLS-SRTP.

- Audio is requested with echo cancellation, noise suppression, and automatic
  gain control for low-latency voice.
- The microphone and the remote call audio can be muted independently. A volume
  slider adjusts remote call audio, and setting it to zero mutes the call.
- The shared screen can be opened in fullscreen from the call controls or by
  double-clicking the remote video.
- Screen sharing supports optional tab/system audio and configurable FPS
  (15/24/30/60) and resolution (480p/720p/1080p/1440p/4K).
- Screen sharing can be started or stopped by either participant; changing the
  FPS or resolution applies immediately while sharing.
- A public STUN server is used for NAT traversal. For reliable calls across
  restrictive NATs or corporate networks, configure a TURN server in
  `CALL_ICE_SERVERS` in `public/app.js`.
- Ended calls are stored as server-side metadata in `call_history` and shown
  inline in both participants' direct chat timeline. History includes outgoing,
  incoming, missed, declined, blocked, and no-answer states plus call duration.
  Only calls whose offer reached the recipient are recorded.

No network can guarantee zero latency. Talkie avoids a media relay in the
common case and uses direct peer-to-peer transport, so latency is limited by the
route between the two browsers. Lower FPS and resolution reduce encoding and
bandwidth pressure when the connection is slow.

### Blocking

Blocking is one-way and stored in the `user_blocks` table. A blocked user cannot
send new direct messages to the blocker, and the blocker cannot send messages
until unblocking. Blocking also ends an active call between the two users and
prevents new calls in both directions.

Blocking does not remove either user from shared groups, delete existing
messages, or hide public profiles. Unblocking restores direct messaging and
calling immediately.

### Groups

Group messages use a per-message random AES-256-GCM content key. The content is
encrypted once, then the content key is wrapped separately for every current
member with ECDH P-256 and AES-256-GCM. The server stores the ciphertext and one
wrapped key per recipient in `group_message_keys`. A member who joins later
cannot read earlier messages.

Each group starts with:

- A default `Member` role: view channel, send messages, send media, create
  topics.
- An `Admin` role with every group permission.
- A `#general` text channel with a `General` topic.

Channels can be `text` or `announcement`. Announcement channels only allow
members with management permissions to post. Topics can be created, closed, and
deleted, and can have a short emoji. The owner always has full access.

### Public and private groups

A group is private by default. Private groups can only grow when a member with
`manage_members` adds someone by username or number.

A public group gets a shareable link:

```text
http://127.0.0.1:3000/invite/<code>
```

The owner or an admin can choose a custom code (3-32 letters, numbers, `-`, or
`_`) or leave it blank to generate one. The invite page is public and shows the
group name, photo, description, and member count. Joining requires a Talkie
account; the invite is added to the current session after login.

Switching a group back to private disables the invite link.

### Topic display and management

Each group can display topics in one of two layouts:

- `chips`: the compact horizontal topic bar.
- `list`: a vertical topic list styled like the conversation list.

Members with `manage_topics` see a `Manage` button next to the topics. The
management dialog can rename topics, set an emoji, close or reopen a topic, and
delete a topic (a channel keeps at least one topic). Members without management
permissions only see the group overview in group settings.

### Permissions

Group permissions:

`view_channel`, `send_messages`, `send_media`, `create_topics`,
`manage_topics`, `manage_messages`, `manage_channels`, `manage_members`,
`manage_roles`, `manage_group`.

The first six can be overridden per channel. Overrides apply to a role and then
to a specific user; a deny always wins. The owner bypasses all checks.

## Data model

SQLite tables created by `index.js`:

- `users`
  - `id`, `username` (case-insensitive unique), `number` (unique)
  - `password_salt`, `password_hash` (scrypt of the client authentication hash)
  - `public_key`, `encrypted_private_key`, `key_salt`
  - `avatar`, `banner`, `bio`, `pronouns`, `status`, `links`
  - `created_at`
- `sessions`
  - `token_hash`, `user_id`, `created_at`, `expires_at`
- `messages`
  - `id`, `sender_id`, `recipient_id`
  - recipient copy: `ephemeral_public_key`, `iv`, `ciphertext`
  - sender copy: `sender_ephemeral_public_key`, `sender_iv`, `sender_ciphertext`
  - `created_at`, `read_at`
- `call_history`
  - `id`, `call_id` (unique), `caller_id`, `callee_id`, `status`
  - `started_at`, `answered_at`, `ended_at`, `duration_seconds`
- `chat_groups`
  - `id`, `name`, `description`, `avatar`, `owner_id`, `created_at`
  - `visibility` (`private` or `public`), `invite_code`, `topic_style`
    (`chips` or `list`)
- `group_roles`
  - `id`, `group_id`, `name`, `color`, `permissions` (JSON), `is_default`
- `group_members`
  - `group_id`, `user_id`, `role_id`, `joined_at`
- `group_channels`
  - `id`, `group_id`, `name`, `description`, `kind`, `position`
- `channel_permissions`
  - `channel_id`, `role_id`, `user_id`, `allow` (JSON), `deny` (JSON)
- `group_topics`
  - `id`, `group_id`, `channel_id`, `name`, `emoji`, `closed`, `created_by`,
    `created_at`
- `group_messages`
  - `id`, `group_id`, `channel_id`, `topic_id`, `sender_id`, `kind`, `iv`,
    `ciphertext`, `created_at`
- `group_message_keys`
  - `message_id`, `user_id`, `ephemeral_public_key`, `iv`, `ciphertext`
- `group_reads`
  - `user_id`, `group_id`, `channel_id`, `topic_id`, `last_read_message_id`,
    `updated_at`

Profile images are stored as compressed JPEG data URLs. The client resizes the
avatar to at most 400x400 and the banner to at most 1280x480 before upload.

## REST API

All routes except registration and login require:

```http
Authorization: Bearer <session-token>
```

| Method | Route                        | Purpose                                  |
| ------ | ---------------------------- | ---------------------------------------- |
| POST   | `/api/register`              | Create an account and session            |
| POST   | `/api/login`                 | Authenticate and fetch encrypted key     |
| POST   | `/api/logout`                | Delete the current session               |
| GET    | `/api/me`                    | Current user profile                     |
| PUT    | `/api/me`                    | Update profile fields                    |
| GET    | `/api/users?q=`              | Search users by username or number       |
| GET    | `/api/users/:identifier`     | Public profile by username or number     |
| GET    | `/api/conversations`         | Chat list with last message and unread   |
| GET    | `/api/messages/:identifier`  | Conversation messages and call history, optional `after` |
| POST   | `/api/messages`              | Store an already encrypted message       |
| GET    | `/api/blocks`                | Users blocked by the current user        |
| POST   | `/api/users/:identifier/block` | Block a user and end active calls      |
| DELETE | `/api/users/:identifier/block` | Unblock a user                         |
| GET    | `/api/invites/:code`         | Public info for a public group invite    |
| POST   | `/api/invites/:code/join`    | Join a public group by invite code       |
| GET    | `/invite/:code`              | Standalone invite page                   |
| POST   | `/api/groups`                | Create a group                           |
| GET    | `/api/groups`                | Groups for the current user              |
| GET    | `/api/groups/:id`            | Group details, members, roles, channels  |
| PUT    | `/api/groups/:id`            | Update group name, description, avatar, visibility, invite code, topic style |
| DELETE | `/api/groups/:id`            | Delete a group (owner only)              |
| POST   | `/api/groups/:id/members`    | Add a member by username or number       |
| PUT    | `/api/groups/:id/members/:userId` | Change a member role                |
| DELETE | `/api/groups/:id/members/:userId` | Remove a member                     |
| POST   | `/api/groups/:id/leave`      | Leave a group                            |
| POST   | `/api/groups/:id/roles`      | Create a role                            |
| PUT    | `/api/groups/:id/roles/:roleId` | Update a role                         |
| DELETE | `/api/groups/:id/roles/:roleId` | Delete a role                         |
| POST   | `/api/groups/:id/channels`   | Create a channel                         |
| PUT    | `/api/groups/:id/channels/:channelId` | Update a channel                |
| DELETE | `/api/groups/:id/channels/:channelId` | Delete a channel                |
| PUT    | `/api/groups/:id/channels/:channelId/permissions` | Replace channel overrides |
| POST   | `/api/groups/:id/channels/:channelId/topics` | Create a topic            |
| PUT    | `/api/groups/:id/topics/:topicId` | Rename or close a topic             |
| DELETE | `/api/groups/:id/topics/:topicId` | Delete a topic                      |
| GET    | `/api/groups/:id/channels/:channelId/topics/:topicId/messages` | Topic messages |
| POST   | `/api/groups/:id/channels/:channelId/topics/:topicId/messages` | Send a message |

Direct messages are marked as read when a conversation is fetched. Group topics
are marked as read when their messages are fetched. The direct message response
also includes a `calls` array with the latest ended calls between the two users.

## WebSocket

Connect with the session token:

```text
ws://127.0.0.1:3000/ws?token=<session-token>
```

Server events:

```json
{ "type": "ready" }
{ "type": "message", "messageId": 42, "from": { "username": "alice" }, "createdAt": "..." }
{ "type": "read", "by": { "username": "bob" } }
{ "type": "group-message", "groupId": 7, "messageId": 99, "from": { "username": "alice" }, "createdAt": "..." }
{ "type": "group-added", "groupId": 7 }
{ "type": "group-removed", "groupId": 7 }
{ "type": "block-update", "blocked": true, "by": { "id": 3, "username": "alice" } }
{ "type": "call-offer", "callId": "...", "from": { "username": "alice" }, "sdp": "..." }
{ "type": "call-answer", "callId": "...", "sdp": "..." }
{ "type": "call-ice", "callId": "...", "candidate": { "candidate": "..." } }
{ "type": "call-renegotiate", "callId": "...", "sdp": "..." }
{ "type": "call-end", "callId": "..." }
{ "type": "call-unavailable", "callId": "...", "reason": "..." }
```

The client reconnects automatically with exponential backoff. HTTP polling is
kept as a fallback.

Incoming messages trigger an in-app toast and a short two-tone notification
sound created with the Web Audio API. The speaker button in the sidebar mutes or
enables the sound; the preference is stored in `localStorage`. Repeated sounds
are throttled, and active oscillators are stopped and disconnected after each
tone so bursts of messages cannot overlap or leave a stuck sound playing.

Browsers require a user interaction before audio can play. The audio context is
unlocked by the first click or keypress after the page loads, and the speaker
button can be used to unlock it and play a test sound.

## Security notes and limitations

- The server never receives passwords or plaintext message contents.
- Public keys are served by the server. A malicious server could substitute a
  public key and attempt a man-in-the-middle attack. A production system should
  add key fingerprints and out-of-band verification.
- The server can see metadata: usernames, user numbers, participants, group
  membership, channels, topics, message timestamps, and read times. Attachment
  names and types are inside the encrypted payload; the server only sees the
  ciphertext size.
- Group keys are wrapped for the members that exist when a message is sent.
  Removing a member stops future messages from being readable by them, but does
  not revoke keys they already received. There is no key rotation or forward
  secrecy beyond the per-message content key.
- Public invite links are bearer tokens: anyone with the link can join the group
  while it is public. There is no invite expiration, approval flow, or rate
  limiting on the join endpoint.
- For convenience, the unlocked private key JWK and session token are kept in
  `sessionStorage` for the lifetime of the browser tab. This allows reloads
  without re-entering the password. A production build should keep the private
  key in memory only, or store it as a non-extractable `CryptoKey` in IndexedDB,
  and require an unlock after reload.
- There is no password recovery. Losing the password means losing access to the
  encrypted private key and message history.
- Login attempts are limited to 10 failures per IP and username in a 10-minute
  window. There is no global rate limiting or abuse protection.
- The default bind address is `127.0.0.1`. For network access, use HTTPS and a
  reverse proxy; Web Crypto requires a secure context.
- There is no message deletion, account deletion, or group key rotation.
- Calls require microphone permission and, for screen sharing, display-capture
  permission. A TURN server is required when both peers are behind restrictive
  NATs; the default configuration only includes public STUN servers.
- Call signaling is in-memory. Restarting the server ends active calls. Call
  history itself is persisted in SQLite.
- Attachments are stored inside encrypted message rows, so large files increase
  SQLite and memory usage. The 2 MB client limit keeps this manageable for a
  demo. A production system should use encrypted object storage.
- Profile images are stored in SQLite as data URLs, which is convenient for a
  demo but not ideal for large files.

## Resetting the database

Stop the server, then delete the SQLite files:

```powershell
Remove-Item data\talkie.db, data\talkie.db-wal, data\talkie.db-shm -ErrorAction SilentlyContinue
```

Start the server again. A new empty database is created automatically.

## Manual test checklist

1. Create two accounts in two browser tabs or profiles.
2. Note the generated numbers shown after registration.
3. Search for the second user by username and by number.
4. Send a message and confirm it appears for both users.
5. Confirm the notification sound and toast on the receiving side.
6. Open the profile and update photo, banner, bio, pronouns, status, and links.
7. Confirm the banner picker opens when the banner is clicked.
8. Confirm read receipts change to double checks.
9. Send an image, a file, and a recorded voice message in a direct chat.
10. Create a group, add a second account, and send messages in `#general`.
11. Create a topic and confirm messages stay separated by topic.
12. Create an announcement channel and confirm a regular member cannot post.
13. Create a role with view-only permissions and confirm sending is blocked.
14. Open channel permissions, deny `view_channel` for one user, and confirm the
    channel disappears for that user.
15. Confirm group messages decrypt for members and that a non-member cannot
    fetch the group.
16. Create a public group with a custom code, open `/invite/<code>` in another
    browser profile, and join from the invite page.
17. Switch the group to private and confirm the invite link stops working.
18. As an admin, open `Manage` topics, add an emoji, rename, close, and delete a
    topic.
19. Switch the group topic display between chips and list and confirm both
    layouts work.
20. As a regular member, open group settings and confirm only Overview is
    visible, then use `Leave group`.
21. Open a direct chat and start a call. Accept it in the other tab and confirm
    audio works both ways.
22. Mute the microphone and confirm the other side stops hearing you; mute the
    call audio and confirm the remote voice is silenced locally.
23. Start screen sharing, change FPS and resolution while sharing, and confirm
    the remote video updates. Open and close fullscreen.
24. Adjust call volume, mute and unmute the speaker, and confirm the remote audio
    level follows the slider.
25. Stop sharing and confirm the remote video disappears.
26. End the call from either side and confirm both overlays close.
27. Block the other user, confirm the call button disappears and the composer is
    disabled, then unblock and confirm both work again.
28. Try sending a message and starting a call from the blocked side and confirm
    both are rejected.
29. Send a voice message and confirm the custom player, play/pause, seek, time,
    and incoming/outgoing colors work in both chats.
30. End a call and confirm the call history entry appears in both chats and
    remains after reloading the page.
31. Receive several messages quickly and confirm the notification sound is
    throttled and never keeps playing or spams indefinitely.
