/**
 * Safely answer a callback query, handling expired queries gracefully
 * @param {Object} ctx - The Telegraf context
 * @param {string} text - The text to display in the alert (optional)
 * @param {boolean} showAlert - Whether to show as an alert (optional)
 */
async function safeAnswerCbQuery(ctx, text = "", showAlert = false) {
  try {
    if (!ctx.callbackQuery) return;
    await ctx.answerCbQuery(text, { show_alert: showAlert });
  } catch (error) {
    if (
      error.description?.includes("query is too old") ||
      error.description?.includes("query ID is invalid") ||
      error.response?.error_code === 400
    ) {
      return;
    }
    console.error("Error answering callback query:", error);
  }
}

module.exports = {
  safeAnswerCbQuery,
};
