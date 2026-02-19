const clampRiskScore = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.round(parsed), 100);
};

export const generateRiskScore = (features) => {
  let score = 0;
  const triggeredSignals = [];

  if (Number(features.withdrawalVelocity) > 0.5) {
    score += 30;
    triggeredSignals.push("WITHDRAWAL_VELOCITY_HIGH");
  }

  if (
    features.avgTimeToWithdrawal !== null &&
    features.avgTimeToWithdrawal !== undefined &&
    Number(features.avgTimeToWithdrawal) < 30
  ) {
    score += 25;
    triggeredSignals.push("FAST_WITHDRAWAL_AFTER_RELEASE");
  }

  if (Number(features.disputeRatio) > 0.2) {
    score += 20;
    triggeredSignals.push("DISPUTE_RATIO_HIGH");
  }

  if (Number(features.accountAgeScore) === 30) {
    score += 30;
    triggeredSignals.push("NEW_ACCOUNT");
  }

  return {
    riskScore: clampRiskScore(score),
    triggeredSignals,
  };
};

export const BEHAVIOURAL_RISK_THRESHOLD = 70;
