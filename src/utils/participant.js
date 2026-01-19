function normalizeId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function escapeHtml(text = "") {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getParticipants(escrow) {
  if (!escrow) {
    return [];
  }

  const usernames = Array.isArray(escrow.allowedUsernames)
    ? escrow.allowedUsernames
    : [];
  const ids = Array.isArray(escrow.allowedUserIds) ? escrow.allowedUserIds : [];
  const maxLength = Math.max(usernames.length, ids.length);

  const participants = [];
  for (let i = 0; i < maxLength; i++) {
    const username = usernames[i] || null;
    const id = normalizeId(ids[i]);
    participants.push({ username, id });
  }

  return participants;
}

function maskValue(value = "") {
  const stripped = value.replace(/^@/, "");
  if (!stripped) {
    return "*";
  }
  if (stripped.length === 1) {
    return `${stripped[0]}*`;
  }
  if (stripped.length === 2) {
    return `${stripped[0]}*`;
  }
  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  const middle = "*".repeat(Math.min(6, Math.max(1, stripped.length - 2)));
  return `${first}${middle}${last}`;
}

function formatParticipant(
  participant,
  fallbackLabel = "Unknown",
  options = {}
) {
  const { html = false, mask = false } = options;
  const baseLabel = fallbackLabel || "User";

  if (!participant) {
    const display = mask ? maskValue(baseLabel) : baseLabel;
    return html ? escapeHtml(display) : display;
  }

  const hasId = participant.id !== null && participant.id !== undefined;
  let displayText;

  if (participant.username) {
    const usernameLabel = `@${participant.username}`;
    displayText = mask ? `@${maskValue(participant.username)}` : usernameLabel;
  } else {
    if (hasId) {
      displayText = `User ${participant.id}`;
    } else {
      const fallback = mask ? maskValue(baseLabel) : baseLabel;
      displayText = fallback;
    }
  }

  if (html && hasId && !mask) {
    return `<a href="tg://user?id=${participant.id}">${escapeHtml(
      displayText
    )}</a>`;
  }

  if (html) {
    return escapeHtml(displayText);
  }

  if (hasId && !participant.username && !mask) {
    return `${displayText} (ID ${participant.id})`;
  }

  return displayText;
}

function formatParticipantByIndex(escrow, index, fallbackLabel, options) {
  const participants = getParticipants(escrow);
  return formatParticipant(participants[index], fallbackLabel, options);
}

function formatParticipantById(escrow, id, fallbackLabel, options) {
  if (id === null || id === undefined) {
    return formatParticipant(null, fallbackLabel, options);
  }
  const participants = getParticipants(escrow);
  const targetId = Number(id);
  const match = participants.find(
    (p) => p.id !== null && Number(p.id) === targetId
  );
  return formatParticipant(match, fallbackLabel, options);
}

module.exports = {
  getParticipants,
  formatParticipant,
  formatParticipantByIndex,
  formatParticipantById,
  normalizeId,
};
