const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;

    // Check if error is retryable
    const isNetworkError =
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "EAI_AGAIN" ||
      (error.message &&
        (error.message.includes("timeout") ||
          error.message.includes("network")));

    const isTelegramRetryable =
      error?.response?.error_code === 502 ||
      error?.response?.error_code === 429 ||
      (error.message && error.message.includes("Bad Gateway")) ||
      (error.message && error.message.includes("Too Many Requests"));

    if (!isNetworkError && !isTelegramRetryable) throw error;

    let waitTime = delay;
    // Respect Telegram's retry_after parameter
    if (error?.response?.parameters?.retry_after) {
      waitTime = (error.response.parameters.retry_after + 2) * 1000;
    }

    await wait(waitTime);
    return withRetry(fn, retries - 1, delay * 2);
  }
}

module.exports = withRetry;
