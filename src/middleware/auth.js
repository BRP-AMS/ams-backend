const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { User, RevokedToken } = require('../models/database');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  const token     = authHeader.substring(7);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    // Check if token is revoked (token_hash is stored as _id)
    const revoked = await RevokedToken.findById(tokenHash).lean();
    if (revoked) {
      return res.status(401).json({ success: false, message: 'Token has been revoked' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User
      .findById(decoded.id)
      .select('_id emp_id name email role department manager_id phone is_active')
      .lean();

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    req.user  = { ...user, id: user._id };
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  const userRole = req.user?.role;
  if (userRole === 'super_admin') return next();
  if (!roles.includes(userRole)) {
    console.warn(`[Auth] Forbidden: User ${req.user?._id} (${userRole}) attempted access to restricted route. Required: ${roles.join(', ')}`);
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

module.exports = { authenticate, authorize };
