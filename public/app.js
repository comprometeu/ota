"use strict";

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
const SESSION_KEY = "talkie.session.v1";
const PENDING_INVITE_KEY = "talkie.pendingInvite";
const AUTH_ITERATIONS = 210000;
const KEY_ITERATIONS = 260000;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const NOTIFICATION_COOLDOWN_MS = 1200;
const CALL_ICE_SERVERS = [
  {
    urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
  }
];

const CHANNEL_PERMISSIONS = [
  "view_channel",
  "send_messages",
  "send_media",
  "create_topics",
  "manage_topics",
  "manage_messages"
];

const PERMISSION_LABELS = {
  view_channel: "View channels",
  send_messages: "Send messages",
  send_media: "Send media",
  create_topics: "Create topics",
  manage_topics: "Manage topics",
  manage_messages: "Manage messages",
  manage_channels: "Manage channels",
  manage_members: "Manage members",
  manage_roles: "Manage roles",
  manage_group: "Manage group"
};

const state = {
  token: null,
  me: null,
  privateKey: null,
  privateKeyJwk: null,
  chats: [],
  groups: [],
  blockedUsers: new Set(),
  blockStatus: { blockedByMe: false, blockedMe: false },
  activeView: "direct",
  activeUsername: null,
  activeUser: null,
  activeGroupId: null,
  activeGroup: null,
  activeChannelId: null,
  activeTopicId: null,
  messages: [],
  calls: [],
  lastMessageId: 0,
  plaintextCache: new Map(),
  groupPlaintextCache: new Map(),
  attachmentUrls: new Map(),
  authMode: "login",
  authBusy: false,
  loadingChats: false,
  loadingMessages: false,
  pollChats: null,
  pollMessages: null,
  profileAvatar: "",
  profileBanner: "",
  groupAvatar: "",
  userModal: null,
  directoryOpen: false,
  forceScroll: false,
  sessionLost: false,
  socket: null,
  socketReconnectTimer: null,
  socketReconnectDelay: 1000,
  pendingMessageReload: false,
  pendingMessageReloadInitial: false,
  notifiedMessages: new Set(),
  audioContext: null,
  audioUnlocked: false,
  notificationNodes: new Set(),
  lastNotificationAt: 0,
  soundEnabled: true,
  pendingAttachment: null,
  replyTo: null,
  mediaRecorder: null,
  recordingStream: null,
  recordingChunks: [],
  recordingTimer: null,
  recordingStartedAt: 0,
  discardRecording: false,
  groupModalTab: "overview",
  permissionsChannelId: null,
  call: null
};

function toB64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(text) {
  const base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(value) {
  return parseDate(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatChatTime(value) {
  const date = parseDate(value);
  const today = new Date();
  if (sameDay(date, today)) return formatTime(value);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit"
  });
}

function dayKey(value) {
  const date = parseDate(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value) {
  const date = parseDate(value);
  const today = new Date();
  if (sameDay(date, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function initials(username) {
  const parts = String(username || "?")
    .split(/[-_.\s]+/)
    .filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

function colorFor(username) {
  let hash = 0;
  for (const char of String(username || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 60% 32%))`;
}

function setAvatar(element, user) {
  if (!element) return;
  element.replaceChildren();
  element.classList.add("avatar");
  if (user && user.avatar) {
    const img = document.createElement("img");
    img.src = user.avatar;
    img.alt = "";
    element.appendChild(img);
    element.style.background = "";
  } else {
    element.textContent = initials(user ? user.username : "?");
    element.style.background = colorFor(user ? user.username : "");
  }
}

function setBanner(element, dataUrl) {
  if (!element) return;
  if (dataUrl) {
    element.style.backgroundImage = `url("${dataUrl}")`;
    element.classList.add("has-image");
  } else {
    element.style.backgroundImage = "";
    element.classList.remove("has-image");
  }
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function payloadPreview(payload, senderName) {
  const value = payload || {};
  let preview = typeof value.text === "string" ? value.text.trim() : "";
  if (!preview && value.attachment) {
    const type = String(value.attachment.type || "");
    if (type.startsWith("image/")) preview = "Photo";
    else if (type.startsWith("audio/")) preview = "Voice message";
    else preview = value.attachment.name || "File";
  }
  if (!preview) preview = "Message";
  return senderName ? `${senderName}: ${preview}` : preview;
}

function replyPreviewText(payload) {
  const preview = payloadPreview(payload);
  return preview.length > 140 ? `${preview.slice(0, 137)}...` : preview;
}

function messageAuthorName(message) {
  if (!message) return "Message";
  if (message.fromMe) return "You";
  if (state.activeView === "group") {
    return (message.sender && message.sender.username) || "Member";
  }
  return (state.activeUser && state.activeUser.username) || "User";
}

function messageAuthorUsername(message) {
  if (!message) return "";
  if (message.fromMe) return (state.me && state.me.username) || "";
  if (state.activeView === "group") {
    return (message.sender && message.sender.username) || "";
  }
  return (state.activeUser && state.activeUser.username) || "";
}

function renderReplyPreview() {
  const preview = $("reply-preview");
  if (!preview) return;
  if (!state.replyTo) {
    preview.classList.add("hidden");
    $("reply-preview-name").textContent = "";
    $("reply-preview-text").textContent = "";
    return;
  }
  preview.classList.remove("hidden");
  $("reply-preview-name").textContent = messageAuthorName(state.replyTo);
  $("reply-preview-text").textContent = replyPreviewText(
    state.replyTo.payload || {}
  );
}

function setReplyTo(message) {
  if (!message || !message.payload) return;
  state.replyTo = message;
  renderReplyPreview();
  $("message-input").focus();
}

function clearReply() {
  state.replyTo = null;
  renderReplyPreview();
}

function scrollToMessage(id) {
  const target = document.querySelector(
    `.msg-row[data-message-id="${Number(id)}"]`
  );
  if (!target) {
    toast("The original message is not loaded.", true);
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("highlight");
  void target.offsetWidth;
  target.classList.add("highlight");
  setTimeout(() => target.classList.remove("highlight"), 1300);
}

function recomputeLastMessageId() {
  state.lastMessageId = state.messages.reduce(
    (max, message) => Math.max(max, Number(message.id) || 0),
    0
  );
}

function removeMessageLocally(id) {
  const before = state.messages.length;
  state.messages = state.messages.filter((message) => message.id !== id);
  if (state.replyTo && state.replyTo.id === id) clearReply();
  if (state.messages.length === before) return false;
  recomputeLastMessageId();
  renderMessages();
  return true;
}

function canDeleteMessage(message) {
  if (!message || !message.id) return false;
  if (state.activeView === "group") {
    return Boolean(message.fromMe || groupCan("manage_messages"));
  }
  return Boolean(message.fromMe);
}

function activeGroupChannel() {
  if (!state.activeGroup) return null;
  return (
    state.activeGroup.channels.find(
      (channel) => channel.id === state.activeChannelId
    ) || null
  );
}

function activeGroupTopic() {
  const channel = activeGroupChannel();
  if (!channel) return null;
  return channel.topics.find((topic) => topic.id === state.activeTopicId) || null;
}

function groupCan(permission) {
  const channel = activeGroupChannel();
  return Boolean(channel && channel.permissions.includes(permission));
}

function setGroupAvatar(element, group) {
  setAvatar(element, { username: group.name, avatar: group.avatar });
}

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3500);
}

function ensureAudio() {
  try {
    if (!state.audioContext || state.audioContext.state === "closed") {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      state.notificationNodes.clear();
      state.audioContext = new AudioCtor();
      state.audioUnlocked = false;
    }
    return state.audioContext;
  } catch {
    return null;
  }
}

function unlockAudio() {
  const context = ensureAudio();
  if (!context) return;

  const ready =
    context.state === "running"
      ? Promise.resolve()
      : context.resume().catch(() => {});

  ready.then(() => {
    if (state.audioUnlocked || context.state !== "running") return;
    state.audioUnlocked = true;
    try {
      const buffer = context.createBuffer(1, 1, 22050);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
    } catch {
      // Ignore audio failures.
    }
  });
}

function stopNotificationSound() {
  for (const oscillator of state.notificationNodes) {
    try {
      oscillator.stop();
    } catch {
      // Already stopped.
    }
    try {
      oscillator.disconnect();
    } catch {
      // Already disconnected.
    }
  }
  state.notificationNodes.clear();
}

function playNotificationSound(force = false) {
  if (!force && !state.soundEnabled) return;
  const nowMs = Date.now();
  if (!force && nowMs - state.lastNotificationAt < NOTIFICATION_COOLDOWN_MS) {
    return;
  }
  state.lastNotificationAt = nowMs;
  const context = ensureAudio();
  if (!context) return;

  const start = () => {
    try {
      stopNotificationSound();
      const now = context.currentTime;
      const notes = [
        { frequency: 987.77, at: 0, length: 0.14 },
        { frequency: 1318.51, at: 0.11, length: 0.18 }
      ];

      for (const note of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const begin = now + note.at;
        const end = begin + note.length + 0.02;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency, begin);
        gain.gain.setValueAtTime(0.0001, begin);
        gain.gain.exponentialRampToValueAtTime(0.22, begin + 0.015);
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          begin + note.length
        );

        oscillator.connect(gain);
        gain.connect(context.destination);
        state.notificationNodes.add(oscillator);
        oscillator.onended = () => {
          state.notificationNodes.delete(oscillator);
          try {
            oscillator.disconnect();
          } catch {
            // Ignore.
          }
          try {
            gain.disconnect();
          } catch {
            // Ignore.
          }
        };
        oscillator.start(begin);
        oscillator.stop(end);
        setTimeout(() => {
          if (!state.notificationNodes.has(oscillator)) return;
          try {
            oscillator.stop();
          } catch {
            // Already stopped.
          }
          try {
            oscillator.disconnect();
          } catch {
            // Ignore.
          }
          try {
            gain.disconnect();
          } catch {
            // Ignore.
          }
          state.notificationNodes.delete(oscillator);
        }, Math.max(0, (note.at + note.length) * 1000) + 1000);
      }
      state.audioUnlocked = true;
    } catch {
      // Ignore audio failures.
    }
  };

  if (context.state === "running") {
    start();
    return;
  }

  context
    .resume()
    .then(() => {
      if (context.state === "running") start();
    })
    .catch(() => {});
}

function updateSoundButton() {
  const button = $("sound-btn");
  if (!button) return;

  const onIcon = $("sound-icon-on");
  const offIcon = $("sound-icon-off");
  if (onIcon) onIcon.classList.toggle("hidden", !state.soundEnabled);
  if (offIcon) offIcon.classList.toggle("hidden", state.soundEnabled);

  const label = state.soundEnabled
    ? "Mute notification sound"
    : "Enable notification sound";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(!state.soundEnabled));
}

function initSound() {
  try {
    state.soundEnabled = localStorage.getItem("talkie.sound") !== "off";
  } catch {
    state.soundEnabled = true;
  }
  updateSoundButton();

  const button = $("sound-btn");
  if (button) {
    button.addEventListener("click", () => {
      state.soundEnabled = !state.soundEnabled;
      try {
        localStorage.setItem("talkie.sound", state.soundEnabled ? "on" : "off");
      } catch {
        // Ignore storage failures.
      }
      updateSoundButton();
      unlockAudio();

      if (state.soundEnabled) {
        playNotificationSound(true);
        toast("Notification sound enabled.");
      } else {
        stopNotificationSound();
        toast("Notification sound muted.");
      }
    });
  }

  document.addEventListener("pointerdown", unlockAudio, { passive: true });
  document.addEventListener("keydown", unlockAudio);
}

function rememberNotification(id) {
  if (!id) return true;
  if (state.notifiedMessages.has(id)) return false;
  state.notifiedMessages.add(id);
  if (state.notifiedMessages.size > 200) {
    const oldest = state.notifiedMessages.values().next().value;
    state.notifiedMessages.delete(oldest);
  }
  return true;
}

function closeSocket() {
  if (state.socketReconnectTimer) {
    clearTimeout(state.socketReconnectTimer);
    state.socketReconnectTimer = null;
  }
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    try {
      socket.close();
    } catch {
      // Ignore.
    }
  }
}

function scheduleSocketReconnect() {
  if (!state.token || state.socketReconnectTimer) return;
  const delay = state.socketReconnectDelay;
  state.socketReconnectDelay = Math.min(
    Math.round(state.socketReconnectDelay * 1.7),
    15000
  );
  state.socketReconnectTimer = setTimeout(() => {
    state.socketReconnectTimer = null;
    connectSocket();
  }, delay);
}

function connectSocket() {
  if (!state.token) return;
  if (
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(
    state.token
  )}`;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleSocketReconnect();
    return;
  }

  state.socket = socket;

  socket.addEventListener("open", () => {
    state.socketReconnectDelay = 1000;
    loadChats().catch(() => {});
    if (state.activeUsername) loadMessages(false).catch(() => {});
  });

  socket.addEventListener("message", (event) => {
    handleSocketEvent(event).catch(() => {});
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (!state.token) return;
    if (event.code === 4001) {
      handleSessionLost();
      return;
    }
    scheduleSocketReconnect();
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
  });
}

async function handleSocketEvent(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  if (!data || typeof data.type !== "string") return;

  if (data.type.startsWith("call-")) {
    handleCallSocketEvent(data);
    return;
  }

  if (data.type === "block-update") {
    handleBlockUpdate(data).catch(() => {});
    return;
  }

  if (data.type === "message") {
    const from = data.from;
    if (!from || !from.username) return;
    if (state.blockedUsers.has(from.id)) return;

    if (rememberNotification(`direct:${data.messageId}`)) {
      playNotificationSound();
    }

    const isActive =
      state.activeView === "direct" &&
      state.activeUsername &&
      state.activeUsername.toLowerCase() === from.username.toLowerCase();

    if (isActive) {
      loadMessages(false).catch(() => {});
    }

    loadChats().catch(() => {});

    if (!isActive || document.hidden) {
      toast(`New message from ${from.username}`);
    }
    return;
  }

  if (data.type === "group-message") {
    const from = data.from;
    if (!from || !from.username) return;
    if (state.me && from.username === state.me.username) return;

    if (rememberNotification(`group:${data.messageId}`)) {
      playNotificationSound();
    }

    const isActive =
      state.activeView === "group" &&
      state.activeGroupId === data.groupId &&
      state.activeChannelId === data.channelId &&
      state.activeTopicId === data.topicId;

    if (isActive) {
      loadGroupMessages(false).catch(() => {});
    }

    loadChats().catch(() => {});

    if (!isActive || document.hidden) {
      toast(`New message from ${from.username}`);
    }
    return;
  }

  if (data.type === "message-deleted") {
    const messageId = Number(data.messageId);
    if (data.scope === "group") {
      if (
        state.activeView === "group" &&
        state.activeGroupId === data.groupId &&
        state.activeChannelId === data.channelId &&
        state.activeTopicId === data.topicId
      ) {
        removeMessageLocally(messageId);
      }
    } else if (
      state.activeView === "direct" &&
      state.activeUser &&
      (state.activeUser.id === data.senderId ||
        state.activeUser.id === data.recipientId)
    ) {
      removeMessageLocally(messageId);
    }
    loadChats().catch(() => {});
    return;
  }

  if (data.type === "group-added") {
    loadChats().catch(() => {});
    toast("You were added to a group.");
    return;
  }

  if (data.type === "group-removed") {
    if (state.activeGroupId === data.groupId) {
      state.activeView = "direct";
      state.activeGroupId = null;
      state.activeGroup = null;
      state.activeChannelId = null;
      state.activeTopicId = null;
      state.messages = [];
      state.lastMessageId = 0;
      $("chat-view").classList.add("hidden");
      $("empty-state").classList.remove("hidden");
      $("group-bars").classList.add("hidden");
    }
    loadChats().catch(() => {});
    toast("You are no longer a member of that group.");
    return;
  }

  if (data.type === "read") {
    const by = data.by;
    if (!by || !by.username) return;
    const isActive =
      state.activeUsername &&
      state.activeUsername.toLowerCase() === by.username.toLowerCase();
    if (isActive) {
      let changed = false;
      for (const message of state.messages) {
        if (message.fromMe && !message.read) {
          message.read = true;
          changed = true;
        }
      }
      if (changed) renderMessages();
    }
    loadChats().catch(() => {});
  }
}

function makeCallId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sendCallSignal(type, payload, quiet = false) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    if (!quiet) toast("Call signaling is not connected.", true);
    return false;
  }
  try {
    state.socket.send(JSON.stringify({ type, ...payload }));
    return true;
  } catch {
    if (!quiet) toast("Could not send call signaling.", true);
    return false;
  }
}

function formatCallDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setCallStatus(text) {
  const element = $("call-status");
  if (element) element.textContent = text;
}

function setCallPeer(user) {
  if (!user) return;
  setAvatar($("call-avatar"), user);
  $("call-title").textContent = `Call with ${user.username}`;
  $("call-peer-name").textContent = user.username;
  $("call-peer-status").textContent =
    user.status || user.pronouns || user.number || "Private call";
}

function updateCallVideoUI() {
  const call = state.call;
  if (!call) return;
  const remoteVideo = $("call-remote-video");
  const hasRemoteVideo = Boolean(
    call.remoteStream &&
      call.remoteStream
        .getVideoTracks()
        .some((track) => track.readyState === "live" && !track.muted)
  );
  remoteVideo.classList.toggle("hidden", !hasRemoteVideo);
  $("call-placeholder").classList.toggle("hidden", hasRemoteVideo);
  $("call-local-video").classList.toggle("hidden", !call.screenStream);
  $("call-screen-badge").classList.toggle("hidden", !call.screenStream);
}

function updateCallControls() {
  const call = state.call;
  const incoming = Boolean(
    call && call.role === "callee" && call.status === "incoming"
  );
  $("call-incoming-actions").classList.toggle("hidden", !incoming);
  $("call-controls").classList.toggle("hidden", incoming || !call);

  const mic = $("call-mic");
  const speaker = $("call-speaker");
  const screen = $("call-screen");
  const settings = $("call-settings-btn");
  const fullscreen = $("call-fullscreen");
  if (!call) {
    mic.disabled = true;
    speaker.disabled = true;
    screen.disabled = true;
    settings.disabled = true;
    fullscreen.disabled = true;
    return;
  }

  mic.disabled = !call.localStream;
  speaker.disabled = !(
    call.remoteStream && call.remoteStream.getAudioTracks().length
  );
  screen.disabled = !call.connected;
  settings.disabled = !call.connected;
  fullscreen.disabled = !call.connected;
  mic.classList.toggle("off", Boolean(call.micMuted));
  speaker.classList.toggle("off", Boolean(call.speakerMuted));
  screen.classList.toggle("active", Boolean(call.screenStream));
  settings.classList.toggle(
    "active",
    !$("call-settings").classList.contains("hidden")
  );
  mic.title = call.micMuted ? "Unmute microphone" : "Mute microphone";
  mic.setAttribute(
    "aria-label",
    call.micMuted ? "Unmute microphone" : "Mute microphone"
  );
  speaker.title = call.speakerMuted ? "Unmute call audio" : "Mute call audio";
  speaker.setAttribute(
    "aria-label",
    call.speakerMuted ? "Unmute call audio" : "Mute call audio"
  );
  screen.title = call.screenStream ? "Stop sharing screen" : "Share screen";
  screen.setAttribute(
    "aria-label",
    call.screenStream ? "Stop sharing screen" : "Share screen"
  );
  updateCallVolumeUI();
}

function stopMediaStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore.
    }
  }
}

function startCallTimer(call) {
  if (!call.startedAt) call.startedAt = Date.now();
  if (!call.timerInterval) {
    call.timerInterval = setInterval(() => {
      if (state.call !== call) return;
      $("call-timer").textContent = formatCallDuration(
        Date.now() - call.startedAt
      );
    }, 500);
  }
  $("call-timer").textContent = formatCallDuration(Date.now() - call.startedAt);
}

function markCallConnected() {
  const call = state.call;
  if (!call) return;
  if (!call.connected) {
    call.connected = true;
    call.status = "connected";
    setCallStatus("Connected");
  }
  startCallTimer(call);
  updateCallControls();
}

function createCallPeer(call) {
  const pc = new RTCPeerConnection({
    iceServers: CALL_ICE_SERVERS,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 4
  });
  call.pc = pc;
  call.remoteStream = new MediaStream();
  call.pendingCandidates = call.pendingCandidates || [];
  call.makingOffer = false;
  call.renegotiationQueued = false;
  call.polite = call.role === "callee";

  pc.ontrack = (event) => {
    if (state.call !== call) return;
    if (!call.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      call.remoteStream.addTrack(event.track);
    }
    event.track.addEventListener("ended", () => {
      if (state.call !== call) return;
      try {
        call.remoteStream.removeTrack(event.track);
      } catch {
        // Ignore.
      }
      updateCallVideoUI();
      updateCallControls();
    });
    event.track.addEventListener("mute", () => {
      if (state.call === call) updateCallVideoUI();
    });
    event.track.addEventListener("unmute", () => {
      if (state.call === call) updateCallVideoUI();
    });
    const remoteVideo = $("call-remote-video");
    const remoteAudio = $("call-remote-audio");
    remoteVideo.srcObject = call.remoteStream;
    remoteAudio.srcObject = call.remoteStream;
    remoteAudio.volume = call.volume;
    remoteAudio.muted = Boolean(call.speakerMuted);
    remoteAudio.play().catch(() => {});
    remoteVideo.play().catch(() => {});
    updateCallVideoUI();
    updateCallControls();
  };

  pc.onicecandidate = (event) => {
    if (state.call !== call || !event.candidate) return;
    sendCallSignal(
      "call-ice",
      { callId: call.id, candidate: event.candidate.toJSON() },
      true
    );
  };

  pc.onconnectionstatechange = () => {
    if (state.call !== call) return;
    if (pc.connectionState === "connected") {
      markCallConnected();
    } else if (pc.connectionState === "disconnected") {
      setCallStatus("Reconnecting...");
    } else if (pc.connectionState === "failed") {
      finishCall({ reason: "Call connection failed.", error: true });
    }
  };

  pc.onnegotiationneeded = () => {
    if (state.call !== call || !call.answered) return;
    scheduleCallRenegotiation(call);
  };

  return pc;
}

async function getCallMicrophone() {
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    throw new Error("Microphone access is not supported in this browser.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      latency: { ideal: 0.01 }
    },
    video: false
  });
}

async function startCall() {
  if (state.call) {
    $("call-overlay").classList.remove("hidden");
    return;
  }
  if (state.activeView !== "direct" || !state.activeUser) {
    toast("Open a private chat first.", true);
    return;
  }
  if (state.activeUser.blockedByMe) {
    toast("Unblock this user before starting a call.", true);
    return;
  }
  if (state.activeUser.blockedMe) {
    toast("This user has blocked you.", true);
    return;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    toast("Call signaling is reconnecting. Try again.", true);
    return;
  }

  const peer = state.activeUser;
  const call = {
    id: makeCallId(),
    role: "caller",
    status: "calling",
    remoteUser: peer,
    localStream: null,
    screenStream: null,
    screenSourceStream: null,
    screenSenders: [],
    screenCanvas: null,
    screenContext: null,
    screenPreviewVideo: null,
    screenDrawTimer: null,
    screenFps: 0,
    screenWidth: 0,
    screenHeight: 0,
    remoteStream: null,
    pc: null,
    pendingCandidates: [],
    answered: false,
    connected: false,
    micMuted: false,
    speakerMuted: false,
    volume: 1,
    makingOffer: false,
    renegotiationQueued: false,
    renegotiateTimer: null,
    timerInterval: null,
    startedAt: 0
  };

  state.call = call;
  updateCallVolumeUI();
  $("call-overlay").classList.remove("hidden");
  $("call-settings").classList.add("hidden");
  $("call-timer").textContent = "00:00";
  $("call-remote-video").srcObject = null;
  $("call-remote-video").classList.add("hidden");
  $("call-remote-audio").srcObject = null;
  $("call-remote-audio").muted = false;
  $("call-local-video").srcObject = null;
  $("call-local-video").classList.add("hidden");
  setCallPeer(peer);
  setCallStatus("Requesting microphone...");
  updateCallVideoUI();
  updateCallControls();

  try {
    call.localStream = await getCallMicrophone();
    if (state.call !== call) {
      stopMediaStream(call.localStream);
      return;
    }
    call.pc = createCallPeer(call);
    for (const track of call.localStream.getAudioTracks()) {
      call.pc.addTrack(track, call.localStream);
    }
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    if (
      !sendCallSignal("call-offer", {
        callId: call.id,
        to: peer.username,
        sdp: call.pc.localDescription.sdp
      })
    ) {
      finishCall({ notify: false });
      return;
    }
    setCallStatus("Ringing...");
    updateCallControls();
  } catch (error) {
    if (state.call !== call) return;
    finishCall({
      notify: false,
      reason: error.message || "Could not start the call.",
      error: true
    });
  }
}

function handleIncomingCall(data) {
  if (!data || !data.from || !data.sdp || typeof data.callId !== "string") return;
  if (state.call) {
    sendCallSignal(
      "call-reject",
      { callId: data.callId, reason: "Busy" },
      true
    );
    return;
  }

  const call = {
    id: data.callId,
    role: "callee",
    status: "incoming",
    remoteUser: data.from,
    incomingSdp: data.sdp,
    localStream: null,
    screenStream: null,
    screenSourceStream: null,
    screenSenders: [],
    screenCanvas: null,
    screenContext: null,
    screenPreviewVideo: null,
    screenDrawTimer: null,
    screenFps: 0,
    screenWidth: 0,
    screenHeight: 0,
    remoteStream: null,
    pc: null,
    pendingCandidates: [],
    answered: false,
    connected: false,
    micMuted: false,
    speakerMuted: false,
    volume: 1,
    makingOffer: false,
    renegotiationQueued: false,
    renegotiateTimer: null,
    timerInterval: null,
    startedAt: 0
  };

  state.call = call;
  updateCallVolumeUI();
  $("call-overlay").classList.remove("hidden");
  $("call-settings").classList.add("hidden");
  $("call-timer").textContent = "00:00";
  $("call-remote-video").srcObject = null;
  $("call-remote-video").classList.add("hidden");
  $("call-remote-audio").srcObject = null;
  $("call-remote-audio").muted = false;
  $("call-local-video").srcObject = null;
  $("call-local-video").classList.add("hidden");
  setCallPeer(data.from);
  setCallStatus("Incoming call");
  updateCallVideoUI();
  updateCallControls();
  playNotificationSound();
  if (document.hidden) toast(`Incoming call from ${data.from.username}`);
}

async function acceptIncomingCall() {
  const call = state.call;
  if (!call || call.role !== "callee" || call.status !== "incoming") return;
  call.status = "connecting";
  setCallStatus("Connecting...");
  updateCallControls();

  try {
    call.localStream = await getCallMicrophone();
    if (state.call !== call) {
      stopMediaStream(call.localStream);
      return;
    }
    call.pc = createCallPeer(call);
    for (const track of call.localStream.getAudioTracks()) {
      call.pc.addTrack(track, call.localStream);
    }
    await call.pc.setRemoteDescription({ type: "offer", sdp: call.incomingSdp });
    await flushCallCandidates(call);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    if (
      !sendCallSignal("call-answer", {
        callId: call.id,
        sdp: call.pc.localDescription.sdp
      })
    ) {
      throw new Error("Call signaling failed.");
    }
    call.answered = true;
    call.incomingSdp = null;
    if (call.pc.connectionState === "connected") {
      markCallConnected();
    } else {
      setCallStatus("Connecting...");
      updateCallControls();
    }
  } catch (error) {
    if (state.call !== call) return;
    finishCall({
      reason: error.message || "Could not accept the call.",
      error: true
    });
  }
}

function declineIncomingCall() {
  const call = state.call;
  if (!call || call.role !== "callee") return;
  sendCallSignal("call-reject", { callId: call.id, reason: "Declined" }, true);
  finishCall({ notify: false, reason: "Call declined." });
}

async function handleCallAnswer(data) {
  const call = state.call;
  if (!call || call.id !== data.callId || call.role !== "caller" || !call.pc) {
    return;
  }
  try {
    await call.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    await flushCallCandidates(call);
    call.answered = true;
    if (call.pc.connectionState === "connected") {
      markCallConnected();
    } else {
      call.status = "connecting";
      setCallStatus("Connecting...");
      updateCallControls();
    }
  } catch {
    finishCall({ reason: "Could not connect the call.", error: true });
  }
}

async function flushCallCandidates(call) {
  if (!call.pc) return;
  const candidates = call.pendingCandidates || [];
  call.pendingCandidates = [];
  for (const candidate of candidates) {
    try {
      await call.pc.addIceCandidate(candidate);
    } catch {
      // A candidate from an older negotiation can safely be ignored.
    }
  }
}

async function handleCallIce(data) {
  const call = state.call;
  if (!call || call.id !== data.callId) return;
  if (!call.pc || !call.pc.remoteDescription) {
    call.pendingCandidates.push(data.candidate);
    return;
  }
  try {
    await call.pc.addIceCandidate(data.candidate);
  } catch {
    // Ignore candidates that no longer apply.
  }
}

function scheduleCallRenegotiation(call) {
  if (state.call !== call || !call.answered || !call.pc) return;
  if (call.renegotiateTimer) return;
  call.renegotiateTimer = setTimeout(() => {
    call.renegotiateTimer = null;
    sendCallRenegotiation(call);
  }, 120);
}

async function sendCallRenegotiation(call) {
  if (state.call !== call || !call.answered || !call.pc) return;
  if (call.makingOffer) {
    call.renegotiationQueued = true;
    return;
  }
  call.makingOffer = true;
  try {
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    sendCallSignal(
      "call-renegotiate",
      { callId: call.id, sdp: call.pc.localDescription.sdp },
      true
    );
  } catch {
    // Ignore a negotiation that raced with another offer.
  } finally {
    call.makingOffer = false;
    if (call.renegotiationQueued && state.call === call) {
      call.renegotiationQueued = false;
      scheduleCallRenegotiation(call);
    }
  }
}

async function handleCallRenegotiation(data) {
  const call = state.call;
  if (!call || call.id !== data.callId || !call.pc || !call.answered) return;
  const pc = call.pc;
  const collision = call.makingOffer || pc.signalingState !== "stable";
  if (collision) {
    if (!call.polite) return;
    try {
      await pc.setLocalDescription({ type: "rollback" });
    } catch {
      return;
    }
  }
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
    await flushCallCandidates(call);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendCallSignal(
      "call-renegotiate-answer",
      { callId: call.id, sdp: pc.localDescription.sdp },
      true
    );
  } catch {
    // Ignore a stale renegotiation.
  }
}

async function handleCallRenegotiationAnswer(data) {
  const call = state.call;
  if (!call || call.id !== data.callId || !call.pc) return;
  try {
    await call.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    await flushCallCandidates(call);
  } catch {
    // Ignore an answer for an offer that was rolled back.
  }
}

function toggleCallMic() {
  const call = state.call;
  if (!call || !call.localStream) return;
  call.micMuted = !call.micMuted;
  for (const track of call.localStream.getAudioTracks()) {
    track.enabled = !call.micMuted;
  }
  updateCallControls();
}

function updateCallVolumeUI() {
  const call = state.call;
  const slider = $("call-volume");
  const label = $("call-volume-value");
  const audio = $("call-remote-audio");
  if (!slider || !label) return;
  const volume = call ? call.volume : 1;
  const percent = Math.round(volume * 100);
  slider.value = String(percent);
  label.textContent = `${percent}%`;
  if (audio && call) {
    audio.volume = volume;
    audio.muted = Boolean(call.speakerMuted);
  }
}

function setCallVolume(value) {
  const call = state.call;
  if (!call) return;
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  call.volume = percent / 100;
  call.speakerMuted = percent === 0;
  const audio = $("call-remote-audio");
  audio.volume = call.volume;
  audio.muted = call.speakerMuted;
  if (!audio.muted) audio.play().catch(() => {});
  updateCallControls();
  updateCallVolumeUI();
}

function toggleCallSpeaker() {
  const call = state.call;
  if (!call || !call.remoteStream) return;
  call.speakerMuted = !call.speakerMuted;
  if (!call.speakerMuted && call.volume <= 0) call.volume = 0.5;
  const audio = $("call-remote-audio");
  audio.volume = call.volume;
  audio.muted = call.speakerMuted;
  if (!audio.muted) audio.play().catch(() => {});
  updateCallControls();
  updateCallVolumeUI();
}

function updateCallFullscreenButton() {
  const button = $("call-fullscreen");
  if (!button) return;
  const active = document.fullscreenElement === $("call-stage");
  button.classList.toggle("active", active);
  button.title = active ? "Exit fullscreen" : "Fullscreen";
  button.setAttribute(
    "aria-label",
    active ? "Exit fullscreen" : "Fullscreen"
  );
}

async function toggleCallFullscreen() {
  const stage = $("call-stage");
  if (!stage || !state.call) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (typeof stage.requestFullscreen === "function") {
      await stage.requestFullscreen();
    } else if (typeof stage.webkitRequestFullscreen === "function") {
      stage.webkitRequestFullscreen();
    } else {
      toast("Fullscreen is not supported in this browser.", true);
    }
  } catch {
    toast("Could not open fullscreen.", true);
  }
  updateCallFullscreenButton();
}

async function applyScreenConstraints(track, fps, width, height) {
  try {
    await track.applyConstraints({
      frameRate: { ideal: fps, max: fps },
      width: { ideal: width, max: width },
      height: { ideal: height, max: height }
    });
  } catch {
    // Some browsers do not allow changing a display track after capture.
  }
}

function drawCallScreenFrame(call) {
  if (!call.screenCanvas || !call.screenPreviewVideo) return;
  if (call.screenPreviewVideo.readyState < 2) return;
  if (!call.screenContext) {
    call.screenContext = call.screenCanvas.getContext("2d", { alpha: false });
  }
  if (!call.screenContext) return;
  try {
    call.screenContext.drawImage(
      call.screenPreviewVideo,
      0,
      0,
      call.screenCanvas.width,
      call.screenCanvas.height
    );
  } catch {
    // The source frame may not be ready yet.
  }
}

function startCallScreenDrawLoop(call, fps) {
  if (call.screenDrawTimer) clearInterval(call.screenDrawTimer);
  const interval = Math.max(1000 / Math.max(fps, 1), 10);
  call.screenDrawTimer = setInterval(() => {
    if (state.call !== call) return;
    drawCallScreenFrame(call);
  }, interval);
}

function createCallScreenOutput(call, fps) {
  const output = call.screenCanvas.captureStream(fps);
  const videoTrack = output.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = "detail";
  for (const track of call.screenSourceStream?.getAudioTracks() || []) {
    output.addTrack(track);
  }
  return output;
}

async function replaceCallScreenOutput(call, fps) {
  const oldStream = call.screenStream;
  const oldVideo = oldStream?.getVideoTracks()[0] || null;
  const output = createCallScreenOutput(call, fps);
  const newVideo = output.getVideoTracks()[0];
  const sender = (call.screenSenders || []).find(
    (item) => item.track === oldVideo
  );
  if (sender && newVideo) await sender.replaceTrack(newVideo);
  if (oldVideo) {
    try {
      oldVideo.stop();
    } catch {
      // Ignore.
    }
  }
  call.screenStream = output;
  const localVideo = $("call-local-video");
  localVideo.srcObject = output;
  localVideo.play().catch(() => {});
}

async function applyCallScreenSettings(notify = true) {
  const call = state.call;
  if (!call || !call.screenStream) return;
  const fps = Number($("call-fps").value) || 30;
  const [width, height] = ($("call-resolution").value || "1280x720")
    .split("x")
    .map(Number);
  const track = call.screenStream.getVideoTracks()[0];
  if (!track) return;
  track.contentHint = "detail";

  if (call.screenCanvas) {
    if (
      fps !== call.screenFps ||
      width !== call.screenWidth ||
      height !== call.screenHeight
    ) {
      call.screenFps = fps;
      call.screenWidth = width;
      call.screenHeight = height;
      call.screenCanvas.width = width;
      call.screenCanvas.height = height;
      drawCallScreenFrame(call);
      startCallScreenDrawLoop(call, fps);
      try {
        await replaceCallScreenOutput(call, fps);
      } catch {
        toast("Could not apply the screen resolution.", true);
        return;
      }
    }
  } else {
    await applyScreenConstraints(track, fps, width, height);
    const sender = (call.screenSenders || []).find(
      (item) => item.track === track
    );
    if (sender && typeof sender.getParameters === "function") {
      try {
        const parameters = sender.getParameters();
        if (parameters.encodings && parameters.encodings[0]) {
          const settings = track.getSettings();
          const sourceWidth = Number(settings.width) || width;
          const sourceHeight = Number(settings.height) || height;
          parameters.encodings[0].maxFramerate = fps;
          parameters.encodings[0].scaleResolutionDownBy = Math.max(
            sourceWidth / width,
            sourceHeight / height,
            1
          );
          await sender.setParameters(parameters);
        }
      } catch {
        // Bitrate controls are optional.
      }
    }
  }
  if (notify) toast("Screen settings applied.");
}

async function toggleCallScreen() {
  const call = state.call;
  if (!call || !call.connected || !call.pc) return;
  if (call.screenStream) {
    stopCallScreenShare(call);
    return;
  }
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getDisplayMedia !== "function"
  ) {
    toast("Screen sharing is not supported in this browser.", true);
    return;
  }

  const fps = Number($("call-fps").value) || 30;
  const [width, height] = ($("call-resolution").value || "1280x720")
    .split("x")
    .map(Number);

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { ideal: width, max: width },
        height: { ideal: height, max: height }
      },
      audio: true
    });
    if (state.call !== call) {
      stopMediaStream(stream);
      return;
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("No screen video track was provided.");
    videoTrack.contentHint = "detail";

    const preview = document.createElement("video");
    preview.muted = true;
    preview.playsInline = true;
    preview.srcObject = stream;
    await preview.play().catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    call.screenSourceStream = stream;
    call.screenPreviewVideo = preview;
    call.screenCanvas = canvas;
    call.screenContext = canvas.getContext("2d", { alpha: false });
    call.screenFps = fps;
    call.screenWidth = width;
    call.screenHeight = height;
    drawCallScreenFrame(call);

    const output = createCallScreenOutput(call, fps);
    call.screenStream = output;
    call.screenSenders = output
      .getTracks()
      .map((track) => call.pc.addTrack(track, output));
    startCallScreenDrawLoop(call, fps);
    videoTrack.addEventListener("ended", () => {
      if (state.call === call) stopCallScreenShare(call);
    });

    const localVideo = $("call-local-video");
    localVideo.srcObject = output;
    localVideo.classList.remove("hidden");
    localVideo.play().catch(() => {});
    updateCallVideoUI();
    updateCallControls();
    scheduleCallRenegotiation(call);
    toast("Screen sharing started.");
  } catch (error) {
    if (error && error.name === "NotAllowedError") return;
    toast(error.message || "Could not share the screen.", true);
  }
}

function stopCallScreenShare(call = state.call) {
  if (!call || !call.screenStream) return;
  if (call.screenDrawTimer) {
    clearInterval(call.screenDrawTimer);
    call.screenDrawTimer = null;
  }
  for (const sender of call.screenSenders || []) {
    try {
      call.pc.removeTrack(sender);
    } catch {
      // Ignore.
    }
  }
  call.screenSenders = [];
  stopMediaStream(call.screenStream);
  stopMediaStream(call.screenSourceStream);
  call.screenStream = null;
  call.screenSourceStream = null;
  if (call.screenPreviewVideo) call.screenPreviewVideo.srcObject = null;
  call.screenPreviewVideo = null;
  call.screenCanvas = null;
  call.screenContext = null;
  call.screenFps = 0;
  call.screenWidth = 0;
  call.screenHeight = 0;
  const localVideo = $("call-local-video");
  localVideo.srcObject = null;
  localVideo.classList.add("hidden");
  updateCallVideoUI();
  updateCallControls();
  scheduleCallRenegotiation(call);
}

function toggleCallSettings() {
  const call = state.call;
  if (!call || !call.connected) return;
  $("call-settings").classList.toggle("hidden");
  updateCallControls();
}

function cleanupCall(call) {
  if (!call) return;
  if (call.timerInterval) clearInterval(call.timerInterval);
  if (call.renegotiateTimer) clearTimeout(call.renegotiateTimer);
  if (call.screenDrawTimer) clearInterval(call.screenDrawTimer);
  stopMediaStream(call.localStream);
  stopMediaStream(call.screenStream);
  stopMediaStream(call.screenSourceStream);
  if (call.screenPreviewVideo) call.screenPreviewVideo.srcObject = null;
  if (call.pc) {
    call.pc.ontrack = null;
    call.pc.onicecandidate = null;
    call.pc.onconnectionstatechange = null;
    call.pc.onnegotiationneeded = null;
    try {
      call.pc.close();
    } catch {
      // Ignore.
    }
  }
  const remoteVideo = $("call-remote-video");
  const remoteAudio = $("call-remote-audio");
  const localVideo = $("call-local-video");
  remoteVideo.srcObject = null;
  remoteVideo.classList.add("hidden");
  remoteAudio.srcObject = null;
  remoteAudio.muted = false;
  remoteAudio.volume = 1;
  localVideo.srcObject = null;
  localVideo.classList.add("hidden");
  if (document.fullscreenElement === $("call-stage")) {
    document.exitFullscreen().catch(() => {});
  }
  $("call-volume").value = "100";
  $("call-volume-value").textContent = "100%";
  updateCallFullscreenButton();
  $("call-overlay").classList.add("hidden");
  $("call-settings").classList.add("hidden");
  $("call-incoming-actions").classList.add("hidden");
  $("call-controls").classList.add("hidden");
  $("call-screen-badge").classList.add("hidden");
  $("call-timer").textContent = "00:00";
  setCallStatus("");
}

function refreshDirectCallHistory() {
  if (state.activeView !== "direct" || !state.activeUsername) return;
  loadMessages(false).catch(() => {});
  setTimeout(() => {
    if (state.activeView === "direct" && state.activeUsername) {
      loadMessages(false).catch(() => {});
    }
  }, 700);
}

function finishCall({ reason = "", error = false, notify = true } = {}) {
  const call = state.call;
  if (!call) return;
  state.call = null;
  if (notify) sendCallSignal("call-end", { callId: call.id }, true);
  cleanupCall(call);
  refreshDirectCallHistory();
  if (reason) toast(reason, error);
}

function handleCallSocketEvent(data) {
  if (data.type === "call-offer") {
    handleIncomingCall(data);
    return;
  }
  if (data.type === "call-answer") {
    handleCallAnswer(data).catch(() => {});
    return;
  }
  if (data.type === "call-ice") {
    handleCallIce(data).catch(() => {});
    return;
  }
  if (data.type === "call-renegotiate") {
    handleCallRenegotiation(data).catch(() => {});
    return;
  }
  if (data.type === "call-renegotiate-answer") {
    handleCallRenegotiationAnswer(data).catch(() => {});
    return;
  }
  if (data.type === "call-end") {
    if (state.call && state.call.id === data.callId) {
      finishCall({ reason: "Call ended.", notify: false });
    }
    return;
  }
  if (data.type === "call-reject") {
    if (state.call && state.call.id === data.callId) {
      finishCall({
        reason: data.reason || "Call declined.",
        error: true,
        notify: false
      });
    }
    return;
  }
  if (data.type === "call-busy" || data.type === "call-unavailable") {
    const message = data.reason || "The call could not be completed.";
    if (state.call && state.call.id === data.callId) {
      finishCall({ reason: message, error: true, notify: false });
    } else {
      toast(message, true);
    }
  }
}


function showModal(id) {
  $(id).classList.remove("hidden");
}

function hideModal(id) {
  $(id).classList.add("hidden");
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const token = options.token || state.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers,
      cache: "no-store",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new Error("No connection to the server.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401 && !options.skipAuthHandler) {
      handleSessionLost();
    }
    throw new Error((data && data.error) || "Request failed.");
  }

  return data;
}

function saveSession() {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        token: state.token,
        me: state.me,
        privateKeyJwk: state.privateKeyJwk
      })
    );
  } catch {
    toast("Could not save the session in this browser.", true);
  }
}

function clearSession() {
  window.sessionStorage.removeItem(SESSION_KEY);
  if (state.call) finishCall({ notify: false });
  stopNotificationSound();
  stopPolling();
  closeSocket();
  state.socketReconnectDelay = 1000;
  state.pendingMessageReload = false;
  state.pendingMessageReloadInitial = false;
  state.notifiedMessages.clear();
  cancelRecording();
  state.token = null;
  state.me = null;
  state.privateKey = null;
  state.privateKeyJwk = null;
  state.chats = [];
  state.groups = [];
  state.blockedUsers.clear();
  state.blockStatus = { blockedByMe: false, blockedMe: false };
  state.activeView = "direct";
  state.activeUsername = null;
  state.activeUser = null;
  state.activeGroupId = null;
  state.activeGroup = null;
  state.activeChannelId = null;
  state.activeTopicId = null;
  state.messages = [];
  state.calls = [];
  state.lastMessageId = 0;
  state.plaintextCache.clear();
  state.groupPlaintextCache.clear();
  for (const url of state.attachmentUrls.values()) URL.revokeObjectURL(url);
  state.attachmentUrls.clear();
  state.pendingAttachment = null;
  state.replyTo = null;
  state.permissionsChannelId = null;
  closeImageLightbox();
  renderReplyPreview();
  $("app").classList.add("hidden");
  $("app").classList.remove("chat-open");
  $("auth-screen").classList.remove("hidden");
  $("auth-password").value = "";
  $("auth-error").textContent = "";
  $("chat-view").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  $("group-bars").classList.add("hidden");
  $("search-input").value = "";
  hideSearch();
}

function handleSessionLost() {
  if (state.sessionLost) return;
  state.sessionLost = true;
  clearSession();
  toast("Session expired. Log in again.", true);
  setTimeout(() => {
    state.sessionLost = false;
  }, 1500);
}

function deriveBits(password, salt, iterations) {
  return crypto.subtle
    .importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
    .then((key) =>
      crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" },
        key,
        256
      )
    )
    .then((bits) => new Uint8Array(bits));
}

async function authHashFor(username, password) {
  const bits = await deriveBits(
    password,
    `talkie:auth:v1:${username.toLowerCase()}`,
    AUTH_ITERATIONS
  );
  return toB64url(bits);
}

async function kekFor(password, keySalt) {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(`talkie:e2e:v1:${keySalt}`),
      iterations: KEY_ITERATIONS,
      hash: "SHA-256"
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function createIdentity(password) {
  const keySalt = toB64url(crypto.getRandomValues(new Uint8Array(16)));
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const publicKey = toB64url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  );
  const kek = await kekFor(password, keySalt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      kek,
      enc.encode(JSON.stringify(privateKeyJwk))
    )
  );
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);

  return {
    keySalt,
    publicKey,
    encryptedPrivateKey: toB64url(blob),
    privateKey: keys.privateKey,
    privateKeyJwk
  };
}

async function unlockIdentity(password, keySalt, encryptedPrivateKey) {
  const blob = fromB64url(encryptedPrivateKey);
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const kek = await kekFor(password, keySalt);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      kek,
      ciphertext
    );
  } catch {
    throw new Error("Could not unlock your private key.");
  }

  const privateKeyJwk = JSON.parse(dec.decode(plaintext));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );

  return { privateKey, privateKeyJwk };
}

async function encryptBytesFor(publicKeyB64, bytes) {
  const recipient = await crypto.subtle.importKey(
    "raw",
    fromB64url(publicKeyB64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      aesKey,
      bytes
    )
  );
  const ephemeralPublicKey = toB64url(
    new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  );

  return {
    ephemeralPublicKey,
    iv: toB64url(iv),
    ciphertext: toB64url(ciphertext)
  };
}

async function encryptFor(publicKeyB64, plaintext) {
  return encryptBytesFor(publicKeyB64, enc.encode(plaintext));
}

async function decryptBytesFrom(privateKey, payload) {
  const ephemeral = await crypto.subtle.importKey(
    "raw",
    fromB64url(payload.ephemeralPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeral },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromB64url(payload.iv),
        tagLength: 128
      },
      aesKey,
      fromB64url(payload.ciphertext)
    )
  );
}

function normalizeAttachment(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.data !== "string" || !value.data) return null;
  return {
    name:
      typeof value.name === "string" && value.name
        ? value.name.slice(0, 160)
        : "attachment",
    type:
      typeof value.type === "string" && value.type
        ? value.type.slice(0, 120)
        : "application/octet-stream",
    size: Number(value.size) || 0,
    data: value.data
  };
}

function normalizeReply(value) {
  if (!value || typeof value !== "object") return null;
  const id = Number(value.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username:
      typeof value.username === "string" ? value.username.slice(0, 24) : "",
    preview:
      typeof value.preview === "string"
        ? value.preview.slice(0, 140)
        : "Message"
  };
}

function parseMessagePayload(plaintext) {
  try {
    const value = JSON.parse(plaintext);
    if (
      value &&
      typeof value === "object" &&
      (typeof value.text === "string" || value.attachment)
    ) {
      return {
        text: typeof value.text === "string" ? value.text : "",
        attachment: normalizeAttachment(value.attachment),
        replyTo: normalizeReply(value.replyTo)
      };
    }
  } catch {
    // Older messages contain plain text only.
  }
  return { text: plaintext, attachment: null };
}

async function decryptPayload(message) {
  if (message.payload) return message.payload;
  if (typeof message.plaintext === "string") {
    return parseMessagePayload(message.plaintext);
  }
  const cacheKey = `${message.id}:${message.fromMe ? "out" : "in"}`;
  if (state.plaintextCache.has(cacheKey)) {
    return state.plaintextCache.get(cacheKey);
  }

  try {
    if (!state.privateKey) throw new Error("Key locked.");
    const bytes = await decryptBytesFrom(state.privateKey, message);
    const payload = parseMessagePayload(dec.decode(bytes));
    state.plaintextCache.set(cacheKey, payload);
    return payload;
  } catch {
    const fallback = { text: "Unreadable message", attachment: null };
    state.plaintextCache.set(cacheKey, fallback);
    return fallback;
  }
}

async function encryptGroupPayload(payload, members) {
  const contentKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      contentKey,
      enc.encode(JSON.stringify(payload))
    )
  );
  const rawKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", contentKey)
  );
  const keys = [];

  for (const member of members) {
    if (!member.publicKey) continue;
    const encrypted = await encryptBytesFor(member.publicKey, rawKey);
    keys.push({ userId: member.id, ...encrypted });
  }

  return {
    iv: toB64url(iv),
    ciphertext: toB64url(ciphertext),
    keys
  };
}

async function decryptGroupPayload(message) {
  const cacheKey = `group:${message.id}`;
  if (state.groupPlaintextCache.has(cacheKey)) {
    return state.groupPlaintextCache.get(cacheKey);
  }

  try {
    if (!state.privateKey || !message.key) throw new Error("Key locked.");
    const rawKey = await decryptBytesFrom(state.privateKey, message.key);
    const contentKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const plaintext = dec.decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromB64url(message.iv),
          tagLength: 128
        },
        contentKey,
        fromB64url(message.ciphertext)
      )
    );
    const payload = parseMessagePayload(plaintext);
    state.groupPlaintextCache.set(cacheKey, payload);
    return payload;
  } catch {
    const fallback = { text: "Unreadable message", attachment: null };
    state.groupPlaintextCache.set(cacheKey, fallback);
    return fallback;
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Sign up";
  $("auth-password").autocomplete =
    mode === "login" ? "current-password" : "new-password";
  $("auth-hint").textContent =
    mode === "login"
      ? "Your password unlocks your private key in this browser."
      : "At least 8 characters. Keep your password safe; there is no recovery.";
  $("auth-error").textContent = "";
}

async function submitAuth(event) {
  event.preventDefault();
  if (state.authBusy) return;

  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  const errorElement = $("auth-error");
  errorElement.textContent = "";

  if (!USERNAME_PATTERN.test(username)) {
    errorElement.textContent = "Use 3 to 24 letters, numbers, _ or -.";
    return;
  }

  if (password.length < 8) {
    errorElement.textContent = "Password must be at least 8 characters.";
    return;
  }

  unlockAudio();
  state.authBusy = true;
  const button = $("auth-submit");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent =
    state.authMode === "register" ? "Creating account..." : "Logging in...";

  try {
    const authHash = await authHashFor(username, password);

    if (state.authMode === "register") {
      const identity = await createIdentity(password);
      const data = await api("/api/register", {
        method: "POST",
        skipAuthHandler: true,
        body: {
          username,
          authHash,
          publicKey: identity.publicKey,
          encryptedPrivateKey: identity.encryptedPrivateKey,
          keySalt: identity.keySalt
        }
      });

      state.token = data.token;
      state.me = data.user;
      state.privateKey = identity.privateKey;
      state.privateKeyJwk = identity.privateKeyJwk;
      saveSession();
      $("auth-password").value = "";
      await enterApp();
      openProfileEditor();
      toast(`Account created! Your number is ${state.me.number}.`);
    } else {
      const data = await api("/api/login", {
        method: "POST",
        skipAuthHandler: true,
        body: { username, authHash }
      });
      const unlocked = await unlockIdentity(
        password,
        data.keySalt,
        data.encryptedPrivateKey
      );

      state.token = data.token;
      state.me = data.user;
      state.privateKey = unlocked.privateKey;
      state.privateKeyJwk = unlocked.privateKeyJwk;
      saveSession();
      $("auth-password").value = "";
      await enterApp();
    }
  } catch (error) {
    errorElement.textContent = error.message;
  } finally {
    state.authBusy = false;
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function restoreSession() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    saved = null;
  }

  if (
    !saved ||
    typeof saved.token !== "string" ||
    !saved.me ||
    !saved.privateKeyJwk
  ) {
    return false;
  }

  state.token = saved.token;

  try {
    const data = await api("/api/me", { skipAuthHandler: true });
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      saved.privateKeyJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveKey"]
    );
    state.me = data.user;
    state.privateKey = privateKey;
    state.privateKeyJwk = saved.privateKeyJwk;
    return true;
  } catch {
    clearSession();
    return false;
  }
}

async function enterApp() {
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  startPolling();
  connectSocket();
  try {
    await loadChats();
  } catch {
    toast("Could not load conversations.", true);
  }
  await consumeInviteTarget();
}

async function consumeInviteTarget() {
  const params = new URLSearchParams(location.search);
  const groupParam = params.get("group");
  const code =
    sessionStorage.getItem(PENDING_INVITE_KEY) || params.get("invite") || "";

  if (groupParam) {
    history.replaceState(null, "", location.pathname);
    const groupId = Number.parseInt(groupParam, 10);
    if (Number.isSafeInteger(groupId) && groupId > 0) {
      await openGroup(groupId);
    }
    return;
  }

  if (!code) return;
  sessionStorage.removeItem(PENDING_INVITE_KEY);
  history.replaceState(null, "", location.pathname);
  try {
    const data = await api(
      `/api/invites/${encodeURIComponent(code)}/join`,
      { method: "POST" }
    );
    await loadChats();
    await openGroup(data.group.id);
    toast(`Joined "${data.group.name}".`);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderMe() {
  if (!state.me) return;
  setAvatar($("me-avatar"), state.me);
  $("me-name").textContent = state.me.username;
  const handle = `@${state.me.username}`;
  $("me-handle").textContent = state.me.number
    ? `${handle} · ${state.me.number}`
    : handle;
  $("me-handle").title = state.me.status || handle;
  document.title = `${state.me.username} — Talkie`;
}

function emptyHint(text) {
  const element = document.createElement("div");
  element.className = "empty-list";
  element.textContent = text;
  return element;
}

function chatItem(chat, previewText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-item";
  button.dataset.username = chat.user.username;
  if (state.activeUsername === chat.user.username) {
    button.classList.add("active");
  }
  const isBlocked = Boolean(
    chat.user.blockedByMe || state.blockedUsers.has(chat.user.id)
  );
  if (isBlocked) button.classList.add("blocked");

  const avatar = document.createElement("span");
  avatar.className = "avatar chat-list-avatar";
  setAvatar(avatar, chat.user);

  const content = document.createElement("span");
  content.className = "chat-item-content";

  const top = document.createElement("span");
  top.className = "chat-item-top";
  const name = document.createElement("span");
  name.className = "chat-item-name";
  name.textContent = chat.user.username;
  const time = document.createElement("span");
  time.className = "chat-item-time";
  time.textContent = formatChatTime(chat.lastMessage.createdAt);
  top.append(name, time);

  const bottom = document.createElement("span");
  bottom.className = "chat-item-bottom";
  const preview = document.createElement("span");
  preview.className = "chat-item-preview";
  const prefix = chat.lastMessage.fromMe ? "You: " : "";
  preview.textContent = isBlocked
    ? "Blocked"
    : prefix + (previewText || "Message");
  bottom.appendChild(preview);

  if (chat.unread > 0) {
    const badge = document.createElement("span");
    badge.className = "unread-badge";
    badge.textContent = chat.unread > 99 ? "99+" : String(chat.unread);
    bottom.appendChild(badge);
  }

  content.append(top, bottom);
  button.append(avatar, content);
  button.addEventListener("click", () => openChat(chat.user.username));
  return button;
}

function groupChatItem(group, previewText) {
  const button = make("button", "chat-item");
  button.type = "button";
  if (state.activeView === "group" && state.activeGroupId === group.id) {
    button.classList.add("active");
  }

  const avatar = make("span", "avatar chat-list-avatar");
  setGroupAvatar(avatar, group);

  const content = make("span", "chat-item-content");
  const top = make("span", "chat-item-top");
  const name = make("span", "chat-item-name", group.name);
  const time = make(
    "span",
    "chat-item-time",
    formatChatTime(group.lastMessage?.createdAt || group.createdAt)
  );
  top.append(name, time);

  const bottom = make("span", "chat-item-bottom");
  const preview = make("span", "chat-item-preview", previewText || "No messages yet");
  bottom.appendChild(preview);

  if (group.unread > 0) {
    const badge = make(
      "span",
      "unread-badge",
      group.unread > 99 ? "99+" : String(group.unread)
    );
    bottom.appendChild(badge);
  }

  content.append(top, bottom);
  button.append(avatar, content);
  button.addEventListener("click", () => openGroup(group.id));
  return button;
}

async function renderChats() {
  const list = $("chat-list");
  if (!state.chats.length && !state.groups.length) {
    list.replaceChildren(
      emptyHint("No conversations yet. Search for someone or create a group.")
    );
    return;
  }

  const entries = [];
  for (const chat of state.chats) {
    entries.push({
      type: "direct",
      chat,
      time: chat.lastMessage?.createdAt || ""
    });
  }
  for (const group of state.groups) {
    entries.push({
      type: "group",
      group,
      time: group.lastMessage?.createdAt || group.createdAt
    });
  }
  entries.sort((a, b) => parseDate(b.time) - parseDate(a.time));

  const previews = await Promise.all(
    entries.map(async (entry) => {
      if (entry.type === "direct") {
        const payload = await decryptPayload(entry.chat.lastMessage).catch(
          () => ({ text: "Message", attachment: null })
        );
        const prefix = entry.chat.lastMessage.fromMe ? "You: " : "";
        return prefix + payloadPreview(payload);
      }
      if (entry.group.lastMessage) {
        const payload = await decryptGroupPayload(entry.group.lastMessage).catch(
          () => ({ text: "Message", attachment: null })
        );
        const senderName = entry.group.lastMessage.fromMe
          ? "You"
          : entry.group.lastMessage.sender?.username || "";
        return payloadPreview(payload, senderName);
      }
      return "No messages yet";
    })
  );

  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    if (entry.type === "direct") {
      fragment.appendChild(chatItem(entry.chat, previews[index]));
    } else {
      fragment.appendChild(groupChatItem(entry.group, previews[index]));
    }
  });
  list.replaceChildren(fragment);
}

async function loadChats() {
  if (!state.token || state.loadingChats) return;
  state.loadingChats = true;
  try {
    const [directData, groupData, blockData] = await Promise.all([
      api("/api/conversations"),
      api("/api/groups"),
      api("/api/blocks").catch(() => ({ users: [] }))
    ]);
    state.chats = directData.chats;
    state.groups = groupData.groups;
    state.blockedUsers = new Set(blockData.users.map((user) => user.id));
    await renderChats();
    if (state.activeView === "direct" && state.activeUser) {
      const current = state.chats.find(
        (chat) => chat.user.username === state.activeUser.username
      );
      if (current) {
        state.activeUser = current.user;
        state.blockStatus = {
          blockedByMe: Boolean(current.user.blockedByMe),
          blockedMe: Boolean(current.user.blockedMe)
        };
        renderChatHeader();
        updateComposerState();
      }
    }
  } finally {
    state.loadingChats = false;
  }
}

function renderChatHeader() {
  const blocked = Boolean(
    state.activeUser &&
      (state.activeUser.blockedByMe || state.activeUser.blockedMe)
  );
  $("call-btn").classList.toggle(
    "hidden",
    state.activeView !== "direct" || !state.activeUser || blocked
  );
  updateBlockedNotice();
  if (state.activeView === "group") {
    if (!state.activeGroup) return;
    setGroupAvatar($("chat-avatar"), state.activeGroup);
    $("chat-name").textContent = state.activeGroup.name;
    const channel = activeGroupChannel();
    const topic = activeGroupTopic();
    $("chat-status").textContent = channel
      ? `#${channel.name}${topic ? ` - ${topicTitle(topic)}` : ""}`
      : `${state.activeGroup.visibility === "public" ? "Public group" : "Private group"} - ${
          state.activeGroup.description || "no description"
        }`;
    return;
  }

  if (!state.activeUser) return;
  const user = state.activeUser;
  setAvatar($("chat-avatar"), user);
  $("chat-name").textContent = user.username;
  if (user.blockedByMe) {
    $("chat-status").textContent = "Blocked";
  } else if (user.blockedMe) {
    $("chat-status").textContent = "This user has blocked you";
  } else {
    $("chat-status").textContent =
      user.status ||
      user.pronouns ||
      (user.number ? user.number : `@${user.username}`);
  }
}

function updateBlockedNotice() {
  const notice = $("blocked-notice");
  const text = $("blocked-notice-text");
  const action = $("blocked-notice-action");
  if (!notice || !text || !action) return;
  const user = state.activeUser;
  const direct = state.activeView === "direct" && user;
  const blockedByMe = Boolean(direct && user.blockedByMe);
  const blockedMe = Boolean(direct && user.blockedMe);
  notice.classList.toggle("hidden", !blockedByMe && !blockedMe);
  action.classList.toggle("hidden", !blockedByMe);
  if (blockedByMe) {
    text.textContent = `You blocked @${user.username}.`;
  } else if (blockedMe) {
    text.textContent = `@${user.username} blocked you.`;
  }
}

function userItem(user) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-item";

  const avatar = document.createElement("span");
  avatar.className = "avatar chat-list-avatar";
  setAvatar(avatar, user);

  const content = document.createElement("span");
  content.className = "chat-item-content";
  const top = document.createElement("span");
  top.className = "chat-item-top";
  const name = document.createElement("span");
  name.className = "chat-item-name";
  name.textContent = user.username;
  top.appendChild(name);
  const bottom = document.createElement("span");
  bottom.className = "chat-item-bottom";
  const handle = document.createElement("span");
  handle.className = "chat-item-preview";
  handle.textContent = user.number
    ? `@${user.username} · ${user.number}`
    : `@${user.username}`;
  if (user.status) handle.title = user.status;
  bottom.appendChild(handle);
  content.append(top, bottom);

  const arrow = document.createElement("span");
  arrow.className = "chat-item-arrow";
  arrow.textContent = "›";

  button.append(avatar, content, arrow);
  button.addEventListener("click", () => {
    $("search-input").value = "";
    hideSearch();
    openChat(user.username);
  });
  return button;
}

function showSearchResults(users, label) {
  $("chat-list").classList.add("hidden");
  $("search-results").classList.remove("hidden");
  $("list-label").textContent = label;

  const container = $("search-results");
  container.replaceChildren();

  if (!users.length) {
    container.appendChild(emptyHint("No users found."));
    return;
  }

  const fragment = document.createDocumentFragment();
  users.forEach((user) => fragment.appendChild(userItem(user)));
  container.replaceChildren(fragment);
}

function hideSearch() {
  state.directoryOpen = false;
  $("search-results").classList.add("hidden");
  $("chat-list").classList.remove("hidden");
  $("list-label").textContent = "Chats";
}

async function performSearch(query, directory = false) {
  try {
    const data = await api(
      "/api/users" + (query ? `?q=${encodeURIComponent(query)}` : "")
    );
    if ($("search-input").value.trim() !== query) return;
    showSearchResults(data.users, directory ? "Contacts" : "Results");
    state.directoryOpen = directory;
  } catch {
    if (!state.token) return;
  }
}

function closeConversation() {
  if (!state.token) return;
  cancelRecording();
  clearReply();
  state.pendingAttachment = null;
  renderAttachmentPreview();
  state.activeView = "direct";
  state.activeUsername = null;
  state.activeUser = null;
  state.activeGroupId = null;
  state.activeGroup = null;
  state.activeChannelId = null;
  state.activeTopicId = null;
  state.messages = [];
  state.calls = [];
  state.lastMessageId = 0;
  state.forceScroll = false;
  state.loadingMessages = false;
  state.pendingMessageReload = false;
  state.pendingMessageReloadInitial = false;
  state.blockStatus = { blockedByMe: false, blockedMe: false };
  $("message-input").value = "";
  autoGrow();
  $("chat-view").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  $("group-bars").classList.add("hidden");
  $("app").classList.remove("chat-open");
  hideSearch();
  updateComposerState();
  renderChats().catch(() => {});
}

async function openChat(username) {
  if (!state.token) return;
  cancelRecording();
  clearReply();

  const identifier = String(username)
    .trim()
    .toLowerCase()
    .replace(/^[@#]+/, "");
  const identifierDigits = identifier.replace(/\D/g, "");
  const known = state.chats.find((chat) => {
    if (chat.user.username.toLowerCase() === identifier) return true;
    if (!chat.user.number || !identifierDigits) return false;
    return (
      String(chat.user.number).replace(/\D/g, "") === identifierDigits
    );
  });
  let user = known ? known.user : null;

  if (!user) {
    try {
      const data = await api(`/api/users/${encodeURIComponent(username)}`);
      user = data.user;
    } catch (error) {
      toast(error.message, true);
      return;
    }
  }

  state.activeView = "direct";
  state.activeUsername = user.username;
  state.activeUser = user;
  state.blockStatus = {
    blockedByMe: Boolean(user.blockedByMe),
    blockedMe: Boolean(user.blockedMe)
  };
  state.activeGroupId = null;
  state.activeGroup = null;
  state.activeChannelId = null;
  state.activeTopicId = null;
  state.messages = [];
  state.calls = [];
  state.lastMessageId = 0;
  state.forceScroll = true;
  state.pendingAttachment = null;
  renderAttachmentPreview();

  $("empty-state").classList.add("hidden");
  $("chat-view").classList.remove("hidden");
  $("app").classList.add("chat-open");
  $("group-bars").classList.add("hidden");
  renderChatHeader();
  updateComposerState();
  $("message-input").value = "";
  autoGrow();
  hideSearch();
  renderChats().catch(() => {});

  $("message-list").replaceChildren(
    emptyHint("Loading messages...")
  );

  try {
    await loadMessages(true);
    $("message-input").focus();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadMessages(initial) {
  if (!state.activeUsername || !state.token) return;

  if (state.loadingMessages) {
    state.pendingMessageReload = true;
    state.pendingMessageReloadInitial =
      state.pendingMessageReloadInitial || Boolean(initial);
    return;
  }

  const username = state.activeUsername;
  state.loadingMessages = true;

  try {
    const query =
      !initial && state.lastMessageId > 0
        ? `?after=${state.lastMessageId}`
        : "";
    const data = await api(
      `/api/messages/${encodeURIComponent(username)}${query}`
    );

    if (state.activeUsername !== username) return;

    if (data.user) {
      state.activeUser = data.user;
      state.blockStatus = {
        blockedByMe: Boolean(data.user.blockedByMe),
        blockedMe: Boolean(data.user.blockedMe)
      };
      renderChatHeader();
      updateComposerState();
    }

    if (initial) {
      state.messages = [];
      state.lastMessageId = 0;
    }

    const nextCalls = Array.isArray(data.calls) ? data.calls : [];
    const callsKey = nextCalls
      .map((call) => `${call.id}:${call.status}:${call.endedAt}`)
      .join("|");
    const previousCallsKey = state.calls
      .map((call) => `${call.id}:${call.status}:${call.endedAt}`)
      .join("|");
    state.calls = nextCalls;

    let added = false;
    for (const message of data.messages) {
      if (state.messages.some((item) => item.id === message.id)) continue;
      message.payload = await decryptPayload(message);
      state.messages.push(message);
      state.lastMessageId = Math.max(state.lastMessageId, message.id);
      added = true;
    }

    if (initial || added || callsKey !== previousCallsKey) renderMessages();
    if (added) loadChats().catch(() => {});
  } finally {
    state.loadingMessages = false;
    if (state.pendingMessageReload) {
      const nextInitial = state.pendingMessageReloadInitial;
      state.pendingMessageReload = false;
      state.pendingMessageReloadInitial = false;
      loadMessages(nextInitial).catch(() => {});
    }
  }
}



async function openGroup(groupId) {
  if (!state.token) return;
  cancelRecording();
  clearReply();

  try {
    const data = await api(`/api/groups/${groupId}`);
    const group = data.group;
    const sameGroup = state.activeGroupId === group.id;
    const visible = group.channels.filter(
      (channel) =>
        channel.permissions.includes("view_channel") ||
        group.canManageChannels
    );
    if (!visible.length) {
      state.activeView = "group";
      state.activeGroupId = group.id;
      state.activeGroup = group;
      state.activeChannelId = null;
      state.activeTopicId = null;
      state.activeUsername = null;
      state.activeUser = null;
      state.messages = [];
      state.lastMessageId = 0;
      $("empty-state").classList.add("hidden");
      $("chat-view").classList.remove("hidden");
      $("app").classList.add("chat-open");
      $("group-bars").classList.remove("hidden");
      renderChatHeader();
      renderGroupBars();
      updateComposerState();
      $("message-list").replaceChildren(
        emptyHint("You only have access to this group's overview.")
      );
      renderChats().catch(() => {});
      openGroupSettings("overview");
      toast("You do not have access to any channel in this group.", true);
      return;
    }

    if (!sameGroup) {
      state.activeChannelId = null;
      state.activeTopicId = null;
    }

    const channel =
      visible.find((item) => item.id === state.activeChannelId) || visible[0];
    const topic =
      channel.topics.find((item) => item.id === state.activeTopicId) ||
      channel.topics[0] ||
      null;

    state.activeView = "group";
    state.activeGroupId = group.id;
    state.activeGroup = group;
    state.activeChannelId = channel.id;
    state.activeTopicId = topic ? topic.id : null;
    state.activeUsername = null;
    state.activeUser = null;
    state.messages = [];
    state.lastMessageId = 0;
    state.forceScroll = true;
    state.pendingAttachment = null;
    renderAttachmentPreview();

    $("empty-state").classList.add("hidden");
    $("chat-view").classList.remove("hidden");
    $("app").classList.add("chat-open");
    $("group-bars").classList.remove("hidden");
    renderChatHeader();
    renderGroupBars();
    updateComposerState();
    $("message-input").value = "";
    autoGrow();
    hideSearch();
    renderChats().catch(() => {});
    $("message-list").replaceChildren(emptyHint("Loading messages..."));
    await loadGroupMessages(true);
    $("message-input").focus();
  } catch (error) {
    toast(error.message, true);
  }
}

function applyGroupUpdate(group) {
  if (!group || state.activeGroupId !== group.id) return;
  const previousChannel = state.activeChannelId;
  const previousTopic = state.activeTopicId;
  state.activeGroup = group;

  const visible = group.channels.filter(
    (channel) =>
      channel.permissions.includes("view_channel") || group.canManageChannels
  );
  const channel =
    visible.find((item) => item.id === state.activeChannelId) ||
    visible[0] ||
    null;
  state.activeChannelId = channel ? channel.id : null;
  const topic = channel
    ? channel.topics.find((item) => item.id === state.activeTopicId) ||
      channel.topics[0] ||
      null
    : null;
  state.activeTopicId = topic ? topic.id : null;

  renderChatHeader();
  renderGroupBars();
  updateComposerState();
  loadChats().catch(() => {});

  if (
    previousChannel !== state.activeChannelId ||
    previousTopic !== state.activeTopicId
  ) {
    state.messages = [];
    state.lastMessageId = 0;
    state.forceScroll = true;
    loadGroupMessages(true).catch(() => {});
  }
}

function selectGroupChannel(channelId) {
  const channel = state.activeGroup?.channels.find(
    (item) => item.id === channelId
  );
  if (!channel) return;
  state.activeChannelId = channel.id;
  state.activeTopicId = channel.topics[0] ? channel.topics[0].id : null;
  state.messages = [];
  state.lastMessageId = 0;
  state.forceScroll = true;
  renderChatHeader();
  renderGroupBars();
  updateComposerState();
  $("message-list").replaceChildren(emptyHint("Loading messages..."));
  loadGroupMessages(true).catch((error) => toast(error.message, true));
}

function selectGroupTopic(topicId) {
  const channel = activeGroupChannel();
  if (!channel || !channel.topics.some((topic) => topic.id === topicId)) return;
  state.activeTopicId = topicId;
  state.messages = [];
  state.lastMessageId = 0;
  state.forceScroll = true;
  renderChatHeader();
  renderGroupBars();
  updateComposerState();
  $("message-list").replaceChildren(emptyHint("Loading messages..."));
  loadGroupMessages(true).catch((error) => toast(error.message, true));
}

function topicTitle(topic) {
  return `${topic.emoji ? topic.emoji + " " : ""}${topic.name}`;
}

function renderGroupBars() {
  const bars = $("group-bars");
  if (state.activeView !== "group" || !state.activeGroup) {
    bars.classList.add("hidden");
    return;
  }
  bars.classList.remove("hidden");

  const channelBar = $("channel-bar");
  channelBar.replaceChildren();
  for (const channel of state.activeGroup.channels) {
    if (
      !channel.permissions.includes("view_channel") &&
      !state.activeGroup.canManageChannels
    ) {
      continue;
    }
    const button = make(
      "button",
      "channel-chip" + (channel.id === state.activeChannelId ? " active" : ""),
      `#${channel.name}`
    );
    button.type = "button";
    button.addEventListener("click", () => selectGroupChannel(channel.id));
    channelBar.appendChild(button);
  }

  const topicBar = $("topic-bar");
  const topicList = $("topic-list");
  topicBar.replaceChildren();
  topicList.replaceChildren();
  const channel = activeGroupChannel();
  if (!channel) {
    topicBar.classList.add("hidden");
    topicList.classList.add("hidden");
    return;
  }
  topicBar.classList.remove("hidden");

  const listStyle = state.activeGroup.topicStyle === "list";
  topicBar.classList.toggle("list-mode", listStyle);
  topicList.classList.toggle("hidden", !listStyle);

  if (listStyle) {
    topicBar.appendChild(make("span", "topic-bar-label", "Topics"));
    for (const topic of channel.topics) {
      const button = make(
        "button",
        "topic-list-item" +
          (topic.id === state.activeTopicId ? " active" : "") +
          (topic.closed ? " closed" : "")
      );
      button.type = "button";
      button.append(
        make("span", "topic-list-emoji", topic.emoji || "#"),
        make("span", "topic-list-name", topic.name),
        topic.closed ? make("span", "topic-list-closed", "closed") : make("span")
      );
      button.addEventListener("click", () => selectGroupTopic(topic.id));
      topicList.appendChild(button);
    }
  } else {
    for (const topic of channel.topics) {
      const button = make(
        "button",
        "topic-chip" +
          (topic.id === state.activeTopicId ? " active" : "") +
          (topic.closed ? " closed" : ""),
        topicTitle(topic)
      );
      button.type = "button";
      button.addEventListener("click", () => selectGroupTopic(topic.id));
      topicBar.appendChild(button);
    }
  }

  if (groupCan("create_topics") || groupCan("manage_topics")) {
    const add = make("button", "topic-chip topic-add", "+ Topic");
    add.type = "button";
    add.addEventListener("click", startNewTopic);
    topicBar.appendChild(add);
  }

  if (groupCan("manage_topics")) {
    const manage = make("button", "topic-chip topic-manage", "Manage");
    manage.type = "button";
    manage.title = "Manage topics";
    manage.addEventListener("click", openTopicsModal);
    topicBar.appendChild(manage);
  }
}

function startNewTopic() {
  const bar = $("topic-bar");
  if (bar.querySelector(".topic-new-form")) return;
  const form = make("div", "topic-new-form");
  const emoji = make("input", "topic-new-emoji");
  emoji.type = "text";
  emoji.maxLength = 8;
  emoji.placeholder = "🙂";
  emoji.setAttribute("aria-label", "Topic emoji");
  const input = make("input", "topic-new-input");
  input.type = "text";
  input.maxLength = 60;
  input.placeholder = "New topic";
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    createTopic(name, emoji.value.trim());
  };
  for (const field of [emoji, input]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        renderGroupBars();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
  }
  form.append(emoji, input);
  bar.appendChild(form);
  input.focus();
}

async function createTopic(name, emoji = "") {
  const group = state.activeGroup;
  const channel = activeGroupChannel();
  if (!group || !channel) return;
  try {
    const data = await api(
      `/api/groups/${group.id}/channels/${channel.id}/topics`,
      { method: "POST", body: { name, emoji } }
    );
    state.activeGroup = data.group;
    const updatedChannel = state.activeGroup.channels.find(
      (item) => item.id === channel.id
    );
    const topic = updatedChannel?.topics.find((item) => item.name === name);
    if (topic) state.activeTopicId = topic.id;
    state.messages = [];
    state.lastMessageId = 0;
    renderChatHeader();
    renderGroupBars();
    updateComposerState();
    $("message-list").replaceChildren(emptyHint("Loading messages..."));
    loadGroupMessages(true).catch(() => {});
    loadChats().catch(() => {});
  } catch (error) {
    toast(error.message, true);
  }
}

function openTopicsModal() {
  const group = state.activeGroup;
  const channel = activeGroupChannel();
  if (!group || !channel) return;
  $("topics-title").textContent = `Topics - #${channel.name}`;
  $("topics-error").textContent = "";
  renderTopicsModal();
  showModal("topics-modal");
}

function renderTopicsModal() {
  const group = state.activeGroup;
  const channel = activeGroupChannel();
  const body = $("topics-body");
  if (!group || !channel) return;
  body.replaceChildren();
  const list = make("div", "group-list");

  for (const topic of channel.topics) {
    const row = make("div", "topic-manage-row");
    const emoji = make("input", "topic-manage-emoji");
    emoji.type = "text";
    emoji.maxLength = 8;
    emoji.value = topic.emoji || "";
    emoji.placeholder = "🙂";
    emoji.setAttribute("aria-label", "Topic emoji");
    const name = make("input", "topic-manage-name");
    name.type = "text";
    name.maxLength = 60;
    name.value = topic.name;
    const closed = make("label", "check-row topic-manage-closed");
    const box = make("input");
    box.type = "checkbox";
    box.checked = topic.closed;
    closed.append(box, make("span", "", "Closed"));

    const save = make("button", "primary-btn small", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      try {
        const data = await api(
          `/api/groups/${group.id}/topics/${topic.id}`,
          {
            method: "PUT",
            body: {
              name: name.value.trim(),
              emoji: emoji.value.trim(),
              closed: box.checked
            }
          }
        );
        applyGroupUpdate(data.group);
        renderTopicsModal();
        renderGroupBars();
        toast("Topic updated.");
      } catch (error) {
        $("topics-error").textContent = error.message;
      }
    });

    const remove = make("button", "ghost-btn small", "Delete");
    remove.type = "button";
    remove.disabled = channel.topics.length <= 1;
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the topic "${topic.name}" and its messages?`)) {
        return;
      }
      try {
        const data = await api(
          `/api/groups/${group.id}/topics/${topic.id}`,
          { method: "DELETE" }
        );
        applyGroupUpdate(data.group);
        renderTopicsModal();
        renderGroupBars();
        toast("Topic deleted.");
      } catch (error) {
        $("topics-error").textContent = error.message;
      }
    });

    row.append(emoji, name, closed, save, remove);
    list.appendChild(row);
  }

  body.appendChild(list);

  const form = make("div", "topic-new-form topic-manage-new");
  const emoji = make("input", "topic-new-emoji");
  emoji.type = "text";
  emoji.maxLength = 8;
  emoji.placeholder = "🙂";
  emoji.setAttribute("aria-label", "New topic emoji");
  const name = make("input", "topic-new-input");
  name.type = "text";
  name.maxLength = 60;
  name.placeholder = "New topic";
  const add = make("button", "primary-btn small", "Create");
  add.type = "button";
  add.addEventListener("click", async () => {
    if (!name.value.trim()) return;
    await createTopic(name.value.trim(), emoji.value.trim());
    renderTopicsModal();
  });
  form.append(emoji, name, add);
  body.appendChild(make("h3", "group-section-title", "Create topic"));
  body.appendChild(form);
}

async function loadGroupMessages(initial) {
  if (state.activeView !== "group" || !state.activeGroup) return;
  const groupId = state.activeGroupId;
  const channelId = state.activeChannelId;
  const topicId = state.activeTopicId;
  if (!groupId || !channelId || !topicId || !state.token) return;

  if (state.loadingMessages) {
    state.pendingMessageReload = true;
    state.pendingMessageReloadInitial =
      state.pendingMessageReloadInitial || Boolean(initial);
    return;
  }

  state.loadingMessages = true;
  try {
    const query =
      !initial && state.lastMessageId > 0
        ? `?after=${state.lastMessageId}`
        : "";
    const data = await api(
      `/api/groups/${groupId}/channels/${channelId}/topics/${topicId}/messages${query}`
    );

    if (
      state.activeView !== "group" ||
      state.activeGroupId !== groupId ||
      state.activeChannelId !== channelId ||
      state.activeTopicId !== topicId
    ) {
      return;
    }

    if (initial) {
      state.messages = [];
      state.lastMessageId = 0;
    }

    let added = false;
    for (const message of data.messages) {
      if (state.messages.some((item) => item.id === message.id)) continue;
      message.payload = await decryptGroupPayload(message);
      state.messages.push(message);
      state.lastMessageId = Math.max(state.lastMessageId, message.id);
      added = true;
    }

    if (initial || added) renderMessages();
    if (added) loadChats().catch(() => {});
  } finally {
    state.loadingMessages = false;
    if (state.pendingMessageReload) {
      const nextInitial = state.pendingMessageReloadInitial;
      state.pendingMessageReload = false;
      state.pendingMessageReloadInitial = false;
      if (state.activeView === "group") {
        loadGroupMessages(nextInitial).catch(() => {});
      } else {
        loadMessages(nextInitial).catch(() => {});
      }
    }
  }
}

function isNearBottom(element) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight < 140
  );
}

function attachmentUrl(attachment, key) {
  if (state.attachmentUrls.has(key)) {
    return state.attachmentUrls.get(key);
  }
  const binary = atob(attachment.data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: attachment.type || "application/octet-stream"
  });
  const url = URL.createObjectURL(blob);
  state.attachmentUrls.set(key, url);
  return url;
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function pauseOtherAudio(current) {
  for (const audio of document.querySelectorAll("audio.bubble-audio-media")) {
    if (audio !== current && !audio.paused) audio.pause();
  }
}

function audioAttachmentElement(attachment, key) {
  const wrapper = make("div", "bubble-audio");
  const audio = make("audio", "bubble-audio-media");
  audio.preload = "metadata";
  audio.src = attachmentUrl(attachment, key);

  const playButton = make("button", "bubble-audio-play");
  playButton.type = "button";
  playButton.setAttribute("aria-label", "Play voice message");
  playButton.appendChild(make("span", "bubble-audio-play-icon"));

  const main = make("div", "bubble-audio-main");
  const wave = make("div", "bubble-audio-wave");
  wave.setAttribute("role", "slider");
  wave.setAttribute("tabindex", "0");
  wave.setAttribute("aria-label", "Seek voice message");
  wave.setAttribute("aria-valuemin", "0");
  wave.setAttribute("aria-valuemax", "100");
  wave.setAttribute("aria-valuenow", "0");
  const fill = make("span", "bubble-audio-wave-fill");
  const thumb = make("span", "bubble-audio-wave-thumb");
  wave.append(fill, thumb);

  const meta = make("div", "bubble-audio-meta");
  const label = make("span", "bubble-audio-label", "Voice message");
  const time = make("span", "bubble-audio-time", "0:00 / --:--");
  meta.append(label, time);
  main.append(wave, meta);
  wrapper.append(audio, playButton, main);

  const duration = () =>
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;

  const update = () => {
    const total = duration();
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const percent = total
      ? Math.min(100, Math.max(0, (current / total) * 100))
      : 0;
    wrapper.style.setProperty("--audio-progress", percent.toFixed(2));
    wave.setAttribute("aria-valuenow", String(Math.round(percent)));
    time.textContent = `${formatAudioTime(current)} / ${
      total ? formatAudioTime(total) : "--:--"
    }`;
  };

  const setPlaying = (playing) => {
    wrapper.classList.toggle("playing", playing);
    playButton.setAttribute(
      "aria-label",
      playing ? "Pause voice message" : "Play voice message"
    );
  };

  const toggle = () => {
    if (audio.paused) {
      pauseOtherAudio(audio);
      unlockAudio();
      audio.play().catch(() => toast("Could not play this audio.", true));
    } else {
      audio.pause();
    }
  };

  const seekToRatio = (ratio) => {
    const total = duration();
    if (!total) return;
    audio.currentTime = Math.min(1, Math.max(0, ratio)) * total;
    update();
  };

  playButton.addEventListener("click", toggle);
  wave.addEventListener("click", (event) => {
    const rect = wave.getBoundingClientRect();
    if (!rect.width) return;
    seekToRatio((event.clientX - rect.left) / rect.width);
  });
  wave.addEventListener("keydown", (event) => {
    const total = duration();
    if (!total) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 5 : -5;
      audio.currentTime = Math.min(total, Math.max(0, audio.currentTime + delta));
      update();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      audio.currentTime = event.key === "Home" ? 0 : total;
      update();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  });

  audio.addEventListener("loadedmetadata", update);
  audio.addEventListener("durationchange", update);
  audio.addEventListener("timeupdate", update);
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("ended", () => {
    setPlaying(false);
    update();
  });
  audio.addEventListener("error", () => {
    wrapper.classList.add("error");
    time.textContent = "Unavailable";
  });
  update();
  return wrapper;
}

function openImageLightbox(src, alt) {
  const lightbox = $("image-lightbox");
  const image = $("lightbox-image");
  if (!lightbox || !image || !src) return;
  image.src = src;
  image.alt = alt || "";
  lightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-open");
  $("lightbox-close").focus();
}

function closeImageLightbox() {
  const lightbox = $("image-lightbox");
  const image = $("lightbox-image");
  if (!lightbox || !image) return;
  lightbox.classList.add("hidden");
  image.removeAttribute("src");
  image.alt = "";
  document.body.classList.remove("lightbox-open");
}

function attachmentElement(attachment, message) {
  const type = String(attachment.type || "");
  const key = `${message.groupId ? "g" : "d"}:${message.id}:${attachment.name}`;

  if (type.startsWith("image/")) {
    const image = make("img", "bubble-image");
    image.src = attachmentUrl(attachment, key);
    image.alt = attachment.name;
    image.decoding = "async";
    image.addEventListener("click", () =>
      openImageLightbox(image.src, image.alt)
    );
    return image;
  }

  if (type.startsWith("audio/")) {
    return audioAttachmentElement(attachment, key);
  }

  const link = make(
    "a",
    "bubble-file",
    `${attachment.name} (${formatFileSize(attachment.size)})`
  );
  link.href = attachmentUrl(attachment, key);
  link.download = attachment.name;
  return link;
}

function callHistoryLabel(call) {
  if (call.status === "completed") {
    return call.fromMe ? "Outgoing call" : "Incoming call";
  }
  if (call.status === "declined") {
    return call.fromMe ? "Call declined" : "You declined the call";
  }
  if (call.status === "missed" || call.status === "no-answer") {
    return call.fromMe ? "No answer" : "Missed call";
  }
  if (call.status === "blocked") return "Blocked call";
  if (call.status === "canceled") {
    return call.fromMe ? "Outgoing call" : "Missed call";
  }
  return call.fromMe ? "Outgoing call" : "Incoming call";
}

function callHistoryElement(call) {
  const missed = call.status === "missed" || call.status === "no-answer";
  const row = make("div", "call-log" + (missed ? " missed" : ""));
  const card = make("div", "call-log-card");
  const icon = make(
    "span",
    "call-log-icon",
    missed ? "×" : call.fromMe ? "↗" : "↙"
  );
  const body = make("div", "call-log-body");
  const title = make("strong", "call-log-title", callHistoryLabel(call));
  const details = [formatTime(call.createdAt)];
  if (call.status === "completed" && call.durationSeconds > 0) {
    details.push(formatCallDuration(call.durationSeconds * 1000));
  }
  const meta = make("span", "call-log-meta", details.join(" · "));
  body.append(title, meta);
  card.append(icon, body);
  row.appendChild(card);
  return row;
}

function messageElement(message) {
  const row = make("div", "msg-row " + (message.fromMe ? "out" : "in"));
  row.dataset.messageId = String(message.id);
  const stack = make("div", "msg-stack");

  if (
    state.activeView === "group" &&
    !message.fromMe &&
    message.sender &&
    message.sender.username
  ) {
    stack.appendChild(make("div", "msg-sender", message.sender.username));
  }

  const bubble = make("div", "bubble");
  const payload = message.payload || {
    text: typeof message.plaintext === "string" ? message.plaintext : "",
    attachment: null
  };

  const reply = payload.replyTo;
  if (reply && typeof reply === "object" && reply.id) {
    const quote = make("button", "bubble-reply");
    quote.type = "button";
    const author =
      reply.username === (state.me && state.me.username)
        ? "You"
        : String(reply.username || "Message");
    quote.append(
      make("span", "bubble-reply-name", author),
      make(
        "span",
        "bubble-reply-text",
        String(reply.preview || "Message").slice(0, 140)
      )
    );
    quote.addEventListener("click", () => scrollToMessage(reply.id));
    bubble.appendChild(quote);
  }

  if (payload.attachment) {
    bubble.appendChild(attachmentElement(payload.attachment, message));
  }

  if (payload.text) {
    bubble.appendChild(make("div", "bubble-text", payload.text));
  }

  const meta = make("div", "bubble-meta");
  meta.appendChild(make("span", "", formatTime(message.createdAt)));

  if (message.fromMe && state.activeView === "direct") {
    const checks = make(
      "span",
      "checks" + (message.read ? " read" : ""),
      message.read ? "✓✓" : "✓"
    );
    meta.appendChild(checks);
  }

  bubble.appendChild(meta);
  stack.appendChild(bubble);

  const actions = make("div", "msg-actions");
  const replyAction = make("button", "msg-action", "Reply");
  replyAction.type = "button";
  replyAction.title = "Reply to this message";
  replyAction.addEventListener("click", (event) => {
    event.stopPropagation();
    setReplyTo(message);
  });
  actions.appendChild(replyAction);

  if (canDeleteMessage(message)) {
    const deleteAction = make("button", "msg-action delete", "Delete");
    deleteAction.type = "button";
    deleteAction.title = "Delete this message";
    deleteAction.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteMessage(message).catch(() => {});
    });
    actions.appendChild(deleteAction);
  }

  stack.appendChild(actions);
  row.appendChild(stack);
  return row;
}

function renderMessages() {
  const list = $("message-list");
  const stickToBottom = isNearBottom(list) || state.forceScroll;
  const fragment = document.createDocumentFragment();
  let lastDay = "";

  const calls = state.activeView === "direct" ? state.calls : [];
  const timeline = [
    ...state.messages.map((message) => ({
      type: "message",
      id: message.id,
      createdAt: message.createdAt,
      message
    })),
    ...calls.map((call) => ({
      type: "call",
      id: call.id,
      createdAt: call.createdAt,
      call
    }))
  ].sort((a, b) => {
    const timeA = parseDate(a.createdAt).getTime();
    const timeB = parseDate(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    if (a.type !== b.type) return a.type === "call" ? -1 : 1;
    return a.id - b.id;
  });

  for (const entry of timeline) {
    const key = dayKey(entry.createdAt);
    if (key !== lastDay) {
      const divider = document.createElement("div");
      divider.className = "day-divider";
      const label = document.createElement("span");
      label.textContent = dayLabel(entry.createdAt);
      divider.appendChild(label);
      fragment.appendChild(divider);
      lastDay = key;
    }
    fragment.appendChild(
      entry.type === "call"
        ? callHistoryElement(entry.call)
        : messageElement(entry.message)
    );
  }

  if (!timeline.length) {
    fragment.appendChild(
      emptyHint(
        state.activeView === "group"
          ? "No messages in this topic yet."
          : "No messages or calls yet. Start the conversation."
      )
    );
  }

  list.replaceChildren(fragment);
  state.forceScroll = false;
  if (stickToBottom) list.scrollTop = list.scrollHeight;
}

function autoGrow() {
  const input = $("message-input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}

async function prepareAttachment(file) {
  if (!file) return null;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment too large (maximum 2 MB).");
  }

  let dataUrl;
  let type = file.type || "application/octet-stream";
  let name = file.name || "attachment";

  if (type.startsWith("image/")) {
    dataUrl = await readFileAsDataUrl(file);
    dataUrl = await resizeImage(dataUrl, 1600, 1600);
    type = "image/jpeg";
    if (!/\.(png|jpe?g|webp)$/i.test(name)) name += ".jpg";
  } else {
    dataUrl = await readFileAsDataUrl(file);
  }

  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Could not read the attachment.");
  const data = dataUrl.slice(comma + 1);
  const size = Math.floor((data.length * 3) / 4);

  if (data.length > MAX_ATTACHMENT_BYTES * 1.4) {
    throw new Error("Attachment is too large after encoding.");
  }

  return { name, type, size, data };
}

function setPendingAttachment(attachment) {
  const old = state.attachmentUrls.get("pending");
  if (old) {
    URL.revokeObjectURL(old);
    state.attachmentUrls.delete("pending");
  }
  state.pendingAttachment = attachment;
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const container = $("attachment-preview");
  if (!container) return;
  container.replaceChildren();
  const attachment = state.pendingAttachment;
  if (!attachment) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  const type = String(attachment.type || "");
  if (type.startsWith("image/")) {
    const image = make("img", "attachment-thumb");
    image.src = attachmentUrl(attachment, "pending");
    image.alt = attachment.name;
    image.addEventListener("click", () =>
      openImageLightbox(image.src, image.alt)
    );
    container.appendChild(image);
  } else if (type.startsWith("audio/")) {
    const audio = make("audio", "attachment-audio");
    audio.controls = true;
    audio.src = attachmentUrl(attachment, "pending");
    container.appendChild(audio);
  } else {
    container.appendChild(make("span", "attachment-icon", "FILE"));
  }

  const info = make("span", "attachment-info");
  info.append(
    make("strong", "", attachment.name),
    make("span", "", formatFileSize(attachment.size))
  );
  container.appendChild(info);

  const remove = make("button", "icon-btn attachment-remove", "×");
  remove.type = "button";
  remove.title = "Remove attachment";
  remove.addEventListener("click", () => setPendingAttachment(null));
  container.appendChild(remove);
}

function updateComposerState() {
  const input = $("message-input");
  const attach = $("attach-btn");
  const mic = $("mic-btn");
  if (!input || !attach || !mic) return;
  if (state.mediaRecorder) return;

  let canText = true;
  let canMedia = true;
  let placeholder = "Write a message";

  if (state.activeView === "group") {
    const channel = activeGroupChannel();
    const topic = activeGroupTopic();
    canText = Boolean(
      channel && channel.permissions.includes("send_messages")
    );
    canMedia = Boolean(channel && channel.permissions.includes("send_media"));

    if (!channel) {
      canText = false;
      canMedia = false;
      placeholder = "No channel selected";
    } else if (topic && topic.closed) {
      canText = false;
      canMedia = false;
      placeholder = "This topic is closed";
    } else if (!canText && !canMedia) {
      placeholder = "You cannot send messages in this channel";
    } else if (!canText) {
      placeholder = "You cannot send text here, but you can send media";
    } else if (!canMedia) {
      placeholder = "You cannot send media in this channel";
    }
  } else if (!state.activeUser) {
    canText = false;
    canMedia = false;
    placeholder = "Select a chat";
  } else if (state.activeUser.blockedByMe) {
    canText = false;
    canMedia = false;
    placeholder = "Unblock this user to send messages";
  } else if (state.activeUser.blockedMe) {
    canText = false;
    canMedia = false;
    placeholder = "This user has blocked you";
  }

  input.disabled = !canText;
  input.placeholder = placeholder;
  attach.disabled = !canMedia;
  mic.disabled = !canMedia;
}

async function toggleRecording() {
  if (state.mediaRecorder) {
    state.discardRecording = false;
    state.mediaRecorder.stop();
    return;
  }

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("Audio recording is not supported in this browser.", true);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });

    state.recordingStream = stream;
    state.mediaRecorder = recorder;
    state.recordingChunks = [];
    state.recordingStartedAt = Date.now();

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) {
        state.recordingChunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", async () => {
      const blob = new Blob(state.recordingChunks, { type: mimeType });
      const discard = state.discardRecording;
      state.discardRecording = false;
      cleanupRecording();
      if (discard || !blob.size) return;
      try {
        const file = new File([blob], "voice-message.webm", {
          type: mimeType
        });
        setPendingAttachment(await prepareAttachment(file));
        toast("Voice message ready to send.");
      } catch (error) {
        toast(error.message, true);
      }
    });

    recorder.start();
    $("mic-btn").classList.add("recording");
    $("mic-btn").title = "Stop recording";
    $("composer").classList.add("is-recording");
    $("message-input").placeholder = "Recording 0s — click the mic to stop";
    state.recordingTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      $("message-input").placeholder = `Recording ${seconds}s — click the mic to stop`;
      if (seconds >= 120) recorder.stop();
    }, 500);
    unlockAudio();
  } catch {
    toast("Microphone access was denied.", true);
  }
}

function cleanupRecording() {
  if (state.recordingTimer) {
    clearInterval(state.recordingTimer);
    state.recordingTimer = null;
  }
  if (state.recordingStream) {
    for (const track of state.recordingStream.getTracks()) track.stop();
    state.recordingStream = null;
  }
  state.mediaRecorder = null;
  state.recordingChunks = [];
  const mic = $("mic-btn");
  if (mic) {
    mic.classList.remove("recording");
    mic.title = "Record audio";
  }
  const composer = $("composer");
  if (composer) composer.classList.remove("is-recording");
  updateComposerState();
}

function cancelRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.discardRecording = true;
    state.mediaRecorder.stop();
    return;
  }
  cleanupRecording();
}

async function sendMessage(event) {
  if (event) event.preventDefault();
  if (!state.token) return;

  const isGroup = state.activeView === "group";
  if (isGroup) {
    if (
      !state.activeGroup ||
      !state.activeChannelId ||
      !state.activeTopicId
    ) {
      return;
    }
  } else if (!state.activeUser) {
    return;
  }

  const input = $("message-input");
  const text = input.value.trim();
  const attachment = state.pendingAttachment;
  if (!text && !attachment) return;

  if (!state.me.publicKey) {
    toast("Public key unavailable.", true);
    return;
  }
  if (!isGroup && !state.activeUser.publicKey) {
    toast("Public key unavailable for this contact.", true);
    return;
  }

  const kind = attachment
    ? attachment.type.startsWith("image/")
      ? "image"
      : attachment.type.startsWith("audio/")
        ? "audio"
        : "file"
    : "text";

  if (isGroup) {
    if (kind === "text" && !groupCan("send_messages")) {
      toast("You cannot send messages in this channel.", true);
      return;
    }
    if (kind !== "text" && !groupCan("send_media")) {
      toast("You cannot send media in this channel.", true);
      return;
    }
    if (activeGroupTopic()?.closed) {
      toast("This topic is closed.", true);
      return;
    }
  }

  const button = $("send-btn");
  if (button.disabled) return;
  button.disabled = true;

  const payload = { text, attachment: attachment || null };
  if (state.replyTo) {
    payload.replyTo = {
      id: state.replyTo.id,
      username: messageAuthorUsername(state.replyTo),
      preview: replyPreviewText(state.replyTo.payload || {})
    };
  }
  const group = state.activeGroup;
  const channelId = state.activeChannelId;
  const topicId = state.activeTopicId;
  const target = state.activeUser;

  try {
    if (isGroup) {
      const members = group.members.filter((member) => member.publicKey);
      const encrypted = await encryptGroupPayload(payload, members);
      const saved = await api(
        `/api/groups/${group.id}/channels/${channelId}/topics/${topicId}/messages`,
        {
          method: "POST",
          body: { kind, ...encrypted }
        }
      );

      if (
        state.activeView !== "group" ||
        state.activeGroupId !== group.id ||
        state.activeChannelId !== channelId ||
        state.activeTopicId !== topicId
      ) {
        loadChats().catch(() => {});
        return;
      }

      const message = {
        id: saved.id,
        groupId: group.id,
        channelId,
        topicId,
        kind,
        fromMe: true,
        sender: {
          id: state.me.id,
          username: state.me.username,
          number: state.me.number,
          avatar: state.me.avatar
        },
        key: null,
        createdAt: saved.createdAt,
        payload
      };
      state.groupPlaintextCache.set(`group:${message.id}`, payload);
      state.messages.push(message);
      state.lastMessageId = Math.max(state.lastMessageId, message.id);
    } else {
      const serialized = JSON.stringify(payload);
      const [forRecipient, forSender] = await Promise.all([
        encryptFor(target.publicKey, serialized),
        encryptFor(state.me.publicKey, serialized)
      ]);

      const saved = await api("/api/messages", {
        method: "POST",
        body: {
          to: target.username,
          ephemeralPublicKey: forRecipient.ephemeralPublicKey,
          iv: forRecipient.iv,
          ciphertext: forRecipient.ciphertext,
          senderEphemeralPublicKey: forSender.ephemeralPublicKey,
          senderIv: forSender.iv,
          senderCiphertext: forSender.ciphertext
        }
      });

      if (
        state.activeView !== "direct" ||
        state.activeUsername !== target.username
      ) {
        loadChats().catch(() => {});
        return;
      }

      const message = {
        id: saved.id,
        fromMe: true,
        read: false,
        createdAt: saved.createdAt,
        payload
      };
      state.plaintextCache.set(`${message.id}:out`, payload);
      state.messages.push(message);
      state.lastMessageId = Math.max(state.lastMessageId, message.id);
    }

    state.forceScroll = true;
    input.value = "";
    setPendingAttachment(null);
    clearReply();
    autoGrow();
    renderMessages();
    loadChats().catch(() => {});
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    updateComposerState();
    input.focus();
  }
}

function renderLinksEditor(links) {
  const container = $("links-editor");
  container.replaceChildren();

  if (!links.length) {
    const hint = document.createElement("p");
    hint.className = "links-empty";
    hint.textContent = "No links added.";
    container.appendChild(hint);
    return;
  }

  links.forEach((link) => {
    container.appendChild(linkRow(link.label, link.url));
  });
}

function linkRow(label = "", url = "") {
  const row = document.createElement("div");
  row.className = "link-row";

  const labelInput = document.createElement("input");
  labelInput.className = "link-label";
  labelInput.placeholder = "Link name";
  labelInput.maxLength = 40;
  labelInput.value = label;

  const urlInput = document.createElement("input");
  urlInput.className = "link-url";
  urlInput.placeholder = "https://...";
  urlInput.maxLength = 500;
  urlInput.value = url;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn link-remove";
  remove.title = "Remove link";
  remove.setAttribute("aria-label", "Remove link");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    const container = row.parentElement;
    row.remove();
    if (!container.querySelector(".link-row")) renderLinksEditor([]);
  });

  row.append(labelInput, urlInput, remove);
  return row;
}

function collectLinks() {
  const rows = Array.from(
    $("links-editor").querySelectorAll(".link-row")
  );
  const links = [];

  for (const row of rows) {
    const label = row.querySelector(".link-label").value.trim();
    const url = row.querySelector(".link-url").value.trim();
    if (!label && !url) continue;
    if (!label || !url) {
      throw new Error("Fill in a name and URL for each link.");
    }
    links.push({ label, url });
  }

  return links;
}

function openProfileEditor() {
  if (!state.me) return;

  state.profileAvatar = state.me.avatar || "";
  state.profileBanner = state.me.banner || "";
  $("edit-username").textContent = "@" + state.me.username;
  $("edit-number").textContent = state.me.number || "—";
  $("edit-status").value = state.me.status || "";
  $("edit-pronouns").value = state.me.pronouns || "";
  $("edit-bio").value = state.me.bio || "";
  $("profile-error").textContent = "";
  setAvatar($("edit-avatar"), state.me);
  setBanner($("edit-banner"), state.profileBanner);
  renderLinksEditor(Array.isArray(state.me.links) ? state.me.links : []);
  showModal("profile-modal");
}

async function saveProfile() {
  const button = $("profile-save");
  const errorElement = $("profile-error");
  errorElement.textContent = "";
  button.disabled = true;

  try {
    const links = collectLinks();
    const data = await api("/api/me", {
      method: "PUT",
      body: {
        avatar: state.profileAvatar || "",
        banner: state.profileBanner || "",
        status: $("edit-status").value.trim(),
        pronouns: $("edit-pronouns").value.trim(),
        bio: $("edit-bio").value.trim(),
        links
      }
    });

    state.me = data.user;
    saveSession();
    renderMe();
    hideModal("profile-modal");
    toast("Profile updated.");
    loadChats().catch(() => {});
  } catch (error) {
    errorElement.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read the image."));
    reader.readAsDataURL(file);
  });
}

function resizeImage(dataUrl, maxWidth, maxHeight) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const ratio = Math.min(
        maxWidth / image.width,
        maxHeight / image.height,
        1
      );
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    image.onerror = () => reject(new Error("Invalid image."));
    image.src = dataUrl;
  });
}

async function handleImageFile(file, maxWidth, maxHeight) {
  if (!file) return "";

  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    throw new Error("Choose a PNG, JPEG or WebP image.");
  }

  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Image too large (maximum 8 MB).");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const resized = await resizeImage(dataUrl, maxWidth, maxHeight);

  if (resized.length > 1600000) {
    throw new Error("Image too large after compression.");
  }

  return resized;
}

function groupField(labelText, control) {
  const label = make("label", "field");
  label.append(make("span", "", labelText), control);
  return label;
}

function syncNewGroupCodeField() {
  const isPublic = $("new-group-visibility").value === "public";
  $("new-group-code-field").classList.toggle("hidden", !isPublic);
  $("new-group-code-hint").classList.toggle("hidden", !isPublic);
}

function openNewGroupModal() {
  $("new-group-name").value = "";
  $("new-group-description").value = "";
  $("new-group-visibility").value = "private";
  $("new-group-code").value = "";
  $("new-group-error").textContent = "";
  syncNewGroupCodeField();
  showModal("new-group-modal");
  $("new-group-name").focus();
}

async function createGroup() {
  const name = $("new-group-name").value.trim();
  const description = $("new-group-description").value.trim();
  const visibility = $("new-group-visibility").value;
  const inviteCode = $("new-group-code").value.trim();
  const error = $("new-group-error");
  error.textContent = "";
  if (!name) {
    error.textContent = "Enter a group name.";
    return;
  }

  const button = $("new-group-create");
  button.disabled = true;
  try {
    const data = await api("/api/groups", {
      method: "POST",
      body: { name, description, visibility, inviteCode }
    });
    hideModal("new-group-modal");
    await loadChats();
    await openGroup(data.group.id);
    toast(`Group "${data.group.name}" created.`);
  } catch (errorValue) {
    error.textContent = errorValue.message;
  } finally {
    button.disabled = false;
  }
}

function allowedGroupTabs(group) {
  const tabs = new Set(["overview"]);
  if (group.canManageMembers) tabs.add("members");
  if (group.canManageRoles) tabs.add("roles");
  if (group.canManageChannels) tabs.add("channels");
  return tabs;
}

function openGroupSettings(tab = state.groupModalTab) {
  if (!state.activeGroup) return;
  const allowed = allowedGroupTabs(state.activeGroup);
  state.groupModalTab = allowed.has(tab) ? tab : "overview";
  $("group-modal-title").textContent = state.activeGroup.name;
  $("group-error").textContent = "";
  showModal("group-modal");
  renderGroupModal();
}

function renderGroupModal() {
  const group = state.activeGroup;
  if (!group) return;
  const allowed = allowedGroupTabs(group);
  if (!allowed.has(state.groupModalTab)) state.groupModalTab = "overview";
  $("group-modal-title").textContent = group.name;
  document.querySelectorAll("#group-tabs .modal-tab").forEach((tab) => {
    const visible = allowed.has(tab.dataset.tab);
    tab.classList.toggle("hidden", !visible);
    tab.classList.toggle(
      "active",
      visible && tab.dataset.tab === state.groupModalTab
    );
  });

  const body = $("group-modal-body");
  body.replaceChildren();

  if (state.groupModalTab === "members") {
    renderGroupMembers(body, group);
  } else if (state.groupModalTab === "roles") {
    renderGroupRoles(body, group);
  } else if (state.groupModalTab === "channels") {
    renderGroupChannels(body, group);
  } else {
    renderGroupOverview(body, group);
  }
}

function inviteLinkFor(group) {
  return group.inviteCode
    ? `${location.origin}/invite/${group.inviteCode}`
    : "";
}

function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).catch(() => {});
  } else {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand("copy");
    } catch {
      // Ignore clipboard failures.
    }
    helper.remove();
  }
  toast("Invite link copied.");
}

function renderGroupOverview(body, group) {
  const avatarRow = make("div", "avatar-row group-avatar-row");
  const avatar = make("span", "avatar profile-avatar");
  setGroupAvatar(avatar, group);
  avatarRow.appendChild(avatar);

  if (group.canManageGroup) {
    const change = make("button", "ghost-btn", "Change group photo");
    change.type = "button";
    change.addEventListener("click", () => $("group-avatar-file").click());
    avatarRow.appendChild(change);
  }
  body.appendChild(avatarRow);

  const name = make("input");
  name.type = "text";
  name.maxLength = 80;
  name.value = group.name;
  name.disabled = !group.canManageGroup;
  body.appendChild(groupField("Group name", name));

  const description = make("textarea");
  description.rows = 3;
  description.maxLength = 500;
  description.value = group.description;
  description.disabled = !group.canManageGroup;
  body.appendChild(groupField("Description", description));

  let visibility = null;
  if (group.canManageGroup) {
    visibility = make("select");
    for (const value of ["private", "public"]) {
      const option = make(
        "option",
        "",
        value === "private" ? "Private - invite only" : "Public - invite link"
      );
      option.value = value;
      option.selected = (group.visibility || "private") === value;
      visibility.appendChild(option);
    }
    body.appendChild(groupField("Visibility", visibility));
  } else {
    const readonly = make(
      "div",
      "readonly-value",
      (group.visibility || "private") === "public"
        ? "Public group"
        : "Private group"
    );
    const field = groupField("Visibility", readonly);
    field.classList.add("readonly");
    body.appendChild(field);
  }

  const codeField = make("label", "field hidden");
  const codeInput = make("input");
  codeInput.type = "text";
  codeInput.maxLength = 32;
  codeInput.placeholder = "Leave blank to generate one";
  codeInput.value = group.inviteCode || "";
  codeInput.disabled = !group.canManageGroup;
  codeField.append(make("span", "", "Invite code"), codeInput);

  const linkField = make("label", "field hidden");
  const linkInput = make("input");
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = inviteLinkFor(group);
  const linkRow = make("div", "invite-link-row");
  linkRow.append(linkInput);
  if (group.inviteCode) {
    const copy = make("button", "ghost-btn small", "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(linkInput.value));
    linkRow.appendChild(copy);
  }
  linkField.append(make("span", "", "Invite link"), linkRow);

  const syncVisibility = () => {
    const isPublic =
      (visibility ? visibility.value : group.visibility || "private") ===
      "public";
    codeField.classList.toggle("hidden", !isPublic);
    linkField.classList.toggle("hidden", !isPublic || !linkInput.value);
  };

  if (visibility) visibility.addEventListener("change", syncVisibility);
  body.appendChild(codeField);
  body.appendChild(linkField);

  let topicStyle = null;
  if (group.canManageGroup) {
    topicStyle = make("select");
    for (const value of ["chips", "list"]) {
      const option = make(
        "option",
        "",
        value === "chips" ? "Chips (horizontal)" : "List (conversation style)"
      );
      option.value = value;
      option.selected = (group.topicStyle || "chips") === value;
      topicStyle.appendChild(option);
    }
    body.appendChild(groupField("Topic display", topicStyle));
  } else {
    const readonly = make(
      "div",
      "readonly-value",
      (group.topicStyle || "chips") === "list" ? "List" : "Chips"
    );
    const field = groupField("Topic display", readonly);
    field.classList.add("readonly");
    body.appendChild(field);
  }

  const meta = make("p", "muted group-meta");
  meta.textContent = `${group.members.length} member${
    group.members.length === 1 ? "" : "s"
  } - ${group.channels.length} channel${
    group.channels.length === 1 ? "" : "s"
  }`;
  body.appendChild(meta);
  syncVisibility();

  if (!group.channels.length) {
    body.appendChild(
      make(
        "p",
        "muted group-meta",
        "You do not have access to any channel in this group."
      )
    );
  }

  if (group.canManageGroup) {
    const save = make("button", "primary-btn", "Save group");
    save.type = "button";
    save.addEventListener("click", async () => {
      try {
        const data = await api(`/api/groups/${group.id}`, {
          method: "PUT",
          body: {
            name: name.value.trim(),
            description: description.value.trim(),
            visibility: visibility ? visibility.value : group.visibility,
            inviteCode: codeInput.value.trim(),
            topicStyle: topicStyle ? topicStyle.value : group.topicStyle
          }
        });
        applyGroupUpdate(data.group);
        renderGroupModal();
        toast("Group updated.");
      } catch (error) {
        $("group-error").textContent = error.message;
      }
    });
    body.appendChild(save);
  }

  if (group.ownerId === state.me.id) {
    const remove = make("button", "danger-btn", "Delete group");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${group.name}" permanently?`)) return;
      try {
        await api(`/api/groups/${group.id}`, { method: "DELETE" });
        hideModal("group-modal");
        state.activeView = "direct";
        state.activeGroup = null;
        state.activeGroupId = null;
        state.activeChannelId = null;
        state.activeTopicId = null;
        state.messages = [];
        state.lastMessageId = 0;
        $("chat-view").classList.add("hidden");
        $("empty-state").classList.remove("hidden");
        $("group-bars").classList.add("hidden");
        await loadChats();
        toast("Group deleted.");
      } catch (error) {
        $("group-error").textContent = error.message;
      }
    });
    body.appendChild(remove);
  } else {
    const leave = make("button", "danger-btn", "Leave group");
    leave.type = "button";
    leave.addEventListener("click", async () => {
      if (!window.confirm(`Leave "${group.name}"?`)) return;
      try {
        await api(`/api/groups/${group.id}/leave`, { method: "POST" });
        hideModal("group-modal");
        state.activeView = "direct";
        state.activeGroup = null;
        state.activeGroupId = null;
        state.activeChannelId = null;
        state.activeTopicId = null;
        state.messages = [];
        state.lastMessageId = 0;
        $("chat-view").classList.add("hidden");
        $("empty-state").classList.remove("hidden");
        $("group-bars").classList.add("hidden");
        await loadChats();
        toast("You left the group.");
      } catch (error) {
        $("group-error").textContent = error.message;
      }
    });
    body.appendChild(leave);
  }
}

function renderGroupMembers(body, group) {
  const list = make("div", "group-list");
  for (const member of group.members) {
    const row = make("div", "member-row");
    const avatar = make("span", "avatar member-avatar");
    setAvatar(avatar, member);
    const info = make("div", "member-info");
    info.append(
      make("strong", "", member.username),
      make(
        "span",
        "muted",
        member.number ? member.number : `@${member.username}`
      )
    );
    row.append(avatar, info);

    if (member.isOwner) {
      row.appendChild(make("span", "chip", "Owner"));
    } else if (group.canManageMembers) {
      const select = make("select", "role-select");
      for (const role of group.roles) {
        const option = make("option", "", role.name);
        option.value = String(role.id);
        option.selected = role.id === member.roleId;
        select.appendChild(option);
      }
      select.addEventListener("change", async () => {
        try {
          const data = await api(
            `/api/groups/${group.id}/members/${member.id}`,
            {
              method: "PUT",
              body: { roleId: Number(select.value) }
            }
          );
          applyGroupUpdate(data.group);
          renderGroupModal();
          toast("Member role updated.");
        } catch (error) {
          $("group-error").textContent = error.message;
        }
      });
      row.appendChild(select);

      const remove = make("button", "ghost-btn small", "Remove");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${member.username} from the group?`)) {
          return;
        }
        try {
          await api(`/api/groups/${group.id}/members/${member.id}`, {
            method: "DELETE"
          });
          const data = await api(`/api/groups/${group.id}`);
          applyGroupUpdate(data.group);
          renderGroupModal();
          toast("Member removed.");
        } catch (error) {
          $("group-error").textContent = error.message;
        }
      });
      row.appendChild(remove);
    } else {
      const role = group.roles.find((item) => item.id === member.roleId);
      row.appendChild(make("span", "chip", role ? role.name : "Member"));
    }

    list.appendChild(row);
  }
  body.appendChild(list);

  if (!group.canManageMembers) return;

  const form = make("div", "group-form");
  const input = make("input");
  input.type = "text";
  input.placeholder = "Username or number";
  input.maxLength = 40;
  const roleSelect = make("select", "role-select");
  for (const role of group.roles) {
    const option = make("option", "", role.name);
    option.value = String(role.id);
    option.selected = Boolean(role.isDefault);
    roleSelect.appendChild(option);
  }
  const add = make("button", "primary-btn small", "Add member");
  add.type = "button";
  add.addEventListener("click", async () => {
    const identifier = input.value.trim();
    if (!identifier) return;
    try {
      const data = await api(`/api/groups/${group.id}/members`, {
        method: "POST",
        body: { identifier, roleId: Number(roleSelect.value) }
      });
      input.value = "";
      applyGroupUpdate(data.group);
      renderGroupModal();
      toast("Member added.");
    } catch (error) {
      $("group-error").textContent = error.message;
    }
  });
  form.append(input, roleSelect, add);
  body.appendChild(make("h3", "group-section-title", "Add member"));
  body.appendChild(form);
}

function renderGroupRoles(body, group) {
  const list = make("div", "group-list");
  for (const role of group.roles) {
    const card = make("div", "role-card");
    const top = make("div", "role-top");
    const name = make("input");
    name.type = "text";
    name.maxLength = 40;
    name.value = role.name;
    name.disabled = !group.canManageRoles;
    const color = make("input", "role-color");
    color.type = "color";
    color.value = role.color;
    color.disabled = !group.canManageRoles;
    top.append(name, color);
    if (role.isDefault) top.appendChild(make("span", "chip", "Default"));
    card.appendChild(top);

    const permissions = make("div", "role-permissions");
    for (const [key, label] of Object.entries(PERMISSION_LABELS)) {
      const check = make("label", "check-row");
      const box = make("input");
      box.type = "checkbox";
      box.value = key;
      box.checked = role.permissions.includes(key);
      box.disabled = !group.canManageRoles;
      check.append(box, make("span", "", label));
      permissions.appendChild(check);
    }
    card.appendChild(permissions);

    if (group.canManageRoles) {
      const actions = make("div", "role-actions");
      const save = make("button", "primary-btn small", "Save role");
      save.type = "button";
      save.addEventListener("click", async () => {
        const selected = [...permissions.querySelectorAll("input:checked")].map(
          (box) => box.value
        );
        try {
          const data = await api(
            `/api/groups/${group.id}/roles/${role.id}`,
            {
              method: "PUT",
              body: {
                name: name.value.trim(),
                color: color.value,
                permissions: selected
              }
            }
          );
          applyGroupUpdate(data.group);
          renderGroupModal();
          toast("Role updated.");
        } catch (error) {
          $("group-error").textContent = error.message;
        }
      });
      actions.appendChild(save);

      if (!role.isDefault) {
        const remove = make("button", "ghost-btn small", "Delete");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete the role "${role.name}"?`)) return;
          try {
            const data = await api(
              `/api/groups/${group.id}/roles/${role.id}`,
              { method: "DELETE" }
            );
            applyGroupUpdate(data.group);
            renderGroupModal();
            toast("Role deleted.");
          } catch (error) {
            $("group-error").textContent = error.message;
          }
        });
        actions.appendChild(remove);
      }
      card.appendChild(actions);
    }

    list.appendChild(card);
  }
  body.appendChild(list);

  if (group.canManageRoles) {
    const add = make("button", "primary-btn", "Create role");
    add.type = "button";
    add.addEventListener("click", async () => {
      try {
        const data = await api(`/api/groups/${group.id}/roles`, {
          method: "POST",
          body: {
            name: "New role",
            color: "#5eb5f7",
            permissions: ["view_channel", "send_messages", "send_media"]
          }
        });
        applyGroupUpdate(data.group);
        renderGroupModal();
        toast("Role created.");
      } catch (error) {
        $("group-error").textContent = error.message;
      }
    });
    body.appendChild(add);
  }
}

function renderGroupChannels(body, group) {
  const list = make("div", "group-list");
  for (const channel of group.channels) {
    const card = make("div", "channel-card");
    const top = make("div", "channel-top");
    const name = make("input");
    name.type = "text";
    name.maxLength = 40;
    name.value = channel.name;
    name.disabled = !group.canManageChannels;
    const kind = make("select", "role-select");
    for (const value of ["text", "announcement"]) {
      const option = make("option", "", value === "text" ? "Text" : "Announcement");
      option.value = value;
      option.selected = channel.kind === value;
      kind.appendChild(option);
    }
    kind.disabled = !group.canManageChannels;
    top.append(name, kind);
    card.appendChild(top);

    const description = make("input");
    description.type = "text";
    description.maxLength = 300;
    description.placeholder = "Channel description";
    description.value = channel.description;
    description.disabled = !group.canManageChannels;
    card.appendChild(description);

    const meta = make("p", "muted");
    meta.textContent = `${channel.topics.length} topic${
      channel.topics.length === 1 ? "" : "s"
    }`;
    card.appendChild(meta);

    if (group.canManageChannels) {
      const actions = make("div", "role-actions");
      const save = make("button", "primary-btn small", "Save channel");
      save.type = "button";
      save.addEventListener("click", async () => {
        try {
          const data = await api(
            `/api/groups/${group.id}/channels/${channel.id}`,
            {
              method: "PUT",
              body: {
                name: name.value.trim(),
                description: description.value.trim(),
                kind: kind.value
              }
            }
          );
          applyGroupUpdate(data.group);
          renderGroupModal();
          toast("Channel updated.");
        } catch (error) {
          $("group-error").textContent = error.message;
        }
      });
      actions.appendChild(save);

      const permissions = make("button", "ghost-btn small", "Permissions");
      permissions.type = "button";
      permissions.addEventListener("click", () =>
        openPermissionsModal(channel.id)
      );
      actions.appendChild(permissions);

      if (group.channels.length > 1) {
        const remove = make("button", "ghost-btn small", "Delete");
        remove.type = "button";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete the channel "#${channel.name}"?`)) {
            return;
          }
          try {
            const data = await api(
              `/api/groups/${group.id}/channels/${channel.id}`,
              { method: "DELETE" }
            );
            applyGroupUpdate(data.group);
            renderGroupModal();
            toast("Channel deleted.");
          } catch (error) {
            $("group-error").textContent = error.message;
          }
        });
        actions.appendChild(remove);
      }
      card.appendChild(actions);
    }

    list.appendChild(card);
  }
  body.appendChild(list);

  if (!group.canManageChannels) return;

  const form = make("div", "group-form");
  const input = make("input");
  input.type = "text";
  input.maxLength = 40;
  input.placeholder = "New channel name";
  const description = make("input");
  description.type = "text";
  description.maxLength = 300;
  description.placeholder = "Description";
  const kind = make("select", "role-select");
  for (const value of ["text", "announcement"]) {
    const option = make("option", "", value === "text" ? "Text" : "Announcement");
    option.value = value;
    kind.appendChild(option);
  }
  const add = make("button", "primary-btn small", "Create channel");
  add.type = "button";
  add.addEventListener("click", async () => {
    if (!input.value.trim()) return;
    try {
      const data = await api(`/api/groups/${group.id}/channels`, {
        method: "POST",
        body: {
          name: input.value.trim(),
          description: description.value.trim(),
          kind: kind.value
        }
      });
      applyGroupUpdate(data.group);
      renderGroupModal();
      toast("Channel created.");
    } catch (error) {
      $("group-error").textContent = error.message;
    }
  });
  form.append(input, description, kind, add);
  body.appendChild(make("h3", "group-section-title", "Create channel"));
  body.appendChild(form);
}

function openPermissionsModal(channelId) {
  const group = state.activeGroup;
  const channel = group?.channels.find((item) => item.id === channelId);
  if (!channel || !channel.overrides) return;
  state.permissionsChannelId = channelId;
  $("permissions-title").textContent = `Permissions · #${channel.name}`;
  $("permissions-error").textContent = "";
  renderPermissionsMatrix(channel);
  showModal("permissions-modal");
}

function renderPermissionsMatrix(channel) {
  const group = state.activeGroup;
  const body = $("permissions-body");
  body.replaceChildren();

  const table = make("table", "permission-table");
  const head = make("thead");
  const headRow = make("tr");
  headRow.appendChild(make("th", "", "Applies to"));
  for (const permission of CHANNEL_PERMISSIONS) {
    headRow.appendChild(make("th", "", PERMISSION_LABELS[permission]));
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const tbody = make("tbody");

  const addRow = (label, roleId, userId) => {
    const row = make("tr");
    row.dataset.roleId = roleId ? String(roleId) : "";
    row.dataset.userId = userId ? String(userId) : "";
    row.appendChild(make("td", "permission-target", label));

    const override = channel.overrides.find(
      (item) =>
        (roleId && item.roleId === roleId) ||
        (userId && item.userId === userId)
    );

    for (const permission of CHANNEL_PERMISSIONS) {
      const cell = make("td");
      const select = make("select", "permission-select");
      for (const [value, text] of [
        ["inherit", "Inherit"],
        ["allow", "Allow"],
        ["deny", "Deny"]
      ]) {
        const option = make("option", "", text);
        option.value = value;
        select.appendChild(option);
      }
      if (override && override.allow.includes(permission)) {
        select.value = "allow";
      } else if (override && override.deny.includes(permission)) {
        select.value = "deny";
      }
      cell.appendChild(select);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  };

  for (const role of group.roles) {
    addRow(`Role: ${role.name}`, role.id, null);
  }
  for (const member of group.members) {
    if (member.isOwner) continue;
    addRow(`User: ${member.username}`, null, member.id);
  }

  table.appendChild(tbody);
  body.appendChild(table);
  body.appendChild(
    make(
      "p",
      "muted",
      "Deny wins over allow. The owner always has full access."
    )
  );
}

async function saveChannelPermissions() {
  const group = state.activeGroup;
  const channelId = state.permissionsChannelId;
  const channel = group?.channels.find((item) => item.id === channelId);
  if (!group || !channel) return;

  const overrides = [];
  for (const row of $("permissions-body").querySelectorAll("tbody tr")) {
    const roleId = row.dataset.roleId ? Number(row.dataset.roleId) : null;
    const userId = row.dataset.userId ? Number(row.dataset.userId) : null;
    const allow = [];
    const deny = [];
    const selects = row.querySelectorAll(".permission-select");
    selects.forEach((select, index) => {
      const permission = CHANNEL_PERMISSIONS[index];
      if (select.value === "allow") allow.push(permission);
      if (select.value === "deny") deny.push(permission);
    });
    if (allow.length || deny.length) {
      overrides.push({ roleId, userId, allow, deny });
    }
  }

  try {
    const data = await api(
      `/api/groups/${group.id}/channels/${channelId}/permissions`,
      { method: "PUT", body: { overrides } }
    );
    hideModal("permissions-modal");
    applyGroupUpdate(data.group);
    renderGroupModal();
    toast("Channel permissions updated.");
  } catch (error) {
    $("permissions-error").textContent = error.message;
  }
}

function renderUserBlockButton(user) {
  const button = $("user-block");
  if (!button || !user) return;
  const blocked = Boolean(
    user.blockedByMe || state.blockedUsers.has(user.id)
  );
  button.textContent = blocked ? "Unblock user" : "Block user";
}

async function handleBlockUpdate(data) {
  const by = data.by;
  if (!by || !by.id) return;
  const blocked = Boolean(data.blocked);
  if (state.activeUser && state.activeUser.id === by.id) {
    state.activeUser = { ...state.activeUser, blockedMe: blocked };
    state.blockStatus = { ...state.blockStatus, blockedMe: blocked };
    renderChatHeader();
    updateComposerState();
  }
  if (state.userModal && state.userModal.id === by.id) {
    state.userModal = { ...state.userModal, blockedMe: blocked };
    renderUserBlockButton(state.userModal);
  }
  await loadChats();
  toast(
    blocked
      ? `@${by.username} blocked you.`
      : `@${by.username} unblocked you.`
  );
}

async function setUserBlocked(user, blocked) {
  if (!user) return;
  try {
    const data = await api(
      `/api/users/${encodeURIComponent(user.username)}/block`,
      { method: blocked ? "POST" : "DELETE" }
    );
    const updated = { ...user, ...data.user };
    if (blocked) {
      state.blockedUsers.add(updated.id);
    } else {
      state.blockedUsers.delete(updated.id);
    }
    state.chats = state.chats.map((chat) =>
      chat.user.id === updated.id
        ? { ...chat, user: { ...chat.user, ...data.user } }
        : chat
    );
    if (state.userModal && state.userModal.id === updated.id) {
      state.userModal = updated;
      renderUserBlockButton(updated);
    }
    if (state.activeUser && state.activeUser.id === updated.id) {
      state.activeUser = updated;
      state.blockStatus = {
        blockedByMe: Boolean(updated.blockedByMe),
        blockedMe: Boolean(updated.blockedMe)
      };
      if (
        blocked &&
        state.call &&
        state.call.remoteUser &&
        state.call.remoteUser.id === updated.id
      ) {
        finishCall({ notify: false, reason: "User blocked." });
      }
      renderChatHeader();
      updateComposerState();
    }
    renderChats().catch(() => {});
    toast(blocked ? `Blocked @${updated.username}.` : `Unblocked @${updated.username}.`);
  } catch (error) {
    toast(error.message, true);
  }
}

function openUserModal(user) {
  if (!user) return;
  state.userModal = user;

  $("user-name").textContent = user.username;
  $("user-handle").textContent = user.number
    ? `@${user.username} · ${user.number}`
    : `@${user.username}`;
  setAvatar($("user-avatar"), user);
  setBanner($("user-banner"), user.banner);

  const pronouns = $("user-pronouns");
  pronouns.textContent = user.pronouns || "";
  pronouns.classList.toggle("hidden", !user.pronouns);

  const status = $("user-status");
  status.textContent = user.status || "";
  status.classList.toggle("hidden", !user.status);

  $("user-bio").textContent =
    user.bio || "This user has not written a bio yet.";

  const links = $("user-links");
  links.replaceChildren();

  if (Array.isArray(user.links) && user.links.length) {
    for (const link of user.links) {
      const anchor = document.createElement("a");
      anchor.className = "link-pill";
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = link.label;
      links.appendChild(anchor);
    }
    links.classList.remove("hidden");
  } else {
    links.classList.add("hidden");
  }

  renderUserBlockButton(user);
  showModal("user-modal");
}

function openActiveUserModal() {
  if (state.activeUser) openUserModal(state.activeUser);
}

function startPolling() {
  stopPolling();
  state.pollChats = setInterval(() => {
    if (document.hidden || !state.token) return;
    loadChats().catch(() => {});
  }, 5000);
  state.pollMessages = setInterval(() => {
    if (document.hidden || !state.token) return;
    if (state.activeView === "group") {
      loadGroupMessages(false).catch(() => {});
    } else if (state.activeUsername) {
      loadMessages(false).catch(() => {});
    }
  }, 2500);
}

function stopPolling() {
  if (state.pollChats) clearInterval(state.pollChats);
  if (state.pollMessages) clearInterval(state.pollMessages);
  state.pollChats = null;
  state.pollMessages = null;
}

async function logout() {
  try {
    if (state.token) {
      await api("/api/logout", { method: "POST", skipAuthHandler: true });
    }
  } catch {
    // The local session is cleared regardless.
  } finally {
    clearSession();
    setAuthMode("login");
    toast("You have logged out.");
  }
}

function init() {
  initSound();

  $("auth-form").addEventListener("submit", submitAuth);
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setAuthMode(tab.dataset.mode));
  });

  $("logout-btn").addEventListener("click", logout);
  $("edit-profile-btn").addEventListener("click", openProfileEditor);
  $("new-group-btn").addEventListener("click", openNewGroupModal);
  $("new-group-close").addEventListener("click", () =>
    hideModal("new-group-modal")
  );
  $("new-group-cancel").addEventListener("click", () =>
    hideModal("new-group-modal")
  );
  $("new-group-create").addEventListener("click", createGroup);
  $("new-group-visibility").addEventListener("change", syncNewGroupCodeField);
  for (const id of ["new-group-name", "new-group-code"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        createGroup();
      }
    });
  }

  $("group-close").addEventListener("click", () => hideModal("group-modal"));
  document.querySelectorAll("#group-tabs .modal-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.groupModalTab = tab.dataset.tab;
      $("group-error").textContent = "";
      renderGroupModal();
    });
  });
  $("topics-close").addEventListener("click", () => hideModal("topics-modal"));
  $("topics-done").addEventListener("click", () => hideModal("topics-modal"));
  $("permissions-close").addEventListener("click", () =>
    hideModal("permissions-modal")
  );
  $("permissions-cancel").addEventListener("click", () =>
    hideModal("permissions-modal")
  );
  $("permissions-save").addEventListener("click", saveChannelPermissions);

  $("profile-close").addEventListener("click", () =>
    hideModal("profile-modal")
  );
  $("profile-cancel").addEventListener("click", () =>
    hideModal("profile-modal")
  );
  $("profile-save").addEventListener("click", saveProfile);
  $("add-link").addEventListener("click", () => {
    const container = $("links-editor");
    const hint = container.querySelector(".links-empty");
    if (hint) hint.remove();
    const row = linkRow();
    container.appendChild(row);
    row.querySelector(".link-label").focus();
  });

  $("avatar-btn").addEventListener("click", () => $("avatar-file").click());
  $("edit-banner").addEventListener("click", () => $("banner-file").click());
  $("attach-btn").addEventListener("click", () => $("attachment-file").click());
  $("mic-btn").addEventListener("click", toggleRecording);

  $("attachment-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      setPendingAttachment(await prepareAttachment(file));
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("group-avatar-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file || !state.activeGroup) return;
    try {
      const avatar = await handleImageFile(file, 400, 400);
      const data = await api(`/api/groups/${state.activeGroup.id}`, {
        method: "PUT",
        body: { avatar }
      });
      applyGroupUpdate(data.group);
      renderGroupModal();
      toast("Group photo updated.");
    } catch (error) {
      $("group-error").textContent = error.message;
    }
  });

  $("avatar-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      state.profileAvatar = await handleImageFile(file, 400, 400);
      setAvatar($("edit-avatar"), {
        username: state.me.username,
        avatar: state.profileAvatar
      });
      $("profile-error").textContent = "";
    } catch (error) {
      $("profile-error").textContent = error.message;
    }
  });

  $("banner-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      state.profileBanner = await handleImageFile(file, 1280, 480);
      setBanner($("edit-banner"), state.profileBanner);
      $("profile-error").textContent = "";
    } catch (error) {
      $("profile-error").textContent = error.message;
    }
  });

  $("composer").addEventListener("submit", sendMessage);
  $("message-input").addEventListener("input", autoGrow);
  $("message-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("back-btn").addEventListener("click", closeConversation);
  $("close-chat-btn").addEventListener("click", closeConversation);
  $("reply-preview-close").addEventListener("click", clearReply);
  $("lightbox-close").addEventListener("click", closeImageLightbox);
  $("image-lightbox").addEventListener("mousedown", (event) => {
    if (event.target === $("image-lightbox")) closeImageLightbox();
  });

  const openActiveInfo = () => {
    if (state.activeView === "group") {
      openGroupSettings();
    } else {
      openActiveUserModal();
    }
  };
  $("chat-person").addEventListener("click", openActiveInfo);
  $("chat-info-btn").addEventListener("click", openActiveInfo);
  $("call-btn").addEventListener("click", () => {
    startCall().catch(() => {});
  });
  $("call-accept").addEventListener("click", () => {
    acceptIncomingCall().catch(() => {});
  });
  $("call-decline").addEventListener("click", declineIncomingCall);
  $("call-end").addEventListener("click", () =>
    finishCall({ reason: "Call ended." })
  );
  $("call-mic").addEventListener("click", toggleCallMic);
  $("call-speaker").addEventListener("click", toggleCallSpeaker);
  $("call-screen").addEventListener("click", () => {
    toggleCallScreen().catch(() => {});
  });
  $("call-settings-btn").addEventListener("click", toggleCallSettings);
  $("call-volume").addEventListener("input", (event) => {
    setCallVolume(event.target.value);
  });
  $("call-fullscreen").addEventListener("click", () => {
    toggleCallFullscreen().catch(() => {});
  });
  $("call-remote-video").addEventListener("dblclick", () => {
    toggleCallFullscreen().catch(() => {});
  });
  document.addEventListener("fullscreenchange", updateCallFullscreenButton);
  document.addEventListener(
    "webkitfullscreenchange",
    updateCallFullscreenButton
  );
  $("call-fps").addEventListener("change", () => {
    applyCallScreenSettings().catch(() => {});
  });
  $("call-resolution").addEventListener("change", () => {
    applyCallScreenSettings().catch(() => {});
  });
  $("user-close").addEventListener("click", () => {
    hideModal("user-modal");
  });

  $("user-message").addEventListener("click", () => {
    const user = state.userModal;
    hideModal("user-modal");
    if (user) openChat(user.username);
  });

  $("user-block").addEventListener("click", () => {
    const user = state.userModal;
    if (!user) return;
    const blocked = Boolean(
      user.blockedByMe || state.blockedUsers.has(user.id)
    );
    setUserBlocked(user, !blocked).catch(() => {});
  });

  $("blocked-notice-action").addEventListener("click", () => {
    if (!state.activeUser) return;
    setUserBlocked(state.activeUser, false).catch(() => {});
  });

  let searchTimer = null;
  $("search-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = $("search-input").value.trim();
    if (!query && !state.directoryOpen) {
      hideSearch();
      return;
    }
    searchTimer = setTimeout(() => {
      performSearch(query, !query);
    }, 220);
  });

  $("new-chat-btn").addEventListener("click", () => {
    $("search-input").focus();
    performSearch($("search-input").value.trim(), true);
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("mousedown", (event) => {
      if (event.target === modal) hideModal(modal.id);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("image-lightbox").classList.contains("hidden")) {
      closeImageLightbox();
      return;
    }
    const openModal = document.querySelector(".modal:not(.hidden)");
    if (openModal) {
      hideModal(openModal.id);
      return;
    }
    if (state.replyTo) {
      clearReply();
      return;
    }
    closeConversation();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.token) return;
    connectSocket();
    loadChats().catch(() => {});
    if (state.activeView === "group") {
      loadGroupMessages(false).catch(() => {});
    } else if (state.activeUsername) {
      loadMessages(false).catch(() => {});
    }
  });

  window.addEventListener("pagehide", () => {
    if (state.call) finishCall({ notify: true });
  });

  updateComposerState();
  renderAttachmentPreview();

  restoreSession().then((restored) => {
    if (restored) {
      enterApp();
    } else {
      setAuthMode("login");
      $("auth-username").focus();
    }
  });
}

async function deleteMessage(message) {
  if (!canDeleteMessage(message)) return;
  if (!window.confirm("Delete this message for everyone?")) return;

  const isGroup = state.activeView === "group";
  const groupId = state.activeGroupId;
  const channelId = state.activeChannelId;
  const topicId = state.activeTopicId;

  try {
    if (isGroup) {
      await api(
        `/api/groups/${groupId}/channels/${channelId}/topics/${topicId}/messages/${message.id}`,
        { method: "DELETE" }
      );
    } else {
      await api(`/api/messages/${message.id}`, { method: "DELETE" });
    }
    removeMessageLocally(message.id);
    loadChats().catch(() => {});
    toast("Message deleted.");
  } catch (error) {
    toast(error.message, true);
  }
}

init();
