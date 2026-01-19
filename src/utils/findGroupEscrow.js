const Escrow = require("../models/Escrow");
const GroupPool = require("../models/GroupPool");

function buildStatusQuery(statusCondition) {
  if (!statusCondition) return {};
  if (Array.isArray(statusCondition)) {
    return { status: { $in: statusCondition } };
  }
  if (typeof statusCondition === "object" && statusCondition !== null) {
    return { status: statusCondition };
  }
  return { status: statusCondition };
}

async function findGroupEscrow(groupId, statusCondition, extraFilters = {}) {
  const groupIdStr = String(groupId);
  const statusQuery = buildStatusQuery(statusCondition);
  const baseQuery = { ...extraFilters };

  let assignedEscrowId = null;
  try {
    const group = await GroupPool.findOne(
      { groupId: groupIdStr },
      { assignedEscrowId: 1 }
    );
    assignedEscrowId = group?.assignedEscrowId || null;
  } catch (groupErr) {
    console.error("Error loading group pool entry:", groupErr);
  }

  if (assignedEscrowId) {
    const queryById = {
      escrowId: assignedEscrowId,
      ...statusQuery,
      ...baseQuery,
    };
    const byId = await Escrow.findOne(queryById);
    if (byId) {
      return byId;
    }
  }

  return Escrow.findOne({
    groupId: groupIdStr,
    ...statusQuery,
    ...baseQuery,
  }).sort({ _id: -1 });
}

module.exports = findGroupEscrow;
