const { Markup } = require("telegraf");

/**
 * Calculator Handler
 * Listens for simple mathematical expressions and returns the result.
 * Pattern: Starts with a number, contains arithmetic operators, ends with number.
 * Supported: +, -, *, /, (, )
 */
module.exports = async (ctx, next) => {
  try {
    if (!ctx.message || !ctx.message.text) {
      return next();
    }

    const text = ctx.message.text.trim();

    // Ignore commands
    if (text.startsWith("/")) {
      return next();
    }

    // Strict validation: Allow only numbers, operators, parens, spaces, dots
    // Must contain at least one operator to distinguish from plain numbers (e.g. phone numbers or addresses)
    // Regex explanation:
    // ^                           Start
    // [0-9\.\s\(\)]*              Optional leading numbers/parens/space
    // [\+\-\*\/]                  MUST have at least one operator
    // [0-9\.\s\(\)\+\-\*\/]*      Rest can be mixed
    // $                           End
    const isValidMathChars = /^[0-9\.\s\+\-\*\/\(\)]+$/.test(text);
    const hasOperator = /[\+\-\*\/]/.test(text);
    const hasNumber = /[0-9]/.test(text);

    if (!isValidMathChars || !hasOperator || !hasNumber) {
      return next();
    }

    // Additional check: valid math expression usually implies specific structure
    // We try to evaluate it. If it fails or returns NaN, we allow `next()` (it might be random text)
    // We use Function constructor for "safer" eval since we validated allowed chars strictly.

    let result;
    try {
      // Create a function creating the result
      const compute = new Function(`return (${text})`);
      result = compute();
    } catch (e) {
      // Syntax error (e.g. "10 + * 20"), ignore and pass to next
      return next();
    }

    // Check if result is valid number
    if (!Number.isFinite(result) || Number.isNaN(result)) {
      return next();
    }

    const formattedResult = Number.isInteger(result)
      ? result
      : parseFloat(result.toFixed(8));

    await ctx.reply(`🔢 <b>Result:</b> ${formattedResult}`, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message.message_id,
    });

    // Stop propagation since we handled it
    return;
  } catch (error) {
    console.error("Calculator Error:", error);
    return next();
  }
};
