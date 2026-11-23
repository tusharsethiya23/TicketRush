const { Router } = require('express');
const { authenticate } = require('../../middleware/auth');

const router = Router();

/** The signed-in account; the React app uses it after a silent refresh. */
router.get('/', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
