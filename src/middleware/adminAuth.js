const config = require("../../config");

/**
 * Middleware to authenticate admin users
 * Checks if the user is an admin based on username or user ID
 */
function requireAdmin() {
  return async (ctx, next) => {
    try {
      const userId = ctx.from?.id;
      const username = ctx.from?.username;

      const adminIds = config.getAllAdminIds();
      if (adminIds.some((adminId) => userId === parseInt(adminId))) {
        return next();
      }

      const adminUsernames = config.getAllAdminUsernames();
      if (adminUsernames.includes(username)) {
        return next();
      }

      await ctx.reply("❌ Access denied. Admin privileges required.");
    } catch (error) {
      console.error("Error in admin auth middleware:", error);
      await ctx.reply("❌ Authentication error. Please try again.");
    }
  };
}

/**
 * Check if user is admin without sending response
 */
function isAdmin(ctx) {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  const adminIds = config.getAllAdminIds();
  if (adminIds.some((adminId) => userId === parseInt(adminId))) {
    return true;
  }

  const adminUsernames = config.getAllAdminUsernames();
  if (adminUsernames.includes(username)) {
    return true;
  }

  return false;
}

module.exports = {
  requireAdmin,
  isAdmin,
};
