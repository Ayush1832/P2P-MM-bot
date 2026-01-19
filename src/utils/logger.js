const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function getISTTimestamp() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Override console methods
console.log = (...args) => {
  originalLog(`[${getISTTimestamp()} IST]`, ...args);
};

console.error = (...args) => {
  originalError(`[${getISTTimestamp()} IST]`, ...args);
};

console.warn = (...args) => {
  originalWarn(`[${getISTTimestamp()} IST]`, ...args);
};

console.info = (...args) => {
  originalInfo(`[${getISTTimestamp()} IST]`, ...args);
};

module.exports = {};
