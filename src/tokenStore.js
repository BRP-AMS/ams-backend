// Shared in-memory token stores
// Centralised here to avoid circular dependencies between auth.js and users.js

const resetTokens  = new Map(); // token → { userId, expiresAt }  (forgot-password + invite)

module.exports = { resetTokens };
