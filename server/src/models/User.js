const { Schema, model } = require('mongoose');

const ROLES = ['user', 'organiser', 'admin'];
const STATUSES = ['active', 'blocked'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: 'user' },
    status: { type: String, enum: STATUSES, default: 'active' },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

module.exports = model('User', userSchema);
module.exports.ROLES = ROLES;
