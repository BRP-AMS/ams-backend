// Face verification disabled — TensorFlow removed to reduce memory usage.
// All check-ins are auto-verified. Re-enable when ready to add client-side verification.

const CONFIDENCE_THRESHOLD = 100;
const RETAKE_THRESHOLD     = 100;
const MATCH_THRESHOLD      = 0;
const BLOCK_CONFIDENCE_MIN = 0;

async function verifyFace() {
  return { match: true, confidence: 100, reason: 'Face verification disabled.' };
}

module.exports = { verifyFace, MATCH_THRESHOLD, CONFIDENCE_THRESHOLD, RETAKE_THRESHOLD, BLOCK_CONFIDENCE_MIN };
