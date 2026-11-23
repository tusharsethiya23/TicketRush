const { Schema, model } = require('mongoose');

const KEY_TTL_SECONDS = 24 * 60 * 60;

/** Stored result of a confirm request, replayed for repeats of the same key (FR-11). */
const idempotencyKeySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true, maxlength: 255 },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ['processing', 'completed'], default: 'processing' },
  responseStatus: { type: Number },
  responseBody: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: KEY_TTL_SECONDS });

module.exports = model('IdempotencyKey', idempotencyKeySchema);
