/**
 * Look up the most recent APPROVED leave for an employee, excluding a
 * specific record (usually the one currently being applied for).
 *
 * Returns { type, date, status } or null if the employee has no prior
 * approved leave on record.
 *
 * Used when composing leave-request emails so managers can see context
 * ("their last leave was Casual Leave on 10-Apr") while deciding.
 */
async function getLastApprovedLeave(AttendanceRecord, empId, excludeRecordId = null) {
  if (!empId) return null;
  const query = {
    emp_id:       empId,
    leave_type:   { $ne: null },
    leave_status: 'Approved',
  };
  if (excludeRecordId) query._id = { $ne: excludeRecordId };

  try {
    const last = await AttendanceRecord
      .findOne(query)
      .sort({ date: -1 })
      .select('leave_type date leave_status')
      .lean();

    if (!last) return null;
    return {
      type:   last.leave_type,
      date:   last.date,
      status: last.leave_status,
    };
  } catch (err) {
    console.error('[getLastApprovedLeave]', err.message);
    return null;
  }
}

module.exports = { getLastApprovedLeave };
