"use strict";

const SESSION_KEY = "talkie.session.v1";
const PENDING_INVITE_KEY = "talkie.pendingInvite";
const code = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");

const avatar = document.getElementById("invite-avatar");
const name = document.getElementById("invite-name");
const description = document.getElementById("invite-description");
const meta = document.getElementById("invite-meta");
const error = document.getElementById("invite-error");
const join = document.getElementById("invite-join");

function initials(value) {
  const text = String(value || "?").trim();
  return text ? text.slice(0, 2).toUpperCase() : "?";
}

function readToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return saved && saved.token ? saved.token : null;
  } catch {
    return null;
  }
}

function renderGroup(group) {
  document.title = `${group.name} - Talkie invite`;
  name.textContent = group.name;
  description.textContent =
    group.description || "This group has not added a description yet.";
  meta.textContent = `${group.memberCount} member${
    group.memberCount === 1 ? "" : "s"
  } - Public group`;
  avatar.replaceChildren();
  if (group.avatar) {
    const image = document.createElement("img");
    image.src = group.avatar;
    image.alt = "";
    avatar.appendChild(image);
    avatar.style.background = "";
  } else {
    avatar.textContent = initials(group.name);
    avatar.style.background =
      "linear-gradient(135deg, #3390ec, #1f5f9e)";
  }
}

async function loadInvite() {
  if (!code) {
    error.textContent = "This invite link is incomplete.";
    return;
  }
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(code)}`, {
      cache: "no-store"
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      error.textContent =
        (data && data.error) || "This invite is invalid or the group is private.";
      name.textContent = "Invite unavailable";
      return;
    }
    renderGroup(data.invite.group);
    join.disabled = false;
    join.dataset.groupId = String(data.invite.group.id);
    join.textContent = readToken() ? "Join group" : "Log in to join";
  } catch {
    error.textContent = "Could not load this invite. Try again.";
  }
}

async function joinGroup() {
  const token = readToken();
  if (!token) {
    sessionStorage.setItem(PENDING_INVITE_KEY, code);
    location.href = `/?invite=${encodeURIComponent(code)}`;
    return;
  }
  join.disabled = true;
  join.textContent = "Joining...";
  error.textContent = "";
  try {
    const response = await fetch(
      `/api/invites/${encodeURIComponent(code)}/join`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.setItem(PENDING_INVITE_KEY, code);
      location.href = `/?invite=${encodeURIComponent(code)}`;
      return;
    }
    if (!response.ok) {
      throw new Error((data && data.error) || "Could not join this group.");
    }
    location.href = `/?group=${encodeURIComponent(data.group.id)}`;
  } catch (joinError) {
    error.textContent = joinError.message;
    join.disabled = false;
    join.textContent = "Join group";
  }
}

join.addEventListener("click", joinGroup);
loadInvite();
