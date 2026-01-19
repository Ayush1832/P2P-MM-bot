// Activity monitoring fully removed. Stub kept to satisfy imports.

class ActivityMonitoringService {
  setBotInstance() {}
  startMonitoring() {}
  stopMonitoring() {}
  getThresholds() {
    return { inactivityMs: 0, warningDelayMs: 0 };
  }
  trackActivity() {}
  markTradeCompleted() {}
  syncEscrowStatus() {}
  checkForCleanup() {}
  sendInactivityWarning() {
    return false;
  }
  handleInactiveGroup() {}
  handleCompletedGroup() {}
  sendCancellationMessage() {}
  sendCompletionMessage() {}
  removeUsersFromGroup() {}
  releaseGroupToPool() {}
  getActivityStats() {
    return null;
  }
  debugActivityTracking() {
    return null;
  }
}

module.exports = new ActivityMonitoringService();
